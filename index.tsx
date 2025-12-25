
import { GoogleGenAI, Type } from "@google/genai";
import JSZip from "jszip";

// --- Types ---
interface XMLNode {
    name: string;
    attributes: Record<string, string>;
    content?: string;
    children: XMLNode[];
    processingInstructions: string[];
}

interface UniversalData {
    title: string;
    arrivalNumber?: string;
    postCode?: string;
    address?: string;
    companyName?: string;
    recipientName?: string;
    creationDate?: string;
    officeName?: string;
    officeInfo: Record<string, string>;
    headers: Record<string, string>;
    sections: {
        name: string;
        isTable: boolean;
        data: any[]; 
        headers?: string[];
    }[];
}

interface AppFile {
    name: string;
    fullPath: string;
    content: string;
    parsed?: XMLNode;
    analysis?: UniversalData;
    detectedXsl?: string;
    hasPdf?: boolean;
}

interface CaseEntry {
    folderPath: string;
    folderName: string;
    files: AppFile[];
    isOpen: boolean;
}

// --- App State ---
const state = {
    cases: [] as CaseEntry[],
    selectedCaseIdx: -1,
    selectedFileIdx: -1,
    viewMode: 'summary' as 'summary' | 'tree',
    showSettings: false,
    isLoading: false,
    loadingMsg: "",
    logs: [] as string[],
    rates: { health: 9.98, pension: 18.3, nursing: 1.60 }
};

const addLog = (msg: string) => {
    console.log(`[Viewer Log] ${msg}`);
    state.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (state.logs.length > 100) state.logs.shift();
};

// --- XML Utilities ---
const parseXML = (xmlString: string): XMLNode => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "text/xml");
    if (xmlDoc.getElementsByTagName("parsererror").length > 0) {
        const error = xmlDoc.getElementsByTagName("parsererror")[0].textContent;
        throw new Error(`XML Parse Error: ${error}`);
    }

    const pis: string[] = [];
    let child = xmlDoc.firstChild;
    while (child) {
        if (child.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
            pis.push((child as ProcessingInstruction).data);
        }
        child = child.nextSibling;
    }

    const traverse = (element: Element): XMLNode => {
        const attributes: Record<string, string> = {};
        for (let i = 0; i < element.attributes.length; i++) {
            const attr = element.attributes[i];
            attributes[attr.name] = attr.value;
        }
        const children: XMLNode[] = [];
        Array.from(element.childNodes).forEach(c => {
            if (c.nodeType === Node.ELEMENT_NODE) children.push(traverse(c as Element));
        });
        return { 
            name: element.tagName, 
            attributes, 
            content: element.children.length === 0 ? element.textContent?.trim() : undefined, 
            children,
            processingInstructions: [] 
        };
    };

    const rootElement = xmlDoc.documentElement;
    const root = traverse(rootElement);
    root.processingInstructions = pis;
    return root;
};

