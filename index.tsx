
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
    content: string;
    parsed?: XMLNode;
    analysis?: UniversalData;
}

// --- App State ---
const state = {
    files: [] as AppFile[],
    selectedFileIndex: -1, 
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
    const sections: UniversalData['sections'] = [];

    const processNode = (n: XMLNode, path: string = "") => {
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
            n.children.filter(c => c.name !== listTag).forEach(c => processNode(c, n.name + "_"));
        } else {
            n.children.forEach(c => processNode(c, path + n.name + "_"));
        }
    };
    processNode(node);
    
    // Attempt to find a better title from internal tags
    let title = node.name;
    const titleTags = ["公文書名称", "書類名称", "通知書名称"];
    for(const tag of titleTags) {
        const found = Object.entries(headers).find(([k]) => k.includes(tag));
        if(found) {
            title = found[1];
            break;
        }
    }

    return { title, headers, sections };
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
        const birthStr = bIdx !== -1 ? String(row[section.headers![bIdx]]) : "";
        const isNursing = birthStr.includes("S") || birthStr.includes("19") || (birthStr.includes("H") && parseInt(birthStr.replace(/[^0-9]/g, '')) < 10);
        const healthP = Math.floor((healthAmount * (state.rates.health / 100)) / 2);
        const pensionP = Math.floor((pensionAmount * (state.rates.pension / 100)) / 2);
        const nursingP = isNursing ? Math.floor((healthAmount * (state.rates.nursing / 100)) / 2) : 0;
        return healthP + pensionP + nursingP;
    });
};

