
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
    logs: [] as string[],
    rates: { health: 9.98, pension: 18.3, nursing: 1.60 }
};

const addLog = (msg: string) => {
    state.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (state.logs.length > 50) state.logs.shift();
};

// --- XML Utilities ---
const parseXML = (xmlString: string): XMLNode => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "text/xml");
    if (xmlDoc.getElementsByTagName("parsererror").length > 0) throw new Error("Invalid XML");

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

        // 柔軟な情報抽出（シノニム対応）
        if (name.includes("到達番号") || name === "ArrivalNumber") arrivalNumber = val || arrivalNumber;
        if (name.includes("郵便番号") || name === "PostCode") postCode = val || postCode;
        if (name.includes("所在地") || name.includes("住所") || name === "Address" || name === "T002") address = val || address;
        if (name.includes("事業所名称") || name.includes("会社名") || name === "CompanyName" || name === "T003") companyName = val || companyName;
        if (name.includes("氏名") || name.includes("代表者") || name === "Name" || name === "T004") recipientName = val || recipientName;
        if (name.includes("作成年月日") || name.includes("通知年月日") || name === "Date" || name === "T005") creationDate = val || creationDate;
        if (name.includes("年金事務所名") || name === "OfficeName") officeName = val || officeName;
        
        if (["事業所整理記号", "事業所番号", "OfficeID"].some(k => name.includes(k))) {
            officeInfo[name] = val;
        }

        if (n.children.length === 0) {
            if (val) headers[path + name] = val;
            return;
        }

        // リスト（テーブルデータ）の検出
        const counts: Record<string, number> = {};
        n.children.forEach(c => counts[c.name] = (counts[c.name] || 0) + 1);
        const listTag = Object.keys(counts).find(tag => counts[tag] > 1);

        if (listTag) {
            const items = n.children.filter(c => c.name === listTag);
            const tableHeaders = new Set<string>();
            const rows = items.map(item => {
                const row: Record<string, string> = {};
                const flatten = (cn: XMLNode, prefix = "") => {
                    if (cn.children.length === 0) {
                        const key = prefix + cn.name;
                        row[key] = cn.content || "";
                        tableHeaders.add(key);
                    } else cn.children.forEach(child => flatten(child, cn.name + "_"));
                };
                flatten(item);
                return row;
            });
            sections.push({ name: n.name, isTable: true, headers: Array.from(tableHeaders), data: rows });
        } else {
            n.children.forEach(c => processNode(c, path + name + "_"));
        }
    };
    processNode(node);
    
    let title = node.name;
    if (title.match(/Kokuho|S00|決定通知/)) {
        title = "健康保険・厚生年金保険 被保険者標準報酬決定通知書";
    }

    return { title, arrivalNumber, postCode, address, companyName, recipientName, creationDate, officeName, officeInfo, headers, sections };
};

