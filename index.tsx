
import { GoogleGenAI, Type } from "@google/genai";
import JSZip from "jszip";

// --- Types ---
interface XMLNode {
    name: string;
    attributes: Record<string, string>;
    content?: string;
    children: XMLNode[];
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

interface AppCase {
    id: string;
    folderName: string;
    xmlFiles: AppFile[];
    pdfFiles: string[]; // URLs or Base64
}

interface AppFile {
    name: string;
    content: string;
    parsed?: XMLNode;
    analysis?: UniversalData;
}

// --- App State ---
const state = {
    cases: [] as AppCase[],
    selectedCaseIndex: -1,
    selectedFileIndex: 0,
    viewMode: 'summary' as 'summary' | 'tree',
    showSettings: false,
    isLoading: false,
    rates: { health: 9.98, pension: 18.3, nursing: 1.60 }
};

// --- XML Utilities ---
const parseXML = (xmlString: string): XMLNode => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "text/xml");
    if (xmlDoc.getElementsByTagName("parsererror").length > 0) throw new Error("Invalid XML");

    const traverse = (element: Element): XMLNode => {
        const attributes: Record<string, string> = {};
        for (let i = 0; i < element.attributes.length; i++) {
            const attr = element.attributes[i];
            attributes[attr.name] = attr.value;
        }
        const children: XMLNode[] = [];
        Array.from(element.childNodes).forEach(child => {
            if (child.nodeType === Node.ELEMENT_NODE) children.push(traverse(child as Element));
        });
        return { 
            name: element.tagName, 
            attributes, 
            content: element.children.length === 0 ? element.textContent?.trim() : undefined, 
            children 
        };
    };
    return traverse(xmlDoc.documentElement);
};

const extractUniversalData = (node: XMLNode): UniversalData => {
    const headers: Record<string, string> = {};
    const officeInfo: Record<string, string> = {};
    const sections: UniversalData['sections'] = [];
    let arrivalNumber = "";
    let postCode = "";
    let address = "";
    let companyName = "";
    let recipientName = "";
    let creationDate = "";
    let officeName = "";

    const findContent = (target: string, n: XMLNode): string | null => {
        if (n.name.includes(target)) return n.content || null;
        for (const child of n.children) {
            const res = findContent(target, child);
            if (res) return res;
        }
        return null;
    };

    const processNode = (n: XMLNode, path: string = "") => {
        // Deep extraction for key identity fields
        if (n.name.includes("到達番号")) arrivalNumber = n.content || arrivalNumber;
        if (n.name.includes("郵便番号")) postCode = n.content || postCode;
        if (n.name.includes("所在地") || n.name.includes("事業所住所")) address = n.content || address;
        if (n.name.includes("事業所名称") || n.name.includes("会社名")) companyName = n.content || companyName;
        if (n.name.includes("氏名") || n.name.includes("代表者名")) recipientName = n.content || recipientName;
        if (n.name.includes("作成年月日") || n.name.includes("通知年月日")) creationDate = n.content || creationDate;
        if (n.name.includes("年金事務所名")) officeName = n.content || officeName;
        
        if (["事業所整理記号", "事業所番号"].some(k => n.name.includes(k))) {
            officeInfo[n.name] = n.content || "";
        }

        if (n.children.length === 0) {
            if (n.content) headers[path + n.name] = n.content;
            return;
        }

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
            n.children.forEach(c => processNode(c, path + n.name + "_"));
        }
    };
    processNode(node);
    
    let title = node.name;
    if (title.includes("Kokuho") || title.includes("S00") || title.includes("決定通知書")) {
        title = "健康保険・厚生年金保険 被保険者標準報酬決定通知書";
    }

    return { title, arrivalNumber, postCode, address, companyName, recipientName, creationDate, officeName, officeInfo, headers, sections };
};