const render = () => {
    const root = document.getElementById('root');
    if (!root) return;

    if (state.files.length === 0) {
        root.innerHTML = `
            <div class="min-h-screen flex items-center justify-center bg-[#f0f2f5] p-4">
                <div class="bg-white p-12 rounded-3xl shadow-xl border border-slate-200 w-full max-w-md text-center">
                    <div class="bg-blue-600 w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-8 text-white shadow-lg">
                        <i data-lucide="file-up" size="40"></i>
                    </div>
                    <h2 class="text-3xl font-bold mb-3 text-slate-800 tracking-tight">e-Gov公文書Viewer</h2>
                    <p class="text-slate-500 mb-10 text-sm leading-relaxed">e-Govからダウンロードした<br>ZIPまたはXMLを読み込みます</p>
                    <label class="block w-full py-4 px-8 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-2xl cursor-pointer transition-all shadow-md active:scale-95">
                        ファイルを選択
                        <input type="file" id="fileInput" class="hidden" accept=".xml,.zip" />
                    </label>
                </div>
            </div>
        `;
        document.getElementById('fileInput')?.addEventListener('change', handleFile);
    } else if (state.selectedFileIndex === -1) {
        root.innerHTML = `
            <div class="min-h-screen bg-[#f0f2f5] py-12 px-4 flex flex-col items-center">
                <div class="w-full max-w-2xl">
                    <div class="flex items-center justify-between mb-8 px-2">
                        <div>
                            <h2 class="text-2xl font-bold text-slate-900">ZIP内の書類</h2>
                            <p class="text-sm text-slate-500 font-medium">表示する書類を選んでください</p>
                        </div>
                        <button id="resetBtn" class="bg-white text-slate-600 px-5 py-2 rounded-xl text-sm font-bold border border-slate-200 hover:bg-slate-50 transition-colors">戻る</button>
                    </div>
                    <div class="grid gap-4">
                        ${state.files.map((file, index) => `
                            <div class="bg-white p-6 rounded-2xl shadow-sm border border-transparent hover:border-blue-500 hover:shadow-md transition-all cursor-pointer flex items-center gap-5 select-file-btn group" data-index="${index}">
                                <div class="bg-blue-50 p-3 rounded-xl text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                                    <i data-lucide="file-text" size="24"></i>
                                </div>
                                <div class="flex-1 min-w-0">
                                    <h3 class="text-base font-bold text-slate-800 truncate mb-0.5">${file.name}</h3>
                                    <p class="text-xs text-slate-400 font-bold uppercase tracking-tight">${file.analysis?.title || '書類名称なし'}</p>
                                </div>
                                <i data-lucide="chevron-right" size="20" class="text-slate-300 group-hover:text-blue-600"></i>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        `;
        attachPickerEvents();
    } else {
        const currentFile = state.files[state.selectedFileIndex];
        const analysis = currentFile.analysis;
        const calculations = analysis ? calculateIfPossible(analysis) : null;

        // Extract metadata for the "official" look
        const dateKey = Object.keys(analysis?.headers || {}).find(k => k.includes("通知年月日") || k.includes("年月日"));
        const dateVal = dateKey ? analysis?.headers[dateKey] : "－";
        const officeKey = Object.keys(analysis?.headers || {}).find(k => k.includes("事業所名称") || k.includes("事業主"));
        const officeVal = officeKey ? analysis?.headers[officeKey] : "（事業所名称 未検出）";

        root.innerHTML = `
            <div class="min-h-screen flex flex-col bg-[#f0f2f5]">
                <header class="bg-slate-900 text-white px-6 py-3 flex items-center justify-between sticky top-0 z-50 shadow-md">
                    <div class="flex items-center gap-3">
                        <button id="backToPicker" class="hover:bg-white/10 p-2 rounded-full transition-colors" title="ファイル一覧へ戻る">
                            <i data-lucide="arrow-left" size="20"></i>
                        </button>
                        <div class="hidden md:block">
                            <h1 class="text-xs font-bold text-slate-400 uppercase tracking-tighter leading-none mb-1">e-Gov View</h1>
                            <p class="text-sm font-bold truncate max-w-xs">${currentFile.name}</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        <button id="toggleSettings" class="flex items-center gap-2 px-3 py-1.5 hover:bg-white/10 rounded-lg text-xs font-bold transition-colors">
                            <i data-lucide="settings" size="16"></i> 計算設定
                        </button>
                    </div>
                </header>

                <main class="flex-1 p-4 md:p-8 overflow-y-auto flex flex-col items-center">
                    ${state.showSettings ? `
                        <div class="mb-6 p-5 bg-white rounded-2xl border border-slate-200 shadow-sm w-full max-w-[1000px] grid grid-cols-1 md:grid-cols-3 gap-6 animate-in slide-in-from-top-1">
                            ${Object.entries(state.rates).map(([k, v]) => `
                                <div>
                                    <label class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">${k === 'health' ? '健康保険' : k === 'pension' ? '厚生年金' : '介護保険'} (%)</label>
                                    <input type="number" step="0.01" value="${v}" data-key="${k}" class="rate-input w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono font-bold focus:ring-2 focus:ring-blue-500 outline-none" />
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}

                    ${state.viewMode === 'summary' && analysis ? `
                        <!-- Paper Document Style -->
                        <div class="bg-white w-full max-w-[1000px] shadow-2xl rounded-sm p-8 md:p-12 mb-20 border border-slate-200 relative overflow-hidden flex flex-col min-h-[1414px]">
                            
                            <!-- Header Info (Nenkin Style) -->
                            <div class="flex justify-between items-start mb-12 text-slate-800">
                                <div class="max-w-[40%]">
                                    <p class="text-sm font-bold border-b border-slate-900 pb-1 mb-4">${officeVal}</p>
                                    <p class="text-xs leading-relaxed text-slate-600">
                                        下記のとおり通知します。
                                    </p>
                                </div>
                                <div class="text-right">
                                    <p class="text-xs font-bold mb-1">通知年月日：${dateVal}</p>
                                    <div class="inline-block mt-4 border-2 border-slate-300 p-4 text-slate-400 text-[10px] rounded-sm italic">
                                        （公印省略）
                                    </div>
                                    <p class="mt-2 text-sm font-black">日本年金機構</p>
                                </div>
                            </div>

                            <div class="text-center mb-16">
                                <h2 class="text-2xl font-bold tracking-widest border-b-2 border-double border-slate-800 inline-block pb-1">${analysis.title}</h2>
                            </div>

                            <!-- Common Fields Grid (Compact) -->
                            <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-10 bg-slate-50 p-4 rounded-lg border border-slate-100">
                                ${Object.entries(analysis.headers).filter(([k]) => !k.includes("通知年月日") && !k.includes("名称")).slice(0, 9).map(([k, v]) => `
                                    <div class="border-b border-slate-200 pb-1">
                                        <p class="text-[9px] font-black text-slate-400 uppercase truncate">${k.replace(/.*_/, '')}</p>
                                        <p class="text-xs font-bold text-slate-700 truncate">${v}</p>
                                    </div>
                                `).join('')}
                            </div>

                            <!-- Table Section -->
                            ${analysis.sections.map((section, sIdx) => `
                                <div class="mb-10">
                                    <h3 class="text-xs font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                                        <div class="w-1 h-3 bg-slate-900"></div> ${section.name}
                                    </h3>
                                    <div class="overflow-x-auto border border-slate-300 rounded-sm">
                                        <table class="w-full text-left border-collapse table-fixed min-w-[700px]">
                                            <thead class="bg-slate-50">
                                                <tr>
                                                    <th class="w-10 p-2 text-[10px] font-bold text-slate-500 border-r border-b border-slate-300 text-center">No</th>
                                                    ${section.headers?.map(h => `<th class="p-2 text-[10px] font-bold text-slate-500 border-r border-b border-slate-300 uppercase">${h.replace(/.*_/, '')}</th>`).join('')}
                                                    ${calculations && section.isTable ? `<th class="w-24 p-2 text-[10px] font-black text-blue-700 border-b border-slate-300 text-right bg-blue-50/30">本人負担</th>` : ''}
                                                </tr>
                                            </thead>
                                            <tbody class="divide-y divide-slate-200">
                                                ${section.data.map((row, rIdx) => `
                                                    <tr class="hover:bg-slate-50/50">
                                                        <td class="p-2 text-[10px] font-medium text-slate-400 border-r border-slate-200 text-center">${rIdx + 1}</td>
                                                        ${section.headers?.map(h => `<td class="p-2 text-xs font-bold text-slate-700 truncate border-r border-slate-100">${row[h] || '-'}</td>`).join('')}
                                                        ${calculations && section.isTable ? `
                                                            <td class="p-2 text-xs font-black text-right text-blue-600 bg-blue-50/10">
                                                                ¥${calculations[rIdx]?.toLocaleString()}
                                                            </td>
                                                        ` : ''}
                                                    </tr>
                                                `).join('')}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            `).join('')}

                            ${analysis.sections.length === 0 ? '<div class="text-center py-20 text-slate-300 font-bold border-2 border-dashed border-slate-100 rounded-xl">明細データは見つかりませんでした</div>' : ''}
                            
                            <div class="mt-auto pt-8 border-t border-slate-100 text-[9px] text-slate-400 flex justify-between">
                                <span>e-Gov XML Viewer Generated Document</span>
                                <span>Page 1 of 1</span>
                            </div>
                        </div>
                    ` : `
                        <div class="w-full max-w-[1000px] bg-slate-900 p-8 rounded-3xl shadow-2xl overflow-auto text-blue-300 font-mono text-[11px] h-[70vh] border border-slate-800">
                            ${currentFile.parsed ? renderTree(currentFile.parsed) : 'No data'}
                        </div>
                    `}
                </main>

                <!-- Floating Footer Tabs -->
                <div class="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center bg-white/80 backdrop-blur-md p-1.5 rounded-2xl shadow-2xl border border-white/50 z-50">
                    <button id="viewSummary" class="flex items-center gap-2 px-6 py-2 rounded-xl text-xs font-bold transition-all ${state.viewMode === 'summary' ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-500 hover:bg-slate-100'}">
                        <i data-lucide="file-text" size="14"></i> 公文書
                    </button>
                    <button id="viewTree" class="flex items-center gap-2 px-6 py-2 rounded-xl text-xs font-bold transition-all ${state.viewMode === 'tree' ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-500 hover:bg-slate-100'}">
                        <i data-lucide="code" size="14"></i> 構造
                    </button>
                </div>
            </div>
        `;
        attachEvents();
    }
    if ((window as any).lucide) (window as any).lucide.createIcons();
};

const renderTree = (node: XMLNode): string => {
    return `
        <div class="xml-node my-1">
            <span class="text-indigo-400 opacity-60">&lt;${node.name}&gt;</span>
            ${node.content ? `<span class="text-white ml-2 font-bold">${node.content}</span>` : ''}
            <div>${node.children.map(c => renderTree(c)).join('')}</div>
            <span class="text-indigo-400 opacity-60">&lt;/${node.name}&gt;</span>
        </div>
    `;
};

const handleFile = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    state.files = [];
    state.selectedFileIndex = -1;
    state.isLoading = true;
    render();
    try {
        if (file.name.toLowerCase().endsWith('.zip')) {
            const zipData = await file.arrayBuffer();
            const zip = await JSZip.loadAsync(zipData);
            const xmlFiles: AppFile[] = [];
            
            for (const filename of Object.keys(zip.files)) {
                if (filename.toLowerCase().endsWith('.xml')) {
                    const content = await zip.files[filename].async('string');
                    const parsed = parseXML(content);
                    xmlFiles.push({ 
                        name: filename, 
                        content, 
                        parsed, 
                        analysis: extractUniversalData(parsed) 
                    });
                }
            }
            state.files = xmlFiles;
        } else if (file.name.toLowerCase().endsWith('.xml')) {
            const content = await file.text();
            const parsed = parseXML(content);
            state.files = [{ name: file.name, content, parsed, analysis: extractUniversalData(parsed) }];
        }

        if (state.files.length === 0) {
            alert("XMLファイルが見つかりませんでした。");
        } else if (state.files.length === 1) {
            state.selectedFileIndex = 0;
        }
    } catch (err) {
        alert("ファイルの解析中にエラーが発生しました。");
        console.error(err);
    } finally {
        state.isLoading = false;
        render();
    }
};

const attachPickerEvents = () => {
    document.getElementById('resetBtn')?.addEventListener('click', () => { state.files = []; render(); });
    document.querySelectorAll('.select-file-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt((e.currentTarget as HTMLElement).dataset.index || "0");
            state.selectedFileIndex = index;
            render();
        });
    });
};

const attachEvents = () => {
    document.getElementById('backToPicker')?.addEventListener('click', () => { 
        state.selectedFileIndex = -1; 
        render(); 
    });
    document.getElementById('toggleSettings')?.addEventListener('click', () => { 
        state.showSettings = !state.showSettings; 
        render(); 
    });
    document.getElementById('viewSummary')?.addEventListener('click', () => { 
        state.viewMode = 'summary'; 
        render(); 
    });
    document.getElementById('viewTree')?.addEventListener('click', () => { 
        state.viewMode = 'tree'; 
        render(); 
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