const handleUpload = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const rawFiles = Array.from(input.files || []);
    if (rawFiles.length === 0) return;

    state.isLoading = true;
    state.cases = [];
    state.logs = [];
    addLog(`${rawFiles.length} 個の対象を解析中...`);
    render();

    const caseMap = new Map<string, AppFile[]>();
    const allPdfs = new Set<string>();

    const addToFileMap = (path: string, fileName: string, content: string) => {
        const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : "ルート";
        
        if (fileName.toLowerCase().endsWith('.pdf')) {
            allPdfs.add(path);
            return;
        }

        if (fileName.toLowerCase().endsWith('.xml')) {
            try {
                const parsed = parseXML(content);
                const analysis = extractUniversalData(parsed);
                
                let detectedXsl = "";
                const piMatch = parsed.processingInstructions.find(pi => pi.includes('href='));
                if (piMatch) {
                    const match = piMatch.match(/href="([^"]+)"/);
                    if (match) detectedXsl = match[1];
                }
                
                const fileEntry: AppFile = {
                    name: fileName,
                    fullPath: path,
                    content,
                    parsed,
                    analysis,
                    detectedXsl
                };

                if (!caseMap.has(dir)) caseMap.set(dir, []);
                caseMap.get(dir)!.push(fileEntry);
            } catch (err) {
                addLog(`解析失敗: ${fileName}`);
            }
        }
    };

    for (const f of rawFiles) {
        if (f.name.toLowerCase().endsWith('.zip')) {
            try {
                const zip = await JSZip.loadAsync(f);
                for (const filename of Object.keys(zip.files)) {
                    if (zip.files[filename].dir) continue;
                    const content = await zip.files[filename].async('string');
                    const baseName = filename.split('/').pop() || filename;
                    addToFileMap(filename, baseName, content);
                }
            } catch (err) {
                addLog(`ZIPエラー: ${f.name}`);
            }
        } else {
            const path = (f as any).webkitRelativePath || f.name;
            const content = await f.text();
            addToFileMap(path, f.name, content);
        }
    }

    state.cases = Array.from(caseMap.entries()).map(([dir, xmls]) => {
        xmls.forEach(xml => {
            const xmlBase = xml.fullPath.substring(0, xml.fullPath.lastIndexOf('.'));
            xml.hasPdf = Array.from(allPdfs).some(p => p.startsWith(xmlBase));
        });
        return {
            folderPath: dir,
            folderName: dir.split('/').pop() || dir,
            files: xmls,
            isOpen: true
        };
    });

    if (state.cases.length > 0) {
        state.selectedCaseIdx = 0;
        state.selectedFileIdx = 0;
        addLog(`${state.cases.length} 個の案件、計 ${state.cases.reduce((acc, c) => acc + c.files.length, 0)} 個のXMLをロードしました。`);
    } else {
        addLog("XMLファイルが見つかりませんでした。");
    }

    state.isLoading = false;
    render();
};