const calculateIfPossible = (data: UniversalData) => {
    const section = data.sections.find(s => s.isTable);
    if (!section || !section.headers) return null;
    const hIdx = section.headers.findIndex(h => ["健保", "健康保険", "標準額", "標準報酬", "賞与額"].some(k => h.includes(k)));
    if (hIdx === -1) return null;
    const pIdx = section.headers.findIndex(h => ["厚年", "厚生年金"].some(k => h.includes(k)));
    const bIdx = section.headers.findIndex(h => ["生年月日", "生年"].some(k => h.includes(k)));

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

const render = () => {
    const root = document.getElementById('root');
    if (!root) return;

    if (state.cases.length === 0) {
        root.innerHTML = `
            <div class="min-h-screen flex items-center justify-center bg-slate-50 p-4">
                <div class="bg-white p-12 rounded-[2.5rem] shadow-2xl border border-slate-200 w-full max-w-xl text-center">
                    <div class="bg-slate-900 w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-10 text-white shadow-xl rotate-3">
                        <i data-lucide="folder-open" size="40"></i>
                    </div>
                    <h2 class="text-3xl font-black mb-4 text-slate-900 tracking-tighter">e-Gov 案件ビューア</h2>
                    <p class="text-slate-500 mb-10 text-lg font-medium">ZIP、または案件フォルダを選択してください。</p>
                    
                    <div class="grid grid-cols-1 gap-4">
                        <label class="block py-5 px-8 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-2xl cursor-pointer transition-all active:scale-95 shadow-lg">
                            <span class="flex items-center justify-center gap-2"><i data-lucide="file-archive"></i> ZIPファイルを選択</span>
                            <input type="file" id="fileInput" class="hidden" accept=".zip,.xml" />
                        </label>
                        <label class="block py-5 px-8 bg-slate-800 hover:bg-slate-900 text-white font-black rounded-2xl cursor-pointer transition-all active:scale-95 shadow-lg">
                            <span class="flex items-center justify-center gap-2"><i data-lucide="folder-plus"></i> フォルダ(案件)を一括選択</span>
                            <input type="file" id="folderInput" class="hidden" webkitdirectory />
                        </label>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('fileInput')?.addEventListener('change', handleUpload);
        document.getElementById('folderInput')?.addEventListener('change', handleUpload);
    } else if (state.selectedCaseIndex === -1) {
        root.innerHTML = `
            <div class="min-h-screen bg-slate-50 flex flex-col p-8">
                <header class="max-w-4xl mx-auto w-full mb-12 flex justify-between items-end">
                    <div>
                        <h2 class="text-3xl font-black text-slate-900">案件一覧</h2>
                        <p class="text-slate-500 font-bold">${state.cases.length} 件の案件が見つかりました</p>
                    </div>
                    <button id="resetBtn" class="bg-white text-slate-600 px-6 py-3 rounded-2xl font-black border hover:bg-slate-50 shadow-sm transition-all">リセット</button>
                </header>
                <div class="max-w-4xl mx-auto w-full grid gap-4">
                    ${state.cases.map((c, index) => `
                        <button class="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 hover:border-blue-500 hover:shadow-xl transition-all flex items-center gap-6 text-left select-case-btn" data-index="${index}">
                            <div class="bg-blue-50 p-4 rounded-2xl text-blue-600 shadow-inner"><i data-lucide="folder" size="28"></i></div>
                            <div class="flex-1 min-w-0">
                                <h3 class="text-lg font-black text-slate-800 truncate mb-1">${c.folderName}</h3>
                                <div class="flex gap-4">
                                    <span class="text-[10px] bg-slate-100 text-slate-500 px-2 py-1 rounded-lg font-black">XML: ${c.xmlFiles.length}</span>
                                    <span class="text-[10px] bg-red-50 text-red-500 px-2 py-1 rounded-lg font-black">PDF: ${c.pdfFiles.length}</span>
                                </div>
                            </div>
                            <i data-lucide="chevron-right" size="24" class="text-slate-300"></i>
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
        attachCasePickerEvents();
    } else {
        const currentCase = state.cases[state.selectedCaseIndex];
        const currentFile = currentCase.xmlFiles[state.selectedFileIndex];
        const data = currentFile.analysis;
        const calculations = data ? calculateIfPossible(data) : null;

        root.innerHTML = `
            <div class="min-h-screen bg-slate-100 flex flex-col">
                <!-- Toolbar -->
                <header class="bg-slate-900 text-white px-6 py-3 flex items-center justify-between sticky top-0 z-[100] shadow-2xl">
                    <div class="flex items-center gap-6">
                        <button id="backToPicker" class="hover:bg-white/10 p-2 rounded-xl transition-colors"><i data-lucide="chevron-left" size="24"></i></button>
                        <div>
                            <p class="text-[10px] font-black opacity-40 leading-none mb-1">CURRENT CASE</p>
                            <h1 class="text-sm font-black truncate max-w-[300px]">${currentCase.folderName}</h1>
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        ${currentCase.xmlFiles.length > 1 ? `
                            <select id="fileSelector" class="bg-white/10 border-none rounded-xl px-4 py-2 text-xs font-black text-white outline-none">
                                ${currentCase.xmlFiles.map((f, i) => `<option value="${i}" ${i === state.selectedFileIndex ? 'selected' : ''} class="text-slate-900">${f.name}</option>`).join('')}
                            </select>
                        ` : ''}
                        <button id="toggleSettings" class="p-2 hover:bg-white/10 rounded-xl transition-colors"><i data-lucide="settings" size="20"></i></button>
                        <button id="viewTree" class="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-xl text-xs font-black">XML</button>
                    </div>
                </header>

                <div class="flex-1 flex overflow-hidden">
                    <!-- Main Document View -->
                    <main class="flex-1 overflow-y-auto p-4 md:p-12 flex flex-col items-center">
                        ${state.viewMode === 'summary' && data ? `
                            <div class="bg-white shadow-2xl w-full max-w-[900px] min-h-[1200px] p-12 md:p-20 text-slate-900 relative border border-slate-300 mb-20 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                
                                <!-- Top: Address & Arrival -->
                                <div class="flex justify-between items-start mb-12">
                                    <div class="text-[15px] font-bold leading-relaxed">
                                        <p class="mb-1">${data.postCode ? '〒' + data.postCode : ''}</p>
                                        <p class="mb-4">${data.address || ''}</p>
                                        <p class="text-xl mb-4">${data.companyName || ''}</p>
                                        <p class="text-xl">${data.recipientName || ''}　様</p>
                                    </div>
                                    <div class="text-right">
                                        <p class="text-[12px] font-bold">到達番号　${data.arrivalNumber || ''}</p>
                                    </div>
                                </div>

                                <!-- Center Title -->
                                <div class="text-center mb-16">
                                    <h1 class="text-2xl font-black border-b-[2px] border-slate-900 inline-block px-10 pb-1">
                                        ${data.title}
                                    </h1>
                                </div>

                                <!-- Management Numbers -->
                                <div class="flex gap-12 mb-10">
                                    <div>
                                        <span class="text-[11px] font-black text-slate-400 block mb-1">事業所整理記号</span>
                                        <span class="text-lg font-mono font-bold">${data.officeInfo["事業所整理記号"] || "---"}</span>
                                    </div>
                                    <div>
                                        <span class="text-[11px] font-black text-slate-400 block mb-1">事業所番号</span>
                                        <span class="text-lg font-mono font-bold">${data.officeInfo["事業所番号"] || "---"}</span>
                                    </div>
                                </div>

                                <!-- Main Data Table -->
                                ${data.sections.map((section, sIdx) => `
                                    <div class="mb-12 overflow-x-auto">
                                        <table class="w-full border-collapse border-[1.5px] border-slate-900 text-[12px]">
                                            <thead>
                                                <tr class="bg-slate-50">
                                                    <th rowspan="2" class="border border-slate-900 p-2 w-16 text-center font-bold">整理番号</th>
                                                    <th rowspan="2" class="border border-slate-900 p-2 font-bold text-center">被保険者氏名</th>
                                                    <th rowspan="2" class="border border-slate-900 p-2 w-20 text-center font-bold">※1 適用年月</th>
                                                    <th colspan="2" class="border border-slate-900 p-1 text-center font-bold">決定後の標準報酬月額</th>
                                                    <th rowspan="2" class="border border-slate-900 p-2 w-24 text-center font-bold">※1 生年月日</th>
                                                    <th rowspan="2" class="border border-slate-900 p-2 w-16 text-center font-bold">※2 種別</th>
                                                    ${calculations && section.isTable ? `<th rowspan="2" class="border border-slate-900 p-2 w-28 text-center font-bold bg-blue-50 text-blue-700">概算本人負担額</th>` : ''}
                                                </tr>
                                                <tr class="bg-slate-50">
                                                    <th class="border border-slate-900 p-1 w-24 text-center font-bold text-[10px]">(健保)</th>
                                                    <th class="border border-slate-900 p-1 w-24 text-center font-bold text-[10px]">(厚年)</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                ${section.data.map((row, rIdx) => {
                                                    const hKey = section.headers?.find(h => h.includes("健保") || h.includes("標準報酬月額"));
                                                    const pKey = section.headers?.find(h => h.includes("厚年") || h.includes("標準報酬月額"));
                                                    const bKey = section.headers?.find(h => h.includes("生年月日"));
                                                    const nKey = section.headers?.find(h => h.includes("氏名"));
                                                    const iKey = section.headers?.find(h => h.includes("番号") || h.includes("整理番号"));
                                                    const tKey = section.headers?.find(h => h.includes("適用年月"));
                                                    const cKey = section.headers?.find(h => h.includes("種別") || h.includes("区分"));

                                                    return `
                                                        <tr class="hover:bg-slate-50 transition-colors">
                                                            <td class="border border-slate-900 p-3 text-center font-mono">${row[iKey!] || '-'}</td>
                                                            <td class="border border-slate-900 p-3 font-bold text-sm">${row[nKey!] || '-'}</td>
                                                            <td class="border border-slate-900 p-3 text-center">${row[tKey!] || '-'}</td>
                                                            <td class="border border-slate-900 p-3 text-right font-bold">${row[hKey!] || '-'}</td>
                                                            <td class="border border-slate-900 p-3 text-right font-bold">${row[pKey!] || '-'}</td>
                                                            <td class="border border-slate-900 p-3 text-center">${row[bKey!] || '-'}</td>
                                                            <td class="border border-slate-900 p-3 text-center">${row[cKey!] || '-'}</td>
                                                            ${calculations && section.isTable ? `
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

                                <!-- Footer Notes & Issuer -->
                                <div class="mt-20 text-[11px] space-y-2 text-slate-500 font-bold border-t pt-10">
                                    <p>※1 元号　S：昭和　H：平成　R：令和</p>
                                    <p>※2 種別　第一種：男性　第二種：女性　第三種：坑内員　等</p>
                                    <p class="mt-4">上記の通り標準報酬が決定されたので通知します。</p>
                                    
                                    <div class="pt-16 flex justify-between items-end text-slate-900">
                                        <div class="text-[13px] font-bold">
                                            <p class="mb-4">${data.creationDate || '令和７年１２月 ５日'}</p>
                                            <p class="text-lg">日本年金機構 理事長</p>
                                            <p class="mt-1">（ ${data.officeName || '枚方年金事務所'} ）</p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ` : `
                            <div class="bg-slate-900 p-10 rounded-[3rem] shadow-2xl overflow-auto text-blue-200 font-mono text-xs w-full max-w-4xl">
                                ${currentFile.parsed ? renderTree(currentFile.parsed) : 'No data'}
                            </div>
                        `}
                    </main>

                    <!-- Case Info Sidebar -->
                    <aside class="w-80 bg-white border-l border-slate-200 p-6 overflow-y-auto hidden lg:block">
                        <h4 class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-6">Case Assets</h4>
                        <div class="space-y-6">
                            <div>
                                <label class="text-[10px] font-black text-blue-600 block mb-2 uppercase">XML Files</label>
                                <div class="space-y-2">
                                    ${currentCase.xmlFiles.map((f, i) => `
                                        <button class="w-full text-left p-3 rounded-xl text-xs font-bold transition-all ${i === state.selectedFileIndex ? 'bg-blue-600 text-white shadow-lg' : 'hover:bg-slate-50 text-slate-600'} select-file-sidebar" data-index="${i}">
                                            ${f.name}
                                        </button>
                                    `).join('')}
                                </div>
                            </div>
                            ${currentCase.pdfFiles.length > 0 ? `
                                <div>
                                    <label class="text-[10px] font-black text-red-500 block mb-2 uppercase">Attached PDFs</label>
                                    <div class="space-y-2">
                                        ${currentCase.pdfFiles.map(pdf => `
                                            <div class="p-3 bg-red-50 rounded-xl flex items-center justify-between group cursor-pointer">
                                                <span class="text-[11px] font-bold text-red-700 truncate">${pdf}</span>
                                                <i data-lucide="external-link" size="14" class="text-red-300"></i>
                                            </div>
                                        `).join('')}
                                    </div>
                                </div>
                            ` : ''}
                        </div>
                    </aside>
                </div>

                <!-- Settings Overlay -->
                ${state.showSettings ? `
                    <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[200] flex items-center justify-center p-6" id="settingsOverlay">
                        <div class="bg-white rounded-[2.5rem] shadow-2xl p-10 max-w-sm w-full">
                            <h3 class="text-xl font-black mb-8 flex items-center gap-2 text-slate-800"><i data-lucide="calculator"></i> 保険料率設定 (%)</h3>
                            <div class="space-y-6">
                                ${Object.entries(state.rates).map(([k, v]) => `
                                    <div>
                                        <label class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">${k === 'health' ? '健康保険' : k === 'pension' ? '厚生年金' : '介護保険'}</label>
                                        <input type="number" step="0.001" value="${v}" data-key="${k}" class="rate-input w-full p-4 bg-slate-100 border-none rounded-2xl font-black text-slate-700" />
                                    </div>
                                `).join('')}
                            </div>
                            <button id="closeSettings" class="w-full mt-10 py-5 bg-slate-900 text-white font-black rounded-2xl hover:bg-slate-800 transition-all shadow-xl">保存して戻る</button>
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
        attachEvents();
    }
    if ((window as any).lucide) (window as any).lucide.createIcons();
};

const renderTree = (node: XMLNode): string => {
    return `
        <div class="xml-node my-0.5">
            <span class="text-indigo-400 opacity-60">&lt;${node.name}&gt;</span>
            ${node.content ? `<span class="text-white ml-1 font-bold">${node.content}</span>` : ''}
            <div>${node.children.map(c => renderTree(c)).join('')}</div>
            <span class="text-indigo-400 opacity-60">&lt;/${node.name}&gt;</span>
        </div>
    `;
};

const handleUpload = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (files.length === 0) return;

    state.isLoading = true;
    render();

    const casesMap = new Map<string, AppCase>();

    for (const file of files) {
        // Simple case grouping: relativePath directory or ZIP extraction
        const pathParts = (file as any).webkitRelativePath ? (file as any).webkitRelativePath.split('/') : [file.name];
        const folderName = pathParts.length > 1 ? pathParts[pathParts.length - 2] : "Root Case";
        
        if (!casesMap.has(folderName)) {
            casesMap.set(folderName, { id: Math.random().toString(36), folderName, xmlFiles: [], pdfFiles: [] });
        }
        const currentCase = casesMap.get(folderName)!;

        if (file.name.toLowerCase().endsWith('.xml')) {
            const content = await file.text();
            const parsed = parseXML(content);
            currentCase.xmlFiles.push({ name: file.name, content, parsed, analysis: extractUniversalData(parsed) });
        } else if (file.name.toLowerCase().endsWith('.pdf')) {
            currentCase.pdfFiles.push(file.name);
        } else if (file.name.toLowerCase().endsWith('.zip')) {
            const zip = await JSZip.loadAsync(file);
            for (const filename of Object.keys(zip.files)) {
                if (filename.toLowerCase().endsWith('.xml')) {
                    const content = await zip.files[filename].async('string');
                    const parsed = parseXML(content);
                    currentCase.xmlFiles.push({ name: filename, content, parsed, analysis: extractUniversalData(parsed) });
                } else if (filename.toLowerCase().endsWith('.pdf')) {
                    currentCase.pdfFiles.push(filename);
                }
            }
        }
    }

    state.cases = Array.from(casesMap.values()).filter(c => c.xmlFiles.length > 0);
    if (state.cases.length === 1) state.selectedCaseIndex = 0;
    state.isLoading = false;
    render();
};

const attachCasePickerEvents = () => {
    document.getElementById('resetBtn')?.addEventListener('click', () => { state.cases = []; state.selectedCaseIndex = -1; render(); });
    document.querySelectorAll('.select-case-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            state.selectedCaseIndex = parseInt((e.currentTarget as HTMLElement).dataset.index || "0");
            state.selectedFileIndex = 0;
            render();
        });
    });
};

const attachEvents = () => {
    document.getElementById('backToPicker')?.addEventListener('click', () => { state.selectedCaseIndex = -1; render(); });
    document.getElementById('toggleSettings')?.addEventListener('click', () => { state.showSettings = !state.showSettings; render(); });
    document.getElementById('closeSettings')?.addEventListener('click', () => { state.showSettings = false; render(); });
    document.getElementById('viewTree')?.addEventListener('click', () => { state.viewMode = 'tree'; render(); });
    document.getElementById('viewSummary')?.addEventListener('click', () => { state.viewMode = 'summary'; render(); });
    
    document.getElementById('fileSelector')?.addEventListener('change', (e) => {
        state.selectedFileIndex = parseInt((e.target as HTMLSelectElement).value);
        render();
    });

    document.querySelectorAll('.select-file-sidebar').forEach(btn => {
        btn.addEventListener('click', (e) => {
            state.selectedFileIndex = parseInt((e.currentTarget as HTMLElement).dataset.index || "0");
            render();
        });
    });

    document.querySelectorAll('.rate-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const el = e.target as HTMLInputElement;
            const key = el.dataset.key as 'health' | 'pension' | 'nursing';
            state.rates[key] = parseFloat(el.value);
            render();
        });
    });
};

render();
