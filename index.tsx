
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
        throw new Error(`XMLのパースに失敗しました。ファイル形式を確認してください。`);
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

// Tag Translation Map
const TAG_MAP: Record<string, string> = {
    "S001": "整理番号",
    "S002": "氏名",
    "S003": "健康保険_標準報酬",
    "S004": "厚生年金_標準報酬",
    "S005": "適用年月",
    "S006": "生年月日",
    "S007": "種別",
    "S008": "備考",
    "T001": "到達番号",
    "T002": "所在地",
    "T003": "事業所名称",
    "T004": "代表者氏名",
    "T005": "作成年月日",
    "T006": "郵便番号",
    "T007": "年金事務所名",
    "T008": "事業所整理記号",
    "T009": "事業所番号"
};

const extractUniversalData = (node: XMLNode): UniversalData => {
    const headers: Record<string, string> = {};
    const officeInfo: Record<string, string> = {};
    const sections: UniversalData['sections'] = [];
    
    let arrivalNumber = "", postCode = "", address = "", companyName = "", recipientName = "", creationDate = "", officeName = "";

    const processNode = (n: XMLNode, path: string = "") => {
        const name = TAG_MAP[n.name] || n.name;
        const val = n.content || "";

        // Skip Meta information nodes from table detection
        if (["様式ID", "様式バージョン", "STYLESHEET", "Doctype"].includes(name)) {
            headers[name] = val;
            return;
        }

        // Global Info Mapping
        if (name.includes("到達番号")) arrivalNumber = val || arrivalNumber;
        if (name.includes("所在地") || name.includes("住所")) address = val || address;
        if (name.includes("事業所名称") || name.includes("会社名")) companyName = val || companyName;
        if (name.includes("氏名") || name.includes("代表者")) recipientName = val || recipientName;
        if (name.includes("年月日")) creationDate = val || creationDate;
        if (name.includes("郵便番号")) postCode = val || postCode;
        if (name.includes("年金事務所")) officeName = val || officeName;
        
        if (["整理記号", "事業所番号"].some(k => name.includes(k))) {
            officeInfo[name] = val;
        }

        if (n.children.length === 0) {
            if (val) headers[path + name] = val;
            return;
        }

        // Table Detection Strategy:
        // 1. Check if multiple children have the same name (standard list)
        // 2. Check if a parent node name contains "List", "Array", "情報", "Body"
        const counts: Record<string, number> = {};
        n.children.forEach(c => counts[c.name] = (counts[c.name] || 0) + 1);
        const repeatingTagName = Object.keys(counts).find(tag => counts[tag] > 1);

        if (repeatingTagName || n.name.toLowerCase().includes("list") || n.name === "Body" || n.name.includes("情報")) {
            const listItems = repeatingTagName ? n.children.filter(c => c.name === repeatingTagName) : n.children.filter(c => c.children.length > 0);
            
            if (listItems.length > 0) {
                const tableHeaders = new Set<string>();
                const rows = listItems.map(item => {
                    const row: Record<string, string> = {};
                    const flatten = (cn: XMLNode, prefix = "") => {
                        const cName = TAG_MAP[cn.name] || cn.name;
                        if (cn.children.length === 0) {
                            row[cName] = cn.content || "";
                            tableHeaders.add(cName);
                        } else {
                            cn.children.forEach(child => flatten(child, prefix));
                        }
                    };
                    flatten(item);
                    return row;
                });

                // Filter out meta-only tables (like the one in the user screenshot)
                const isRealDataTable = Array.from(tableHeaders).some(h => 
                    h.match(/氏名|報酬|整理番号|年月|S00/i)
                );

                if (isRealDataTable) {
                    sections.push({ 
                        name: repeatingTagName || n.name, 
                        isTable: true, 
                        headers: Array.from(tableHeaders), 
                        data: rows 
                    });
                    // Once we found a major data table, we usually don't need to dive deeper into this branch
                    return;
                }
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
    state.loadingMsg = "通知書データを抽出しています...";
    state.cases = [];
    render();

    const caseMap = new Map<string, AppFile[]>();

    try {
        for (const f of rawFiles) {
            const processFile = async (path: string, name: string, content: string) => {
                if (!name.toLowerCase().endsWith('.xml')) return;
                try {
                    const parsed = parseXML(content);
                    const analysis = extractUniversalData(parsed);
                    const dirName = path.split('/')[0] || "読み込みファイル";
                    
                    if (!caseMap.has(dirName)) caseMap.set(dirName, []);
                    caseMap.get(dirName)!.push({ name, fullPath: path, content, parsed, analysis });
                    addLog(`解析成功: ${name}`);
                } catch (err) {
                    addLog(`解析失敗: ${name} - ${err instanceof Error ? err.message : String(err)}`);
                }
            };

            if (f.name.endsWith('.zip')) {
                const zip = new JSZip();
                const loaded = await zip.loadAsync(f);
                for (const path of Object.keys(loaded.files)) {
                    if (loaded.files[path].dir) continue;
                    const content = await loaded.files[path].async('string');
                    await processFile(path, path.split('/').pop()!, content);
                }
            } else {
                const content = await f.text();
                await processFile((f as any).webkitRelativePath || f.name, f.name, content);
            }
        }

        state.cases = Array.from(caseMap.entries()).map(([name, files]) => ({
            folderName: name, folderPath: name, files, isOpen: true
        }));

        if (state.cases.length > 0) {
            state.selectedCaseIdx = 0;
            state.selectedFileIdx = 0;
        }
    } catch (err) {
        addLog(`処理エラー: ${err}`);
    } finally {
        state.isLoading = false;
        render();
    }
};

const render = () => {
    const root = document.getElementById('root');
    if (!root) return;

    if (state.isLoading) {
        root.innerHTML = `<div class="h-screen flex items-center justify-center bg-slate-900 text-white font-black text-2xl animate-pulse">${state.loadingMsg}</div>`;
        return;
    }

    if (state.cases.length === 0) {
        root.innerHTML = `
            <div class="h-screen flex flex-col items-center justify-center bg-slate-50 p-10">
                <div class="bg-white p-20 rounded-[4rem] shadow-2xl border text-center max-w-2xl w-full">
                    <div class="w-24 h-24 bg-blue-600 rounded-3xl flex items-center justify-center mx-auto mb-10 text-white shadow-xl rotate-3">
                        <i data-lucide="upload-cloud" size="48"></i>
                    </div>
                    <h1 class="text-4xl font-black mb-6 tracking-tighter">e-Gov Pro Explorer</h1>
                    <p class="text-slate-500 mb-12 font-medium">ZIPまたはフォルダをここにドラッグ、または選択してください</p>
                    <div class="grid grid-cols-2 gap-6">
                        <label class="p-8 bg-blue-600 text-white rounded-[2rem] font-black cursor-pointer hover:bg-blue-700 transition-all active:scale-95 shadow-lg">
                            フォルダを選択
                            <input type="file" id="folderInput" class="hidden" webkitdirectory directory />
                        </label>
                        <label class="p-8 bg-slate-900 text-white rounded-[2rem] font-black cursor-pointer hover:bg-black transition-all active:scale-95 shadow-lg">
                            ZIPを選択
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

    const currentFile = state.cases[state.selectedCaseIdx]?.files[state.selectedFileIdx];
    const data = currentFile?.analysis;

    root.innerHTML = `
        <div class="h-screen flex flex-col bg-slate-100 overflow-hidden">
            <header class="bg-white border-b px-10 py-5 flex items-center justify-between shadow-sm z-50">
                <div class="flex items-center gap-5">
                    <button id="resetBtn" class="bg-slate-100 p-3 rounded-xl hover:bg-slate-200"><i data-lucide="home" size="20"></i></button>
                    <h1 class="text-xl font-black tracking-tight">e-Gov Pro Explorer</h1>
                </div>
                <button id="toggleSettings" class="bg-slate-900 text-white px-6 py-3 rounded-xl text-xs font-black">料率設定</button>
            </header>

            <div class="flex-1 flex overflow-hidden">
                <aside class="w-80 bg-white border-r flex flex-col overflow-hidden">
                    <div class="p-5 border-b bg-slate-50 text-[10px] font-black text-slate-400 uppercase tracking-widest">Case Files</div>
                    <div class="flex-1 overflow-y-auto p-3 space-y-2">
                        ${state.cases.map((c, cIdx) => `
                            <div>
                                <button class="w-full flex items-center gap-2 p-3 font-bold text-slate-700 text-sm hover:bg-slate-50 rounded-lg toggle-case-btn" data-index="${cIdx}">
                                    <i data-lucide="${c.isOpen ? 'chevron-down' : 'chevron-right'}" size="14"></i>
                                    <span class="truncate">${c.folderName}</span>
                                </button>
                                ${c.isOpen ? c.files.map((f, fIdx) => `
                                    <button class="w-full text-left ml-5 p-3 text-xs font-bold rounded-lg mt-1 select-file-btn ${cIdx === state.selectedCaseIdx && fIdx === state.selectedFileIdx ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:bg-blue-50'}" data-case="${cIdx}" data-file="${fIdx}">
                                        ${f.name}
                                    </button>
                                `).join('') : ''}
                            </div>
                        `).join('')}
                    </div>
                </aside>

                <main class="flex-1 bg-slate-200 overflow-y-auto p-10 flex flex-col items-center">
                    <div class="mb-10 flex bg-white p-1.5 rounded-2xl shadow-lg sticky top-0 z-10">
                        <button id="viewSummaryBtn" class="px-8 py-3 rounded-xl text-xs font-black transition-all ${state.viewMode === 'summary' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500'}">通知書表示</button>
                        <button id="viewTreeBtn" class="px-8 py-3 rounded-xl text-xs font-black transition-all ${state.viewMode === 'tree' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500'}">データ構造</button>
                    </div>
                    ${state.viewMode === 'summary' && data ? renderDocument(data) : (currentFile ? renderTree(currentFile.parsed!) : '')}
                </main>
            </div>

            <footer class="h-32 bg-slate-900 text-blue-300 font-mono text-[10px] p-5 overflow-y-auto border-t border-slate-800">
                ${state.logs.map(log => `<div>› ${log}</div>`).join('')}
            </footer>

            ${state.showSettings ? renderSettings() : ''}
        </div>
    `;

    attachEvents();
    if ((window as any).lucide) (window as any).lucide.createIcons();
};

const renderDocument = (data: UniversalData) => {
    const calcs = calculateHalfAmount(data);
    return `
        <div class="bg-white shadow-2xl w-full max-w-[900px] min-h-[1200px] p-24 md:p-32 text-slate-900 rounded-sm relative mb-20">
            <div class="flex justify-between mb-20 text-sm font-bold">
                <div>
                    <p class="text-slate-400">〒 ${data.postCode || '--- ----'}</p>
                    <p>${data.address || ''}</p>
                    <p class="text-2xl font-black mt-5">${data.companyName || '事業所名称なし'}</p>
                    <p class="text-2xl font-black">${data.recipientName || ''}　御中</p>
                </div>
                <div class="text-right">
                    <div class="bg-slate-50 p-5 rounded-2xl border">
                        <p class="text-[10px] text-slate-400 uppercase font-black mb-1">到達番号</p>
                        <p class="font-mono font-black text-lg">${data.arrivalNumber || '---'}</p>
                    </div>
                </div>
            </div>

            <div class="text-center mb-20">
                <h1 class="text-3xl font-black border-b-4 border-slate-900 inline-block px-10 pb-2">${data.title}</h1>
            </div>

            <div class="grid grid-cols-2 gap-10 mb-10 bg-slate-50 p-8 rounded-2xl border">
                <div>
                    <p class="text-[10px] font-black text-slate-400 mb-1 uppercase">事業所整理記号</p>
                    <p class="text-xl font-mono font-black">${data.officeInfo["事業所整理記号"] || data.headers["事業所整理記号"] || '---'}</p>
                </div>
                <div>
                    <p class="text-[10px] font-black text-slate-400 mb-1 uppercase">事業所番号</p>
                    <p class="text-xl font-mono font-black">${data.officeInfo["事業所番号"] || data.headers["事業所番号"] || '---'}</p>
                </div>
            </div>

            ${data.sections.length > 0 ? data.sections.map((section, sIdx) => `
                <div class="mb-10 overflow-x-auto">
                    <h3 class="text-xs font-black text-slate-400 mb-4 uppercase tracking-widest">${section.name}</h3>
                    <table class="w-full border-collapse border-4 border-slate-900 text-[13px]">
                        <thead class="bg-slate-50">
                            <tr>
                                <th class="border-2 border-slate-900 p-3 font-black">整理番号</th>
                                <th class="border-2 border-slate-900 p-3 font-black">被保険者氏名</th>
                                <th class="border-2 border-slate-900 p-3 font-black">適用年月</th>
                                <th class="border-2 border-slate-900 p-3 font-black">健康保険<br><span class="text-[10px] font-normal">(標準報酬)</span></th>
                                <th class="border-2 border-slate-900 p-3 font-black">厚生年金<br><span class="text-[10px] font-normal">(標準報酬)</span></th>
                                <th class="border-2 border-slate-900 p-3 font-black">生年月日</th>
                                ${calcs ? `<th class="border-2 border-slate-900 p-3 bg-blue-50 text-blue-700 font-black">折半額<br>(概算)</th>` : ''}
                            </tr>
                        </thead>
                        <tbody>
                            ${section.data.map((row, rIdx) => {
                                const findVal = (regex: RegExp) => {
                                    const key = Object.keys(row).find(k => k.match(regex));
                                    return key ? row[key] : '-';
                                };
                                return `
                                    <tr class="hover:bg-blue-50/20">
                                        <td class="border-2 border-slate-900 p-3 text-center font-mono font-bold">${findVal(/整理番号|S001/)}</td>
                                        <td class="border-2 border-slate-900 p-3 font-black text-[15px]">${findVal(/氏名|S002/)}</td>
                                        <td class="border-2 border-slate-900 p-3 text-center font-bold text-slate-500">${findVal(/適用年月|S005/)}</td>
                                        <td class="border-2 border-slate-900 p-3 text-right font-black text-[15px]">${findVal(/健康保険|S003/)}</td>
                                        <td class="border-2 border-slate-900 p-3 text-right font-black text-[15px]">${findVal(/厚生年金|S004/)}</td>
                                        <td class="border-2 border-slate-900 p-3 text-center text-slate-400">${findVal(/生年月日|S006/)}</td>
                                        ${calcs ? `<td class="border-2 border-slate-900 p-3 text-right font-black text-blue-700 bg-blue-50/40">¥${calcs[sIdx][rIdx]?.toLocaleString()}</td>` : ''}
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `).join('') : `
                <div class="p-20 border-2 border-dashed rounded-3xl text-center text-slate-400 font-bold">
                    被保険者データが検出されませんでした
                </div>
            `}

            <div class="mt-40 pt-10 border-t flex justify-between items-end">
                <div class="space-y-2">
                    <p class="text-slate-400 font-bold mb-10">${data.creationDate || '令和　年　月　日'}</p>
                    <p class="text-3xl font-black tracking-tighter">日本年金機構 理事長</p>
                    <p class="text-slate-500 font-bold">（ ${data.officeName || '所轄年金事務所'} ）</p>
                </div>
                <div class="w-32 h-32 border-8 border-slate-50 rounded-full flex items-center justify-center text-slate-100 font-black rotate-12 select-none">OFFICIAL</div>
            </div>
        </div>
    `;
};

const calculateHalfAmount = (data: UniversalData) => {
    if (data.sections.length === 0) return null;
    return data.sections.map(section => {
        return section.data.map(row => {
            const hKey = Object.keys(row).find(k => k.match(/健康保険|S003/));
            const pKey = Object.keys(row).find(k => k.match(/厚生年金|S004/));
            
            const parseVal = (v: any) => {
                if (!v) return 0;
                let s = String(v).replace(/[^0-9]/g, '');
                let n = parseInt(s) || 0;
                if (String(v).includes('千円')) n *= 1000;
                return n;
            };

            const hVal = parseVal(row[hKey || '']);
            const pVal = parseVal(row[pKey || '']);
            
            const hHalf = Math.floor((hVal * (state.rates.health / 100)) / 2);
            const pHalf = Math.floor((pVal * (state.rates.pension / 100)) / 2);
            return hHalf + pHalf;
        });
    });
};

const renderTree = (node: XMLNode): string => {
    const traverse = (n: XMLNode): string => `
        <div class="ml-5 border-l border-white/10 pl-3 py-0.5">
            <span class="text-blue-400">&lt;${n.name}&gt;</span>
            ${n.content ? `<span class="text-emerald-400 font-bold ml-2">${n.content}</span>` : ''}
            <div>${n.children.map(c => traverse(c)).join('')}</div>
            <span class="text-blue-400">&lt;/${n.name}&gt;</span>
        </div>
    `;
    return `<div class="bg-slate-900 p-10 rounded-3xl w-full max-w-4xl font-mono text-xs text-blue-100 overflow-auto">${traverse(node)}</div>`;
};

const renderSettings = () => `
    <div class="fixed inset-0 bg-black/80 backdrop-blur-md z-[100] flex items-center justify-center p-5">
        <div class="bg-white p-12 rounded-[3rem] max-w-md w-full shadow-2xl animate-in zoom-in-95">
            <h2 class="text-3xl font-black mb-8 tracking-tighter">保険料率設定</h2>
            <div class="space-y-6">
                ${Object.entries(state.rates).map(([k, v]) => `
                    <div>
                        <label class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">${k === 'health' ? '健康保険' : k === 'pension' ? '厚生年金' : '介護保険'}</label>
                        <div class="flex items-center gap-4">
                            <input type="number" step="0.001" value="${v}" data-key="${k}" class="rate-input flex-1 p-4 bg-slate-100 rounded-2xl font-black text-2xl outline-none" />
                            <span class="text-2xl font-black text-slate-300">%</span>
                        </div>
                    </div>
                `).join('')}
            </div>
            <button id="closeSettings" class="w-full mt-10 py-5 bg-blue-600 text-white font-black rounded-2xl shadow-xl active:scale-95 transition-all">反映して閉じる</button>
        </div>
    </div>
`;

const attachEvents = () => {
    document.getElementById('resetBtn')?.addEventListener('click', () => { state.cases = []; render(); });
    document.getElementById('toggleSettings')?.addEventListener('click', () => { state.showSettings = true; render(); });
    document.getElementById('closeSettings')?.addEventListener('click', () => { state.showSettings = false; render(); });
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
            const key = el.dataset.key as any;
            state.rates[key] = parseFloat(el.value);
        });
    });
};

render();