const extractUniversalData = (node: XMLNode): UniversalData => {
    const headers: Record<string, string> = {};
    const officeInfo: Record<string, string> = {};
    const sections: UniversalData['sections'] = [];
    
    let arrivalNumber = "", postCode = "", address = "", companyName = "", recipientName = "", creationDate = "", officeName = "";

    const processNode = (n: XMLNode, path: string = "") => {
        const name = n.name;
        const val = n.content || "";

        // Tag Mapping for e-Gov (T-series for Headers, S-series for Records)
        if (name === "T001" || name.includes("到達番号")) arrivalNumber = val || arrivalNumber;
        if (name === "T002" || name.includes("所在地") || name.includes("住所")) address = val || address;
        if (name === "T003" || name.includes("事業所名称") || name.includes("会社名")) companyName = val || companyName;
        if (name === "T004" || name.includes("代表者") || name.includes("氏名")) recipientName = val || recipientName;
        if (name === "T005" || name.includes("作成年月日") || name.includes("通知年月日")) creationDate = val || creationDate;
        if (name.includes("郵便番号")) postCode = val || postCode;
        if (name.includes("年金事務所名")) officeName = val || officeName;
        
        if (["事業所整理記号", "事業所番号", "OfficeID"].some(k => name.includes(k))) {
            officeInfo[name] = val;
        }

        if (n.children.length === 0) {
            if (val) headers[path + name] = val;
            return;
        }

        // List Detection: If a node has complex children, it's likely a table record container
        const hasComplexChildren = n.children.some(c => c.children.length > 0);
        const childNames = n.children.map(c => c.name);
        const uniqueChildNames = new Set(childNames);
        
        // If it looks like a repeating list (even if count is 1)
        if (hasComplexChildren && (n.children.length > 1 || (n.name.toLowerCase().includes("list") || n.name.toLowerCase().includes("array") || n.name.includes("情報") || n.name.includes("一覧")))) {
            const tableHeaders = new Set<string>();
            const rows = n.children.map(item => {
                const row: Record<string, string> = {};
                const flatten = (cn: XMLNode, prefix = "") => {
                    // Specific mapping for S-codes inside rows
                    let finalName = cn.name;
                    if (finalName === "S001") finalName = "整理番号";
                    if (finalName === "S002") finalName = "氏名";
                    if (finalName === "S003") finalName = "健康保険_標準報酬";
                    if (finalName === "S004") finalName = "厚生年金_標準報酬";
                    if (finalName === "S005") finalName = "適用年月";
                    if (finalName === "S006") finalName = "生年月日";

                    if (cn.children.length === 0) {
                        const key = prefix + finalName;
                        row[key] = cn.content || "";
                        tableHeaders.add(key);
                    } else cn.children.forEach(child => flatten(child, cn.name + "_"));
                };
                flatten(item);
                return row;
            });
            if (rows.length > 0) {
                sections.push({ name: n.name, isTable: true, headers: Array.from(tableHeaders), data: rows });
                return; // Don't descend further if we captured a table
            }
        }
        
        n.children.forEach(c => processNode(c, path + name + "_"));
    };

    processNode(node);
    
    let title = node.name;
    if (title.match(/Kokuho|S00|決定通知|S001|StandardRemuneration|HealthInsurance/)) {
        title = "健康保険・厚生年金保険 被保険者標準報酬決定通知書";
    }

    return { title, arrivalNumber, postCode, address, companyName, recipientName, creationDate, officeName, officeInfo, headers, sections };
};

