
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
    console.log(`[Viewer] ${msg}`);
    state.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (state.logs.length > 100) state.logs.shift();
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

        // Common e-Gov Field Heuristics
        if (name.includes("到達番号") || name === "ArrivalNumber" || name === "T001") arrivalNumber = val || arrivalNumber;
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

        // List Detection for Tables
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
    if (title.match(/Kokuho|S00|決定通知|S001|StandardRemuneration/)) {
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
    addLog(`${rawFiles.length} 個のファイルを読み込み開始`);
    render();

    const caseMap = new Map<string, AppFile[]>();
    const allPdfs = new Set<string>();

    const addToMap = (path: string, fileName: string, content: string) => {
        const dirPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : "案件";
        
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

                if (!caseMap.has(dirPath)) caseMap.set(dirPath, []);
                caseMap.get(dirPath)!.push(fileEntry);
                addLog(`解析完了: ${fileName}`);
            } catch (err) {
                addLog(`解析エラー (${fileName}): ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    };

    try {
        for (const f of rawFiles) {
            if (f.name.toLowerCase().endsWith('.zip')) {
                addLog(`ZIP展開中: ${f.name}`);
                const zip = new JSZip();
                const loadedZip = await zip.loadAsync(f);
                
                const zipEntries = Object.keys(loadedZip.files).filter(k => !loadedZip.files[k].dir);
                for (let i = 0; i < zipEntries.length; i++) {
                    const path = zipEntries[i];
                    const content = await loadedZip.files[path].async('string');
                    const baseName = path.split('/').pop() || path;
                    state.loadingMsg = `ZIP内解析中 (${i+1}/${zipEntries.length}): ${baseName}`;
                    render();
                    addToMap(path, baseName, content);
                }
            } else {
                const path = (f as any).webkitRelativePath || f.name;
                const content = await f.text();
                addToMap(path, f.name, content);
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
            addLog(`解析終了: ${state.cases.length} 案件, ${state.cases.reduce((a,c)=>a+c.files.length,0)} XMLファイルを検出`);
        } else {
            addLog("表示可能なXMLファイルが見つかりませんでした。");
        }
    } catch (err) {
        addLog(`処理失敗: ${err instanceof Error ? err.message : String(err)}`);
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
            <div class="min-h-screen flex items-center justify-center bg-slate-100 p-8">
                <div class="bg-white p-16 rounded-[4rem] shadow-2xl text-center max-w-lg w-full">
                    <div class="relative w-28 h-28 mx-auto mb-10">
                        <div class="absolute inset-0 rounded-full border-[6px] border-slate-50"></div>
                        <div class="absolute inset-0 rounded-full border-[6px] border-blue-600 border-t-transparent animate-spin"></div>
                    </div>
                    <h2 class="text-2xl font-black text-slate-900 mb-4 tracking-tighter">データを解析中</h2>
                    <p class="text-slate-500 font-bold text-sm animate-pulse">${state.loadingMsg}</p>
                </div>
            </div>
        `;
        return;
    }

    if (state.cases.length === 0) {
        root.innerHTML = `
            <div class="min-h-screen flex items-center justify-center bg-[#f1f5f9] p-6">
                <div class="bg-white p-16 rounded-[4rem] shadow-2xl border border-slate-200 w-full max-w-2xl text-center">
                    <div class="bg-blue-600 w-32 h-32 rounded-[2.5rem] flex items-center justify-center mx-auto mb-14 text-white shadow-2xl rotate-3">
                        <i data-lucide="folder-search" size="64"></i>
                    </div>
                    <h2 class="text-5xl font-black mb-6 text-slate-900 tracking-tighter">e-Gov Explorer</h2>
                    <p class="text-slate-500 mb-14 text-xl font-medium leading-relaxed">
                        ダウンロードしたZIP、または通知書フォルダを<br/>
                        丸ごと選択してください。
                    </p>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <label class="block py-10 px-10 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-[3rem] cursor-pointer transition-all active:scale-95 shadow-xl group">
                            <i data-lucide="folder-plus" class="mx-auto mb-4 group-hover:scale-110 transition-transform"></i>
                            フォルダを選択
                            <input type="file" id="folderInput" class="hidden" webkitdirectory />
                        </label>
                        <label class="block py-10 px-10 bg-slate-900 hover:bg-black text-white font-black rounded-[3rem] cursor-pointer transition-all active:scale-95 shadow-xl group">
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
        <div class="h-screen flex flex-col bg-[#e2e8f0] overflow-hidden">
            <!-- Global Navbar -->
            <header class="bg-white border-b border-slate-200 px-10 py-6 flex items-center justify-between z-50 shadow-sm">
                <div class="flex items-center gap-6">
                    <button id="resetBtn" class="bg-slate-100 p-4 rounded-[1.5rem] hover:bg-slate-200 transition-colors text-slate-600 shadow-sm active:scale-95"><i data-lucide="home" size="24"></i></button>
                    <div>
                        <h1 class="text-2xl font-black text-slate-900 tracking-tighter leading-none">e-Gov Pro Explorer</h1>
                        <p class="text-[10px] font-black text-slate-400 mt-2 uppercase tracking-widest">Digital Case Archive</p>
                    </div>
                </div>
                <div class="flex items-center gap-4">
                    <button id="toggleSettings" class="flex items-center gap-2 px-8 py-4 bg-white border-2 border-slate-100 hover:border-blue-500 rounded-2xl text-xs font-black transition-all shadow-sm active:scale-95">
                        <i data-lucide="calculator" size="16"></i> 料率設定
                    </button>
                </div>
            </header>

            <div class="flex-1 flex overflow-hidden">
                <!-- Sidebar: Case Explorer Tree -->
                <aside class="w-96 bg-white border-r border-slate-200 flex flex-col shadow-inner select-none overflow-hidden">
                    <div class="p-8 border-b bg-slate-50/50 flex items-center justify-between">
                        <h2 class="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                            <i data-lucide="folder-tree" size="12"></i> Explorer
                        </h2>
                    </div>
                    <div class="flex-1 overflow-y-auto custom-scrollbar p-3">
                        ${state.cases.map((c, cIdx) => `
                            <div class="mb-2">
                                <button class="w-full flex items-center gap-3 px-4 py-4 hover:bg-slate-50 rounded-2xl transition-all group toggle-case-btn" data-index="${cIdx}">
                                    <i data-lucide="${c.isOpen ? 'chevron-down' : 'chevron-right'}" size="16" class="text-slate-400 group-hover:text-blue-600 transition-colors"></i>
                                    <i data-lucide="${c.isOpen ? 'folder-open' : 'folder'}" size="20" class="text-blue-500"></i>
                                    <span class="text-[13px] font-black text-slate-800 truncate">${c.folderName}</span>
                                    <span class="ml-auto text-[10px] bg-blue-100 text-blue-600 px-2.5 py-1 rounded-full font-black">${c.files.length}</span>
                                </button>
                                ${c.isOpen ? `
                                    <div class="ml-8 mt-2 space-y-2 border-l-2 border-slate-100 pl-3">
                                        ${c.files.map((f, fIdx) => `
                                            <button class="w-full text-left px-4 py-3 text-[12px] font-bold transition-all flex items-center gap-3 rounded-xl select-file-btn ${cIdx === state.selectedCaseIdx && fIdx === state.selectedFileIdx ? 'bg-blue-600 text-white shadow-xl' : 'hover:bg-blue-50 text-slate-500 hover:text-slate-900'}" data-case="${cIdx}" data-file="${fIdx}">
                                                <i data-lucide="file-text" size="16"></i>
                                                <span class="truncate pr-2">${f.name}</span>
                                                ${f.hasPdf ? '<i data-lucide="check-circle-2" size="14" class="ml-auto text-green-500 opacity-60"></i>' : ''}
                                            </button>
                                        `).join('')}
                                    </div>
                                ` : ''}
                            </div>
                        `).join('')}
                    </div>
                </aside>

                <!-- Document Main View -->
                <main class="flex-1 bg-[#cbd5e1] overflow-y-auto p-8 md:p-16 relative flex flex-col items-center">
                    <div class="mb-12 flex bg-white/70 backdrop-blur-xl p-2 rounded-3xl shadow-2xl border border-white/40 sticky top-0 z-10">
                        <button id="viewSummaryBtn" class="px-10 py-4 rounded-2xl text-xs font-black transition-all ${state.viewMode === 'summary' ? 'bg-blue-600 text-white shadow-xl scale-105' : 'text-slate-600 hover:bg-white'}">
                            <i data-lucide="layout" size="14" class="inline mr-2"></i>通知書レイアウト
                        </button>
                        <button id="viewTreeBtn" class="px-10 py-4 rounded-2xl text-xs font-black transition-all ${state.viewMode === 'tree' ? 'bg-blue-600 text-white shadow-xl scale-105' : 'text-slate-600 hover:bg-white'}">
                            <i data-lucide="terminal" size="14" class="inline mr-2"></i>データ構造
                        </button>
                    </div>

                    ${state.viewMode === 'summary' && data ? renderDocument(data, currentFile) : (currentFile ? renderTree(currentFile.parsed!) : '')}
                </main>
            </div>

            <!-- Log Console -->
            <footer class="bg-slate-900 text-blue-300 px-10 py-4 h-44 border-t border-slate-800 font-mono text-[11px] overflow-y-auto shadow-2xl relative z-50">
                <div class="flex justify-between items-center mb-4 sticky top-0 bg-slate-900 py-1 border-b border-white/5">
                    <span class="font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><i data-lucide="monitor" size="12"></i> Terminal Output</span>
                    <button id="clearLogs" class="text-slate-500 hover:text-white transition-colors font-black">CLEAR</button>
                </div>
                ${state.logs.map(log => `<div class="mb-1">${log}</div>`).join('')}
                ${state.logs.length === 0 ? '<div class="italic opacity-30">Waiting for files...</div>' : ''}
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
        <div class="bg-white shadow-[0_50px_100px_-20px_rgba(0,0,0,0.4)] w-full max-w-[880px] min-h-[1200px] p-20 md:p-28 text-slate-900 relative border border-slate-100 mb-20 animate-in fade-in zoom-in-95 duration-500">
            <div class="flex justify-between items-start mb-20">
                <div class="text-[16px] font-bold leading-relaxed">
                    <p class="mb-1 tracking-tight">〒 ${data.postCode || '--- ----'}</p>
                    <p class="mb-6 leading-relaxed">${data.address || '所在地情報なし'}</p>
                    <p class="text-2xl mb-6 font-black tracking-tighter leading-tight">${data.companyName || '事業所名称なし'}</p>
                    <p class="text-2xl font-black tracking-tighter">${data.recipientName || '代表者名なし'}　御中</p>
                </div>
                <div class="text-right flex flex-col items-end">
                    <div class="bg-slate-50 border border-slate-200 rounded-[1.5rem] p-6 shadow-inner mb-6">
                        <p class="text-[10px] font-black text-slate-400 mb-2 uppercase tracking-widest text-center">到達番号</p>
                        <p class="text-xl font-mono font-black text-slate-900">${data.arrivalNumber || '---'}</p>
                    </div>
                </div>
            </div>

            <div class="text-center mb-24">
                <h1 class="text-3xl font-black border-b-[4px] border-slate-900 inline-block px-16 pb-2 tracking-tighter leading-tight">
                    ${data.title}
                </h1>
            </div>

            <div class="flex gap-20 mb-16 bg-slate-50/80 p-8 rounded-[2rem] border border-slate-100 shadow-sm">
                <div>
                    <span class="text-[10px] font-black text-slate-400 block mb-3 uppercase tracking-widest">事業所整理記号</span>
                    <span class="text-2xl font-mono font-black text-slate-900">${data.officeInfo["事業所整理記号"] || data.headers["事業所整理記号"] || "---"}</span>
                </div>
                <div class="border-l-2 border-slate-200 pl-20">
                    <span class="text-[10px] font-black text-slate-400 block mb-3 uppercase tracking-widest">事業所番号</span>
                    <span class="text-2xl font-mono font-black text-slate-900">${data.officeInfo["事業所番号"] || data.headers["事業所番号"] || "---"}</span>
                </div>
            </div>

            ${data.sections.map(section => `
                <div class="mb-20 overflow-x-auto">
                    <table class="w-full border-collapse border-[3px] border-slate-900 text-[13px] leading-tight">
                        <thead>
                            <tr class="bg-slate-100/70">
                                <th rowspan="2" class="border-2 border-slate-900 p-4 w-16 text-center font-bold">整理<br>番号</th>
                                <th rowspan="2" class="border-2 border-slate-900 p-4 font-bold text-center">被保険者氏名</th>
                                <th rowspan="2" class="border-2 border-slate-900 p-4 w-24 text-center font-bold">適用年月</th>
                                <th colspan="2" class="border-2 border-slate-900 p-3 text-center font-bold">決定後の標準報酬月額</th>
                                <th rowspan="2" class="border-2 border-slate-900 p-4 w-32 text-center font-bold">生年月日</th>
                                <th rowspan="2" class="border-2 border-slate-900 p-4 w-20 text-center font-bold">種別</th>
                                ${calculations ? `<th rowspan="2" class="border-2 border-slate-900 p-4 w-32 text-center font-bold bg-blue-50 text-blue-700">折半額<br>(概算)</th>` : ''}
                            </tr>
                            <tr class="bg-slate-100/70">
                                <th class="border-2 border-slate-900 p-3 w-24 text-center font-bold text-[10px]">(健康保険)</th>
                                <th class="border-2 border-slate-900 p-3 w-24 text-center font-bold text-[10px]">(厚生年金)</th>
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
                                    <tr class="hover:bg-blue-50/30 transition-colors">
                                        <td class="border-2 border-slate-900 p-4 text-center font-mono font-bold">${row[iKey!] || '-'}</td>
                                        <td class="border-2 border-slate-900 p-4 font-black text-[15px]">${row[nKey!] || '-'}</td>
                                        <td class="border-2 border-slate-900 p-4 text-center font-bold">${row[tKey!] || '-'}</td>
                                        <td class="border-2 border-slate-900 p-4 text-right font-black text-[15px]">${row[hKey!] || '-'}</td>
                                        <td class="border-2 border-slate-900 p-4 text-right font-black text-[15px]">${row[pKey!] || '-'}</td>
                                        <td class="border-2 border-slate-900 p-4 text-center">${row[bKey!] || '-'}</td>
                                        <td class="border-2 border-slate-900 p-4 text-center font-bold">${row[cKey!] || '-'}</td>
                                        ${calculations ? `
                                            <td class="border-2 border-slate-900 p-4 text-right font-black text-blue-700 bg-blue-50/50 text-[15px]">
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

            <div class="mt-32 text-[12px] space-y-4 text-slate-400 font-bold border-t-2 border-slate-100 pt-12">
                <p>※1 この通知はe-Gov電子申請システムを通じて発行された公的な決定通知書に基づいています。</p>
                <div class="pt-20 flex justify-between items-end text-slate-900">
                    <div class="font-black">
                        <p class="mb-6 text-[16px]">${data.creationDate || '令和 年 月 日'}</p>
                        <p class="text-3xl tracking-tighter">日本年金機構 理事長</p>
                        <p class="mt-3 text-slate-500 font-bold text-lg">（ ${data.officeName || '管轄年金事務所'} ）</p>
                    </div>
                    <div class="w-32 h-32 border-4 border-slate-200 rounded-full flex items-center justify-center text-slate-200 font-black text-[10px] uppercase rotate-12">
                        Official Copy
                    </div>
                </div>
            </div>
        </div>
    `;
};

const renderTree = (node: XMLNode): string => {
    const traverse = (n: XMLNode): string => `
        <div class="xml-node my-1 border-l-2 border-white/10 pl-6 py-1">
            <span class="text-indigo-400 font-black opacity-80">&lt;${n.name}&gt;</span>
            ${n.content ? `<span class="text-emerald-400 ml-3 font-bold">${n.content}</span>` : ''}
            <div class="mt-1">${n.children.map(c => traverse(c)).join('')}</div>
            <span class="text-indigo-400 font-black opacity-80">&lt;/${n.name}&gt;</span>
        </div>
    `;
    return `
        <div class="bg-slate-950 p-16 rounded-[4rem] shadow-2xl overflow-auto text-blue-200 font-mono text-[13px] w-full max-w-5xl min-h-[1000px] border border-white/5 animate-in slide-in-from-right duration-500">
            <div class="mb-10 flex items-center justify-between border-b border-white/10 pb-6">
                <span class="text-[11px] font-black uppercase tracking-widest text-slate-500">Raw XML Document Object</span>
            </div>
            ${traverse(node)}
        </div>
    `;
};

const renderSettings = () => `
    <div class="fixed inset-0 bg-slate-900/90 backdrop-blur-2xl z-[200] flex items-center justify-center p-10 animate-in fade-in duration-300">
        <div class="bg-white rounded-[4rem] shadow-2xl p-16 max-w-md w-full border border-slate-100 animate-in zoom-in-95">
            <h3 class="text-4xl font-black mb-12 flex items-center gap-4 text-slate-900">
                <div class="bg-blue-600 p-4 rounded-3xl text-white shadow-xl"><i data-lucide="calculator"></i></div>
                料率設定
            </h3>
            <div class="space-y-12">
                ${Object.entries(state.rates).map(([k, v]) => `
                    <div>
                        <label class="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-4">${k === 'health' ? '健康保険(事業主+本人)' : k === 'pension' ? '厚生年金(事業主+本人)' : '介護保険'}</label>
                        <div class="flex items-center gap-6">
                            <input type="number" step="0.001" value="${v}" data-key="${k}" class="rate-input w-full p-6 bg-slate-100 border-none rounded-[2rem] font-black text-slate-900 text-2xl focus:ring-4 ring-blue-500/30 outline-none transition-all" />
                            <span class="text-3xl font-black text-slate-300">%</span>
                        </div>
                    </div>
                `).join('')}
            </div>
            <button id="closeSettings" class="w-full mt-14 py-8 bg-slate-900 text-white font-black rounded-[2.5rem] hover:bg-black transition-all shadow-2xl active:scale-95 text-xl">保存して適用</button>
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