const render = () => {
    const root = document.getElementById('root');
    if (!root) return;

    if (state.isLoading) {
        root.innerHTML = `
            <div class="min-h-screen flex items-center justify-center bg-slate-100 p-6">
                <div class="text-center">
                    <div class="animate-spin rounded-full h-16 w-16 border-b-4 border-blue-600 mx-auto mb-6"></div>
                    <p class="text-slate-600 font-bold text-lg animate-pulse">データを読み込み中...</p>
                </div>
            </div>
        `;
        return;
    }

    if (state.cases.length === 0) {
        root.innerHTML = `
            <div class="min-h-screen flex items-center justify-center bg-[#f8fafc] p-6">
                <div class="bg-white p-16 rounded-[4rem] shadow-2xl border border-slate-100 w-full max-w-2xl text-center transform transition-all hover:scale-[1.01]">
                    <div class="bg-blue-600 w-28 h-28 rounded-[2rem] flex items-center justify-center mx-auto mb-12 text-white shadow-2xl rotate-3">
                        <i data-lucide="folder-search" size="56"></i>
                    </div>
                    <h2 class="text-5xl font-black mb-6 text-slate-900 tracking-tighter">e-Gov Explorer</h2>
                    <p class="text-slate-500 mb-14 text-xl font-medium leading-relaxed">
                        ダウンロードしたZIP、または通知書フォルダを<br/>
                        丸ごと選択してください。
                    </p>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <label class="block py-8 px-10 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-[2.5rem] cursor-pointer transition-all active:scale-95 shadow-xl group">
                            <i data-lucide="folder-plus" class="mx-auto mb-4 group-hover:scale-110 transition-transform"></i>
                            フォルダを選択
                            <input type="file" id="folderInput" class="hidden" webkitdirectory />
                        </label>
                        <label class="block py-8 px-10 bg-slate-900 hover:bg-black text-white font-black rounded-[2.5rem] cursor-pointer transition-all active:scale-95 shadow-xl group">
                            <i data-lucide="file-archive" class="mx-auto mb-4 group-hover:scale-110 transition-transform"></i>
                            ZIPファイル
                            <input type="file" id="zipInput" class="hidden" accept=".zip" />
                        </label>
                    </div>
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
        <div class="h-screen flex flex-col bg-[#f1f5f9] overflow-hidden">
            <!-- Global Header -->
            <header class="bg-white border-b border-slate-200 px-8 py-5 flex items-center justify-between z-50 shadow-sm">
                <div class="flex items-center gap-5">
                    <button id="resetBtn" class="bg-slate-100 p-3 rounded-2xl hover:bg-slate-200 transition-colors text-slate-600 shadow-sm"><i data-lucide="arrow-left" size="20"></i></button>
                    <div>
                        <h1 class="text-xl font-black text-slate-900 tracking-tight leading-none">e-Gov Pro Explorer</h1>
                        <p class="text-[10px] font-bold text-slate-400 mt-1 uppercase tracking-widest">Case Management System</p>
                    </div>
                </div>
                <div class="flex items-center gap-4">
                    <button id="toggleSettings" class="flex items-center gap-2 px-6 py-3 bg-white border border-slate-200 hover:border-blue-500 rounded-2xl text-xs font-black transition-all shadow-sm">
                        <i data-lucide="sliders-horizontal" size="14"></i> 負担額計算設定
                    </button>
                </div>
            </header>

            <div class="flex-1 flex overflow-hidden">
                <!-- Sidebar: VS Code Style Folder Tree -->
                <aside class="w-85 bg-white border-r border-slate-200 flex flex-col shadow-inner select-none">
                    <div class="p-6 border-b bg-slate-50/50">
                        <h2 class="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                            <i data-lucide="layers" size="12"></i> Explorer
                        </h2>
                    </div>
                    <div class="flex-1 overflow-y-auto custom-scrollbar p-2">
                        ${state.cases.map((c, cIdx) => `
                            <div class="mb-1">
                                <button class="w-full flex items-center gap-2 px-4 py-3 hover:bg-slate-50 rounded-xl transition-all group toggle-case-btn" data-index="${cIdx}">
                                    <i data-lucide="${c.isOpen ? 'chevron-down' : 'chevron-right'}" size="14" class="text-slate-400 group-hover:text-blue-600 transition-colors"></i>
                                    <i data-lucide="${c.isOpen ? 'folder-open' : 'folder'}" size="18" class="text-blue-500"></i>
                                    <span class="text-[12px] font-black text-slate-700 truncate">${c.folderName}</span>
                                    <span class="ml-auto text-[9px] bg-blue-100 text-blue-600 px-2 py-0.5 rounded-full font-black">${c.files.length}</span>
                                </button>
                                ${c.isOpen ? `
                                    <div class="ml-6 mt-1 space-y-1 border-l-2 border-slate-100 pl-2">
                                        ${c.files.map((f, fIdx) => `
                                            <button class="w-full text-left px-4 py-2.5 text-xs font-bold transition-all flex items-center gap-3 rounded-lg select-file-btn ${cIdx === state.selectedCaseIdx && fIdx === state.selectedFileIdx ? 'bg-blue-600 text-white shadow-md' : 'hover:bg-blue-50 text-slate-500 hover:text-slate-900'}" data-case="${cIdx}" data-file="${fIdx}">
                                                <i data-lucide="file-text" size="14"></i>
                                                <span class="truncate pr-2">${f.name}</span>
                                                ${f.hasPdf ? '<i data-lucide="paperclip" size="12" class="ml-auto opacity-50"></i>' : ''}
                                            </button>
                                        `).join('')}
                                    </div>
                                ` : ''}
                            </div>
                        `).join('')}
                    </div>
                </aside>

                <!-- Preview Area -->
                <main class="flex-1 bg-[#e2e8f0] overflow-y-auto p-6 md:p-14 relative flex flex-col items-center">
                    <div class="mb-10 flex bg-white/50 backdrop-blur-md p-1.5 rounded-2xl shadow-lg border border-white/20 sticky top-0 z-10">
                        <button id="viewSummaryBtn" class="px-8 py-3 rounded-xl text-xs font-black transition-all ${state.viewMode === 'summary' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-600 hover:bg-white'}">
                            <i data-lucide="eye" size="14" class="inline mr-2"></i>通知書プレビュー
                        </button>
                        <button id="viewTreeBtn" class="px-8 py-3 rounded-xl text-xs font-black transition-all ${state.viewMode === 'tree' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-600 hover:bg-white'}">
                            <i data-lucide="code" size="14" class="inline mr-2"></i>XMLソースコード
                        </button>
                    </div>

                    ${state.viewMode === 'summary' && data ? renderDocument(data, currentFile) : (currentFile ? renderTree(currentFile.parsed!) : '')}
                </main>
            </div>

            <!-- Debug / Log Footer -->
            <footer class="bg-slate-900 text-blue-200 px-8 py-3 h-40 border-t border-slate-800 font-mono text-[10px] overflow-y-auto shadow-2xl relative z-50">
                <div class="flex justify-between items-center mb-3 sticky top-0 bg-slate-900 py-1 border-b border-white/5">
                    <span class="font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><i data-lucide="terminal" size="12"></i> System Console</span>
                    <button id="clearLogs" class="text-slate-500 hover:text-white transition-colors font-black">CLEAR</button>
                </div>
                ${state.logs.map(log => `<div>${log}</div>`).join('')}
                ${state.logs.length === 0 ? '<div class="italic opacity-30">Waiting for data...</div>' : ''}
            </footer>

            ${state.showSettings ? renderSettings() : ''}
        </div>
    `;

    attachEvents();
    if ((window as any).lucide) (window as any).lucide.createIcons();
};

const renderDocument = (data: UniversalData, file: AppFile) => {
    const calculations = calculateIfPossible(data);
    return `
        <div class="bg-white shadow-[0_30px_60px_-15px_rgba(0,0,0,0.3)] w-full max-w-[850px] min-h-[1100px] p-16 md:p-24 text-slate-900 relative border border-slate-200 mb-20 animate-in fade-in zoom-in-95 duration-500">
            <!-- Header Grid -->
            <div class="flex justify-between items-start mb-16">
                <div class="text-[15px] font-bold leading-relaxed">
                    <p class="mb-1 tracking-tighter">〒 ${data.postCode || '--- ----'}</p>
                    <p class="mb-5 leading-relaxed">${data.address || '---'}</p>
                    <p class="text-2xl mb-5 font-black tracking-tighter">${data.companyName || '---'}</p>
                    <p class="text-2xl font-black tracking-tighter">${data.recipientName || '---'}　様</p>
                </div>
                <div class="text-right flex flex-col items-end">
                    <div class="bg-slate-50 border border-slate-200 rounded-xl p-4 shadow-inner mb-4">
                        <p class="text-[10px] font-black text-slate-400 mb-1">到達番号</p>
                        <p class="text-lg font-mono font-bold text-slate-900">${data.arrivalNumber || '---'}</p>
                    </div>
                    ${file.detectedXsl ? `<span class="text-[9px] bg-blue-50 text-blue-500 px-2 py-1 rounded-md font-mono font-bold">STYLESHEET: ${file.detectedXsl}</span>` : ''}
                </div>
            </div>

            <!-- Main Title -->
            <div class="text-center mb-20">
                <h1 class="text-3xl font-black border-b-[3px] border-slate-900 inline-block px-14 pb-1.5 tracking-tighter leading-tight">
                    ${data.title}
                </h1>
            </div>

            <!-- Office Identifiers -->
            <div class="flex gap-16 mb-14 bg-slate-50/50 p-6 rounded-3xl border border-slate-100">
                <div>
                    <span class="text-[10px] font-black text-slate-400 block mb-2 uppercase tracking-widest">事業所整理記号</span>
                    <span class="text-xl font-mono font-black text-slate-800">${data.officeInfo["事業所整理記号"] || data.headers["事業所整理記号"] || "---"}</span>
                </div>
                <div class="border-l border-slate-200 pl-16">
                    <span class="text-[10px] font-black text-slate-400 block mb-2 uppercase tracking-widest">事業所番号</span>
                    <span class="text-xl font-mono font-black text-slate-800">${data.officeInfo["事業所番号"] || data.headers["事業所番号"] || "---"}</span>
                </div>
            </div>

            <!-- Table Sections -->
            ${data.sections.map(section => `
                <div class="mb-16 overflow-x-auto">
                    <table class="w-full border-collapse border-[2px] border-slate-900 text-[12px] leading-tight">
                        <thead>
                            <tr class="bg-slate-100/50">
                                <th rowspan="2" class="border border-slate-900 p-3 w-16 text-center font-bold">整理番号</th>
                                <th rowspan="2" class="border border-slate-900 p-3 font-bold text-center">被保険者氏名</th>
                                <th rowspan="2" class="border border-slate-900 p-3 w-20 text-center font-bold">適用年月</th>
                                <th colspan="2" class="border border-slate-900 p-2 text-center font-bold">決定後の標準報酬月額</th>
                                <th rowspan="2" class="border border-slate-900 p-3 w-28 text-center font-bold">生年月日</th>
                                <th rowspan="2" class="border border-slate-900 p-3 w-16 text-center font-bold">種別</th>
                                ${calculations ? `<th rowspan="2" class="border border-slate-900 p-3 w-28 text-center font-bold bg-blue-50 text-blue-700">概算負担額</th>` : ''}
                            </tr>
                            <tr class="bg-slate-100/50">
                                <th class="border border-slate-900 p-2 w-24 text-center font-bold text-[10px]">(健康保険)</th>
                                <th class="border border-slate-900 p-2 w-24 text-center font-bold text-[10px]">(厚生年金)</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${section.data.map((row, rIdx) => {
                                const hKey = section.headers?.find(h => h.match(/健保|標準報酬月額|Health/));
                                const pKey = section.headers?.find(h => h.match(/厚年|標準報酬月額|Pension/));
                                const bKey = section.headers?.find(h => h.match(/生年月日|Birth/));
                                const nKey = section.headers?.find(h => h.match(/氏名|Name/));
                                const iKey = section.headers?.find(h => h.match(/番号|ID|整理番号/));
                                const tKey = section.headers?.find(h => h.match(/適用年月|Apply/));
                                const cKey = section.headers?.find(h => h.match(/種別|区分|Type/));

                                return `
                                    <tr class="hover:bg-slate-50 transition-colors">
                                        <td class="border border-slate-900 p-3 text-center font-mono font-bold">${row[iKey!] || '-'}</td>
                                        <td class="border border-slate-900 p-3 font-black text-sm">${row[nKey!] || '-'}</td>
                                        <td class="border border-slate-900 p-3 text-center font-bold">${row[tKey!] || '-'}</td>
                                        <td class="border border-slate-900 p-3 text-right font-black text-sm">${row[hKey!] || '-'}</td>
                                        <td class="border border-slate-900 p-3 text-right font-black text-sm">${row[pKey!] || '-'}</td>
                                        <td class="border border-slate-900 p-3 text-center">${row[bKey!] || '-'}</td>
                                        <td class="border border-slate-900 p-3 text-center">${row[cKey!] || '-'}</td>
                                        ${calculations ? `
                                            <td class="border border-slate-900 p-3 text-right font-black text-blue-700 bg-blue-50/50">
                                                ¥${calculations[rIdx]?.toLocaleString()}
                                            </td>
                                        ` : ''}
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `).join('')}

            <!-- Footer Details -->
            <div class="mt-24 text-[11px] space-y-3 text-slate-400 font-bold border-t border-slate-100 pt-10">
                <p>※1 元号略号： S (昭和), H (平成), R (令和)</p>
                <p>※2 種別区分： 第一種 (男性), 第二種 (女性), 第三種 (坑内員) 等</p>
                <p class="mt-6 text-slate-600 font-black">上記の通り、健康保険法および厚生年金保険法に基づき標準報酬が決定されましたので通知いたします。</p>
                
                <div class="pt-16 flex justify-between items-end text-slate-900">
                    <div class="font-black">
                        <p class="mb-5 text-[14px]">${data.creationDate || '令和7年12月 5日'}</p>
                        <p class="text-2xl tracking-tighter">日本年金機構 理事長</p>
                        <p class="mt-2 text-slate-500 font-bold">（ ${data.officeName || '所轄年金事務所'} ）</p>
                    </div>
                </div>
            </div>
        </div>
    `;
};

const renderTree = (node: XMLNode): string => {
    const traverse = (n: XMLNode): string => `
        <div class="xml-node my-1 border-l-2 border-white/5 pl-5 py-0.5">
            <span class="text-indigo-400 font-bold opacity-80">&lt;${n.name}&gt;</span>
            ${n.content ? `<span class="text-emerald-400 ml-2 font-black">${n.content}</span>` : ''}
            <div class="mt-0.5">${n.children.map(c => traverse(c)).join('')}</div>
            <span class="text-indigo-400 font-bold opacity-80">&lt;/${n.name}&gt;</span>
        </div>
    `;
    return `
        <div class="bg-slate-950 p-12 rounded-[3rem] shadow-2xl overflow-auto text-blue-200 font-mono text-[12px] w-full max-w-4xl min-h-[900px] animate-in slide-in-from-right duration-500 border border-white/10">
            <div class="mb-6 flex items-center justify-between border-b border-white/10 pb-4">
                <span class="text-[10px] font-black uppercase tracking-widest text-slate-500">Document Source Object</span>
            </div>
            ${traverse(node)}
        </div>
    `;
};

const renderSettings = () => `
    <div class="fixed inset-0 bg-slate-900/80 backdrop-blur-xl z-[200] flex items-center justify-center p-8 animate-in fade-in duration-300">
        <div class="bg-white rounded-[4rem] shadow-2xl p-14 max-w-md w-full animate-in zoom-in-95 duration-300 border border-slate-100">
            <h3 class="text-3xl font-black mb-10 flex items-center gap-4 text-slate-900 leading-none">
                <div class="bg-blue-600 p-3 rounded-2xl text-white shadow-lg"><i data-lucide="calculator"></i></div>
                計算パラメータ
            </h3>
            <div class="space-y-10">
                ${Object.entries(state.rates).map(([k, v]) => `
                    <div class="relative">
                        <label class="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-3">${k === 'health' ? '健康保険 (事業主+本人)' : k === 'pension' ? '厚生年金 (事業主+本人)' : '介護保険'}</label>
                        <div class="flex items-center gap-4">
                            <input type="number" step="0.001" value="${v}" data-key="${k}" class="rate-input w-full p-5 bg-slate-100 border-none rounded-[1.5rem] font-black text-slate-900 text-xl focus:ring-4 ring-blue-500/20 outline-none transition-all" />
                            <span class="text-2xl font-black text-slate-300">%</span>
                        </div>
                    </div>
                `).join('')}
            </div>
            <p class="mt-10 text-[11px] font-bold text-slate-400 leading-relaxed text-center italic">※折半額の計算において1円未満の端数は切捨てとして算出します。</p>
            <button id="closeSettings" class="w-full mt-10 py-6 bg-slate-900 text-white font-black rounded-[2rem] hover:bg-black transition-all shadow-2xl active:scale-95 text-lg">設定を保存</button>
        </div>
    </div>
`;

const calculateIfPossible = (data: UniversalData) => {
    const section = data.sections.find(s => s.isTable);
    if (!section || !section.headers) return null;
    const hIdx = section.headers.findIndex(h => h.match(/健保|標準報酬月額|Health/));
    if (hIdx === -1) return null;
    const pIdx = section.headers.findIndex(h => h.match(/厚年|標準報酬月額|Pension/));

    return section.data.map(row => {
        const parseValue = (val: any) => {
            if (!val) return 0;
            const str = String(val);
            let num = parseInt(str.replace(/[^0-9]/g, '')) || 0;
            if (str.includes('千円')) num *= 1000;
            return num;
        };
        const healthAmount = parseValue(row[section.headers![hIdx]]);
        const pensionAmount = pIdx !== -1 ? parseValue(row[section.headers![pIdx]]) : 0;
        const healthP = Math.floor((healthAmount * (state.rates.health / 100)) / 2);
        const pensionP = Math.floor((pensionAmount * (state.rates.pension / 100)) / 2);
        return healthP + pensionP;
    });
};

const attachEvents = () => {
    document.getElementById('resetBtn')?.addEventListener('click', () => { 
        state.cases = []; 
        state.selectedCaseIdx = -1; 
        state.selectedFileIdx = -1; 
        render(); 
    });
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