const handleUpload = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const rawFiles = Array.from(input.files || []);
    if (rawFiles.length === 0) return;

    state.isLoading = true;
    state.loadingMsg = "ファイルを解析しています...";
    state.cases = [];
    state.logs = [];
    addLog(`${rawFiles.length} 個のアイテムを処理中...`);
    render();

    const caseMap = new Map<string, AppFile[]>();
    const pdfPaths = new Set<string>();

    const analyzeFile = (path: string, fileName: string, content: string) => {
        const parts = path.split('/');
        const dirName = parts.length > 1 ? parts[0] : "直接読み込み";

        if (fileName.toLowerCase().endsWith('.pdf')) {
            pdfPaths.add(path);
            return;
        }

        if (fileName.toLowerCase().endsWith('.xml')) {
            try {
                const parsed = parseXML(content);
                const analysis = extractUniversalData(parsed);
                
                const fileEntry: AppFile = {
                    name: fileName,
                    fullPath: path,
                    content,
                    parsed,
                    analysis
                };

                if (!caseMap.has(dirName)) caseMap.set(dirName, []);
                caseMap.get(dirName)!.push(fileEntry);
                addLog(`解析成功: ${fileName}`);
            } catch (err) {
                addLog(`解析失敗: ${fileName} - ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    };

    try {
        for (const f of rawFiles) {
            if (f.name.toLowerCase().endsWith('.zip')) {
                addLog(`ZIPファイル読み込み: ${f.name}`);
                const zip = new JSZip();
                const loadedZip = await zip.loadAsync(f);
                const zipFiles = Object.keys(loadedZip.files).filter(k => !loadedZip.files[k].dir);
                
                for (let i = 0; i < zipFiles.length; i++) {
                    const path = zipFiles[i];
                    const content = await loadedZip.files[path].async('string');
                    const baseName = path.split('/').pop() || path;
                    state.loadingMsg = `ZIP内解析中 (${i+1}/${zipFiles.length}): ${baseName}`;
                    render();
                    analyzeFile(path, baseName, content);
                }
            } else {
                const path = (f as any).webkitRelativePath || f.name;
                const content = await f.text();
                analyzeFile(path, f.name, content);
            }
        }

        const builtCases: CaseEntry[] = [];
        caseMap.forEach((files, folderName) => {
            files.forEach(f => {
                const base = f.fullPath.substring(0, f.fullPath.lastIndexOf('.'));
                f.hasPdf = Array.from(pdfPaths).some(p => p.startsWith(base));
            });
            builtCases.push({ folderPath: folderName, folderName: folderName, files: files, isOpen: true });
        });

        state.cases = builtCases;

        if (state.cases.length > 0) {
            state.selectedCaseIdx = 0;
            state.selectedFileIdx = 0;
            addLog(`完了: ${state.cases.length} 案件を表示します。`);
        } else {
            addLog("有効なXMLファイルが抽出されませんでした。ログを確認してください。");
        }
    } catch (err) {
        addLog(`重大なエラー: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        state.isLoading = false;
        render();
    }
};

const render = () => {
    const root = document.getElementById('root');
    if (!root) return;

    if (state.isLoading) {
        root.innerHTML = `
            <div class="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-white p-8">
                <div class="w-24 h-24 border-8 border-blue-500 border-t-transparent rounded-full animate-spin mb-10 shadow-2xl shadow-blue-500/20"></div>
                <h2 class="text-3xl font-black tracking-tighter mb-4">PROCESSING DATA...</h2>
                <div class="bg-white/5 border border-white/10 p-6 rounded-3xl max-w-lg w-full text-center">
                    <p class="text-blue-400 font-mono text-sm animate-pulse">${state.loadingMsg}</p>
                </div>
            </div>
        `;
        return;
    }

    if (state.cases.length === 0) {
        root.innerHTML = `
            <div class="min-h-screen flex items-center justify-center bg-slate-50 p-6">
                <div class="bg-white p-16 md:p-24 rounded-[4rem] shadow-2xl border border-slate-100 w-full max-w-3xl text-center">
                    <div class="bg-blue-600 w-32 h-32 rounded-[2.5rem] flex items-center justify-center mx-auto mb-16 text-white shadow-2xl rotate-3">
                        <i data-lucide="file-up" size="64"></i>
                    </div>
                    <h2 class="text-5xl font-black mb-8 text-slate-900 tracking-tighter">e-Gov Explorer</h2>
                    <p class="text-slate-500 mb-16 text-xl font-medium leading-relaxed max-w-md mx-auto">
                        ZIPファイル、またはフォルダを選択して<br/>通知書を読み込みます。
                    </p>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <label class="block py-10 px-10 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-[3rem] cursor-pointer transition-all active:scale-95 shadow-xl group">
                            <i data-lucide="folder-open" class="mx-auto mb-4 group-hover:scale-110 transition-transform"></i>
                            フォルダを選択
                            <input type="file" id="folderInput" class="hidden" webkitdirectory directory />
                        </label>
                        <label class="block py-10 px-10 bg-slate-900 hover:bg-black text-white font-black rounded-[3rem] cursor-pointer transition-all active:scale-95 shadow-xl group">
                            <i data-lucide="archive" class="mx-auto mb-4 group-hover:scale-110 transition-transform"></i>
                            ZIPを選択
                            <input type="file" id="zipInput" class="hidden" accept=".zip" />
                        </label>
                    </div>
                    ${state.logs.length > 0 ? `
                        <div class="mt-12 text-left bg-red-50 p-6 rounded-3xl border border-red-100">
                            <h4 class="text-xs font-black text-red-400 mb-2 uppercase tracking-widest">Errors / Logs</h4>
                            <div class="text-[10px] font-mono text-red-600 max-h-32 overflow-y-auto">${state.logs.join('<br>')}</div>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
        document.getElementById('folderInput')?.addEventListener('change', handleUpload);
        document.getElementById('zipInput')?.addEventListener('change', handleUpload);
        if ((window as any).lucide) (window as any).lucide.createIcons();
        return;
    }

    const currentCase = state.cases[state.selectedCaseIdx];
    const currentFile = currentCase?.files[state.selectedFileIdx];
    const data = currentFile?.analysis;

    root.innerHTML = `
        <div class="h-screen flex flex-col bg-slate-100 overflow-hidden">
            <header class="bg-white border-b px-12 py-6 flex items-center justify-between z-50">
                <div class="flex items-center gap-6">
                    <button id="resetBtn" class="bg-slate-100 p-4 rounded-2xl hover:bg-slate-200 transition-all active:scale-90 shadow-sm"><i data-lucide="home" size="20"></i></button>
                    <div>
                        <h1 class="text-2xl font-black text-slate-900 tracking-tighter">e-Gov Pro Explorer</h1>
                        <p class="text-[10px] font-bold text-blue-600 uppercase tracking-[0.2em] mt-1">Notification Data Engine</p>
                    </div>
                </div>
                <div class="flex gap-4">
                    <button id="toggleSettings" class="px-8 py-4 bg-slate-900 text-white rounded-2xl text-xs font-black shadow-lg active:scale-95 flex items-center gap-2">
                        <i data-lucide="calculator" size="14"></i> 料率設定
                    </button>
                </div>
            </header>

            <div class="flex-1 flex overflow-hidden">
                <aside class="w-[380px] bg-white border-r flex flex-col overflow-hidden shadow-inner">
                    <div class="p-8 border-b bg-slate-50/50">
                        <h2 class="text-[11px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><i data-lucide="layers" size="12"></i> Case Archive</h2>
                    </div>
                    <div class="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                        ${state.cases.map((c, cIdx) => `
                            <div class="case-group bg-slate-50 rounded-3xl p-2 border border-slate-100">
                                <button class="w-full flex items-center gap-3 px-4 py-4 hover:bg-white rounded-2xl transition-all group toggle-case-btn" data-index="${cIdx}">
                                    <i data-lucide="${c.isOpen ? 'chevron-down' : 'chevron-right'}" size="14" class="text-slate-400"></i>
                                    <div class="bg-blue-600/10 p-2 rounded-xl text-blue-600"><i data-lucide="${c.isOpen ? 'folder-open' : 'folder'}" size="18"></i></div>
                                    <span class="text-[13px] font-black text-slate-800 truncate text-left flex-1">${c.folderName}</span>
                                    <span class="text-[10px] bg-white px-3 py-1 rounded-full font-black border border-slate-200 shadow-sm">${c.files.length}</span>
                                </button>
                                ${c.isOpen ? `
                                    <div class="mt-2 space-y-1 px-1 pb-1">
                                        ${c.files.map((f, fIdx) => `
                                            <button class="w-full text-left px-5 py-4 text-[11px] font-bold transition-all flex items-center gap-4 rounded-xl select-file-btn ${cIdx === state.selectedCaseIdx && fIdx === state.selectedFileIdx ? 'bg-blue-600 text-white shadow-xl' : 'hover:bg-blue-50 text-slate-500 hover:text-slate-900'}" data-case="${cIdx}" data-file="${fIdx}">
                                                <i data-lucide="file-text" size="16"></i>
                                                <span class="truncate flex-1">${f.name}</span>
                                            </button>
                                        `).join('')}
                                    </div>
                                ` : ''}
                            </div>
                        `).join('')}
                    </div>
                </aside>

                <main class="flex-1 bg-slate-200 overflow-y-auto p-12 relative flex flex-col items-center">
                    <div class="mb-12 flex bg-white/70 backdrop-blur-xl p-2 rounded-3xl shadow-xl border border-white sticky top-0 z-10">
                        <button id="viewSummaryBtn" class="px-10 py-4 rounded-2xl text-[11px] font-black transition-all ${state.viewMode === 'summary' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-600 hover:bg-white'}">通知書プレビュー</button>
                        <button id="viewTreeBtn" class="px-10 py-4 rounded-2xl text-[11px] font-black transition-all ${state.viewMode === 'tree' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-600 hover:bg-white'}">XML構造</button>
                    </div>

                    ${state.viewMode === 'summary' && data ? renderDocument(data, currentFile) : (currentFile ? renderTree(currentFile.parsed!) : '')}
                </main>
            </div>

            <footer class="bg-slate-900 text-blue-300 px-10 py-4 h-40 border-t border-slate-800 font-mono text-[10px] overflow-y-auto">
                <div class="flex justify-between items-center mb-4 sticky top-0 bg-slate-900/90 py-1 border-b border-white/5">
                    <span class="font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><i data-lucide="terminal" size="12"></i> Console Output</span>
                    <button id="clearLogs" class="text-slate-500 hover:text-white transition-colors">CLEAR</button>
                </div>
                ${state.logs.map(log => `<div class="mb-1">› ${log}</div>`).join('')}
            </footer>

            ${state.showSettings ? renderSettings() : ''}
        </div>
    `;

    attachEvents();
    if ((window as any).lucide) (window as any).lucide.createIcons();
};

const renderDocument = (data: UniversalData, file: AppFile) => {
    const calculations = calculateIfPossible(data);
    
    // Generic table rendering if no standard social insurance tags found
    const renderTable = (section: any) => {
        const calcs = calculateIfPossible(data);
        
        // Check if this looks like social insurance format (has remuneration related keywords)
        const isSocialInsurance = section.headers?.some((h: string) => h.match(/標準報酬|報酬月額|健保|厚年|S003|S004/i));

        if (isSocialInsurance) {
            return `
                <table class="w-full border-collapse border-[3px] border-slate-900 text-[13px] leading-tight mb-16">
                    <thead class="bg-slate-50">
                        <tr>
                            <th rowspan="2" class="border-[2px] border-slate-900 p-4 text-center font-black">整理番号</th>
                            <th rowspan="2" class="border-[2px] border-slate-900 p-4 font-black text-center">氏名</th>
                            <th rowspan="2" class="border-[2px] border-slate-900 p-4 w-24 text-center font-black">適用年月</th>
                            <th colspan="2" class="border-[2px] border-slate-900 p-3 text-center font-black">標準報酬月額</th>
                            <th rowspan="2" class="border-[2px] border-slate-900 p-4 text-center font-black">生年月日</th>
                            ${calcs ? `<th rowspan="2" class="border-[2px] border-slate-900 p-4 bg-blue-50 text-blue-700 font-black text-center">折半額(概算)</th>` : ''}
                        </tr>
                        <tr>
                            <th class="border-[2px] border-slate-900 p-3 text-center font-black text-[10px]">健康保険</th>
                            <th class="border-[2px] border-slate-900 p-3 text-center font-black text-[10px]">厚生年金</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${section.data.map((row: any, rIdx: number) => {
                            const iKey = section.headers?.find((h: string) => h.match(/整理番号|S001|ID|番号/));
                            const nKey = section.headers?.find((h: string) => h.match(/氏名|S002|Name/));
                            const tKey = section.headers?.find((h: string) => h.match(/適用年月|S005|Apply/));
                            const hKey = section.headers?.find((h: string) => h.match(/健保|報酬月額|S003|Health/i));
                            const pKey = section.headers?.find((h: string) => h.match(/厚年|報酬月額|S004|Pension/i));
                            const bKey = section.headers?.find((h: string) => h.match(/生年月日|S006|Birth/));

                            return `
                                <tr class="hover:bg-blue-50/30">
                                    <td class="border-[2px] border-slate-900 p-4 text-center font-mono font-bold">${row[iKey!] || '-'}</td>
                                    <td class="border-[2px] border-slate-900 p-4 font-black text-lg">${row[nKey!] || '-'}</td>
                                    <td class="border-[2px] border-slate-900 p-4 text-center font-bold text-slate-500">${row[tKey!] || '-'}</td>
                                    <td class="border-[2px] border-slate-900 p-4 text-right font-black text-lg">${row[hKey!] || '-'}</td>
                                    <td class="border-[2px] border-slate-900 p-4 text-right font-black text-lg">${row[pKey!] || '-'}</td>
                                    <td class="border-[2px] border-slate-900 p-4 text-center text-slate-600">${row[bKey!] || '-'}</td>
                                    ${calcs ? `<td class="border-[2px] border-slate-900 p-4 text-right font-black text-blue-700 bg-blue-50/50">¥${calcs[rIdx]?.toLocaleString()}</td>` : ''}
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            `;
        }

        // Fallback for non-standard or generic tables
        return `
            <div class="mb-16 overflow-x-auto">
                <h4 class="text-[10px] font-black text-slate-400 mb-3 uppercase tracking-widest">${section.name} (Data Table)</h4>
                <table class="w-full border-collapse border-2 border-slate-200 text-xs">
                    <thead>
                        <tr class="bg-slate-50">
                            ${section.headers?.map((h: string) => `<th class="border p-3 text-left font-bold text-slate-600">${h}</th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${section.data.map((row: any) => `
                            <tr class="hover:bg-slate-50">
                                ${section.headers?.map((h: string) => `<td class="border p-3">${row[h] || '-'}</td>`).join('')}
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    };

    return `
        <div class="bg-white shadow-2xl w-full max-w-[900px] min-h-[1200px] p-24 md:p-32 text-slate-900 relative mb-20 animate-in fade-in zoom-in-95 duration-700">
            <div class="flex justify-between items-start mb-24">
                <div class="space-y-2">
                    <p class="text-slate-400 font-bold">〒 ${data.postCode || '--- ----'}</p>
                    <p class="text-lg font-bold text-slate-600">${data.address || ''}</p>
                    <p class="text-3xl font-black tracking-tighter text-slate-900 mt-6">${data.companyName || '(事業所名 不明)'}</p>
                    <p class="text-3xl font-black tracking-tighter text-slate-900">${data.recipientName || '(代表者名 不明)'}　御中</p>
                </div>
                <div class="text-right">
                    <div class="bg-slate-50 border border-slate-200 rounded-3xl p-6 shadow-inner">
                        <p class="text-[10px] font-black text-slate-400 mb-2 uppercase tracking-widest">到達番号</p>
                        <p class="text-xl font-mono font-black text-slate-900">${data.arrivalNumber || '---'}</p>
                    </div>
                </div>
            </div>

            <div class="text-center mb-28">
                <h1 class="text-4xl font-black border-b-[5px] border-slate-900 inline-block px-16 pb-3 tracking-tighter italic">
                    ${data.title}
                </h1>
            </div>

            <div class="grid grid-cols-2 gap-12 mb-20 bg-slate-50/50 p-10 rounded-3xl border border-slate-100">
                <div>
                    <span class="text-[10px] font-black text-slate-400 block mb-3 uppercase tracking-widest">事業所整理記号</span>
                    <span class="text-2xl font-mono font-black text-slate-900">${data.officeInfo["事業所整理記号"] || data.headers["事業所整理記号"] || "---"}</span>
                </div>
                <div>
                    <span class="text-[10px] font-black text-slate-400 block mb-3 uppercase tracking-widest">事業所番号</span>
                    <span class="text-2xl font-mono font-black text-slate-900">${data.officeInfo["事業所番号"] || data.headers["事業所番号"] || "---"}</span>
                </div>
            </div>

            ${data.sections.length > 0 ? data.sections.map(renderTable).join('') : `
                <div class="p-20 border-2 border-dashed border-slate-200 rounded-[3rem] text-center text-slate-400">
                    <i data-lucide="alert-circle" class="mx-auto mb-4" size="48"></i>
                    <p class="font-bold">テーブルデータが検出されませんでした</p>
                    <p class="text-[10px] mt-2">XML構造またはタグ名が解析範囲外の可能性があります</p>
                </div>
            `}

            <div class="mt-40 border-t-2 border-slate-100 pt-16 flex justify-between items-end">
                <div class="font-black space-y-2">
                    <p class="text-slate-400 mb-8 text-lg">${data.creationDate || '令和　年　月　日'}</p>
                    <p class="text-3xl tracking-tighter">日本年金機構 理事長</p>
                    <p class="text-xl text-slate-500">（ ${data.officeName || '所轄年金事務所'} ）</p>
                </div>
                <div class="w-32 h-32 border-4 border-slate-100 rounded-full flex items-center justify-center text-slate-100 font-black text-[10px] tracking-tighter uppercase rotate-12 select-none">
                    Certified Data
                </div>
            </div>
        </div>
    `;
};

const renderTree = (node: XMLNode): string => {
    const traverse = (n: XMLNode): string => `
        <div class="xml-node my-1 border-l border-white/10 pl-5 py-0.5">
            <span class="text-blue-400 font-bold opacity-80">&lt;${n.name}&gt;</span>
            ${n.content ? `<span class="text-emerald-400 ml-2 font-black">${n.content}</span>` : ''}
            <div class="mt-0.5">${n.children.map(c => traverse(c)).join('')}</div>
            <span class="text-blue-400 font-bold opacity-80">&lt;/${n.name}&gt;</span>
        </div>
    `;
    return `
        <div class="bg-slate-900 p-16 rounded-[4rem] shadow-2xl overflow-auto text-blue-200 font-mono text-[13px] w-full max-w-5xl min-h-[900px] border border-white/5">
            <div class="mb-10 border-b border-white/5 pb-6 flex justify-between items-center">
                <span class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Source XML Node Graph</span>
            </div>
            ${traverse(node)}
        </div>
    `;
};

const renderSettings = () => `
    <div class="fixed inset-0 bg-slate-950/90 backdrop-blur-2xl z-[200] flex items-center justify-center p-8 animate-in fade-in duration-300">
        <div class="bg-white rounded-[4rem] shadow-2xl p-16 max-w-md w-full animate-in zoom-in-95">
            <h3 class="text-3xl font-black mb-12 flex items-center gap-4 text-slate-900">
                <i data-lucide="calculator" class="text-blue-600"></i>
                料率設定
            </h3>
            <div class="space-y-10">
                ${Object.entries(state.rates).map(([k, v]) => `
                    <div>
                        <label class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">${k === 'health' ? '健康保険(全額)' : k === 'pension' ? '厚生年金(全額)' : '介護保険'}</label>
                        <div class="flex items-center gap-6">
                            <input type="number" step="0.001" value="${v}" data-key="${k}" class="rate-input w-full p-6 bg-slate-50 border-none rounded-[1.5rem] font-black text-slate-900 text-3xl outline-none transition-all focus:ring-4 ring-blue-500/20" />
                            <span class="text-4xl font-black text-slate-200">%</span>
                        </div>
                    </div>
                `).join('')}
            </div>
            <button id="closeSettings" class="w-full mt-14 py-8 bg-slate-900 text-white font-black rounded-[2.5rem] hover:bg-black transition-all shadow-2xl active:scale-95 text-xl">保存</button>
        </div>
    </div>
`;

const calculateIfPossible = (data: UniversalData) => {
    const section = data.sections.find(s => s.isTable);
    if (!section || !section.headers) return null;
    
    // Find key columns
    const hKey = section.headers.find(h => h.match(/健保|報酬月額|S003|Health/i));
    if (!hKey) return null;
    const pKey = section.headers.find(h => h.match(/厚年|報酬月額|S004|Pension/i));

    return section.data.map(row => {
        const parseValue = (val: any) => {
            if (!val) return 0;
            const str = String(val);
            let num = parseInt(str.replace(/[^0-9]/g, '')) || 0;
            if (str.includes('千円')) num *= 1000;
            return num;
        };
        const healthAmount = parseValue(row[hKey]);
        const pensionAmount = pKey ? parseValue(row[pKey]) : 0;
        const healthP = Math.floor((healthAmount * (state.rates.health / 100)) / 2);
        const pensionP = Math.floor((pensionAmount * (state.rates.pension / 100)) / 2);
        return healthP + pensionP;
    });
};

const attachEvents = () => {
    document.getElementById('resetBtn')?.addEventListener('click', () => { state.cases = []; state.selectedCaseIdx = -1; render(); });
    document.getElementById('toggleSettings')?.addEventListener('click', () => { state.showSettings = !state.showSettings; render(); });
    document.getElementById('closeSettings')?.addEventListener('click', () => { state.showSettings = false; render(); });
    document.getElementById('clearLogs')?.addEventListener('click', () => { state.logs = []; render(); });
    document.getElementById('viewSummaryBtn')?.addEventListener('click', () => { state.viewMode = 'summary'; render(); });
    document.getElementById('viewTreeBtn')?.addEventListener('click', () => { state.viewMode = 'tree'; render(); });

    document.querySelectorAll('.toggle-case-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt((e.currentTarget as HTMLElement).dataset.index!);
            state.cases[idx].isOpen = !state.cases[idx].isOpen;
            render();
        });
    });

    document.querySelectorAll('.select-file-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.currentTarget as HTMLElement;
            state.selectedCaseIdx = parseInt(target.dataset.case!);
            state.selectedFileIdx = parseInt(target.dataset.file!);
            render();
        });
    });

    document.querySelectorAll('.rate-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const el = e.target as HTMLInputElement;
            const key = el.dataset.key as 'health' | 'pension' | 'nursing';
            state.rates[key] = parseFloat(el.value);
        });
    });
};

render();
