
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
    return { title: node.name, headers, sections };
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
            <div class="min-h-screen flex items-center justify-center bg-slate-100 p-4">
                <div class="bg-white p-10 rounded-2xl shadow-lg border border-slate-200 w-full max-w-lg text-center">
                    <div class="bg-slate-900 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6 text-white">
                        <i data-lucide="upload" size="32"></i>
                    </div>
                    <h2 class="text-2xl font-bold mb-2 text-slate-800 tracking-tight">e-Gov XML Viewer</h2>
                    <p class="text-slate-500 mb-8 text-sm">ZIPまたはXMLファイルを選択してください。</p>
                    <label class="block w-full py-4 px-6 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl cursor-pointer transition-all active:scale-95">
                        ファイルを選択
                        <input type="file" id="fileInput" class="hidden" accept=".xml,.zip" />
                    </label>
                </div>
            </div>
        `;
        document.getElementById('fileInput')?.addEventListener('change', handleFile);
    } else if (state.selectedFileIndex === -1) {
        root.innerHTML = `
            <div class="min-h-screen bg-slate-50 flex flex-col items-center py-12 px-4">
                <div class="w-full max-w-3xl">
                    <div class="flex items-center justify-between mb-8">
                        <div>
                            <h2 class="text-xl font-bold text-slate-900">含まれる書類一覧</h2>
                            <p class="text-xs text-slate-500 font-medium">読み込む書類を選択してください (${state.files.length}件)</p>
                        </div>
                        <button id="resetBtn" class="text-xs bg-white text-slate-600 px-4 py-2 rounded-lg font-bold border hover:bg-slate-50">別のZIPを選択</button>
                    </div>
                    <div class="space-y-3">
                        ${state.files.map((file, index) => `
                            <div class="bg-white p-4 rounded-xl shadow-sm border border-slate-200 hover:border-blue-500 transition-all cursor-pointer flex items-center gap-4 select-file-btn" data-index="${index}">
                                <div class="bg-slate-100 p-2 rounded-lg text-slate-400"><i data-lucide="file-text" size="20"></i></div>
                                <div class="flex-1 min-w-0">
                                    <h3 class="text-sm font-bold text-slate-800 truncate">${file.name}</h3>
                                    <p class="text-[10px] text-slate-400 font-black uppercase tracking-wider">${file.analysis?.title || 'Unknown'}</p>
                                </div>
                                <i data-lucide="chevron-right" size="18" class="text-slate-300"></i>
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

        root.innerHTML = `
            <div class="min-h-screen flex flex-col bg-white">
                <header class="bg-slate-900 text-white px-6 py-3 flex items-center justify-between sticky top-0 z-50">
                    <div class="flex items-center gap-4">
                        <button id="backToPicker" class="hover:bg-white/10 p-1.5 rounded-lg transition-colors"><i data-lucide="chevron-left" size="20"></i></button>
                        <h1 class="text-sm font-bold tracking-tight truncate max-w-[200px] md:max-w-none">${currentFile.name}</h1>
                    </div>
                    <div class="flex items-center gap-2">
                        ${state.files.length > 1 ? `
                            <select id="fileSelector" class="bg-white/10 border-none rounded-lg px-3 py-1.5 text-xs font-bold text-white outline-none focus:bg-white/20">
                                ${state.files.map((f, i) => `<option value="${i}" ${i === state.selectedFileIndex ? 'selected' : ''} class="text-slate-900">${f.name}</option>`).join('')}
                            </select>
                        ` : ''}
                        <button id="toggleSettings" class="p-2 hover:bg-white/10 rounded-lg transition-colors"><i data-lucide="settings" size="18"></i></button>
                    </div>
                </header>

                <main class="flex-1 p-4 md:p-6 max-w-[1600px] mx-auto w-full">
                    ${state.showSettings ? `
                        <div class="mb-6 p-4 bg-slate-50 rounded-xl border border-slate-200 grid grid-cols-1 md:grid-cols-3 gap-4 animate-in fade-in duration-200">
                            ${Object.entries(state.rates).map(([k, v]) => `
                                <div>
                                    <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">${k === 'health' ? '健康' : k === 'pension' ? '年金' : '介護'}料率 (%)</label>
                                    <input type="number" step="0.01" value="${v}" data-key="${k}" class="rate-input w-full p-2 bg-white border border-slate-200 rounded text-sm font-bold" />
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}

                    ${state.viewMode === 'summary' && analysis ? `
                        <div class="space-y-6">
                            <!-- Compact Header Grid -->
                            <div class="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                                <div class="bg-slate-50 px-4 py-2 border-b"><h2 class="text-xs font-black text-slate-500 uppercase tracking-widest">共通情報 / ${analysis.title}</h2></div>
                                <div class="p-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-x-6 gap-y-3">
                                    ${Object.entries(analysis.headers).map(([k, v]) => `
                                        <div>
                                            <p class="text-[9px] font-bold text-slate-400 uppercase truncate">${k.replace(/.*_/, '')}</p>
                                            <p class="text-xs font-bold text-slate-800 break-all">${v}</p>
                                        </div>
                                    `).join('')}
                                    ${Object.keys(analysis.headers).length === 0 ? '<p class="col-span-full text-slate-400 italic text-[10px]">共通情報は検出されませんでした。</p>' : ''}
                                </div>
                            </div>

                            <!-- List Sections -->
                            ${analysis.sections.map((section, sIdx) => `
                                <div class="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                                    <div class="bg-slate-50 px-4 py-2 border-b flex items-center justify-between">
                                        <h3 class="text-xs font-black text-slate-500 uppercase tracking-widest">${section.name} リスト</h3>
                                        <span class="text-[10px] bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full font-bold">${section.data.length}件</span>
                                    </div>
                                    <div class="overflow-x-auto">
                                        <table class="w-full text-left whitespace-nowrap table-fixed min-w-[800px]">
                                            <thead class="bg-slate-50/50">
                                                <tr>
                                                    <th class="w-12 p-3 text-[10px] font-bold text-slate-400 border-b text-center">No</th>
                                                    ${section.headers?.map(h => `<th class="p-3 text-[10px] font-bold text-slate-400 border-b uppercase">${h.replace(/.*_/, '')}</th>`).join('')}
                                                    ${calculations && section.isTable ? `<th class="w-32 p-3 text-[10px] font-bold text-blue-600 border-b text-right bg-blue-50/30">概算本人負担</th>` : ''}
                                                </tr>
                                            </thead>
                                            <tbody class="divide-y divide-slate-100">
                                                ${section.data.map((row, rIdx) => `
                                                    <tr class="hover:bg-slate-50 transition-colors">
                                                        <td class="p-3 text-[10px] font-bold text-slate-300 text-center">${rIdx + 1}</td>
                                                        ${section.headers?.map(h => `<td class="p-3 text-xs font-medium text-slate-700 truncate">${row[h] || '-'}</td>`).join('')}
                                                        ${calculations && section.isTable ? `
                                                            <td class="p-3 text-xs font-bold text-right text-blue-600 bg-blue-50/20">
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
                        </div>
                    ` : `
                        <div class="bg-slate-900 p-6 rounded-xl shadow-inner overflow-auto text-blue-300 font-mono text-[11px] h-[calc(100vh-140px)] border border-slate-800">
                            ${currentFile.parsed ? renderTree(currentFile.parsed) : 'No data'}
                        </div>
                    `}
                </main>

                <footer class="bg-slate-50 border-t border-slate-200 p-2 flex justify-center gap-1 fixed bottom-0 left-0 right-0">
                    <button id="viewSummary" class="px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${state.viewMode === 'summary' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-200'}">書類表示</button>
                    <button id="viewTree" class="px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${state.viewMode === 'tree' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-200'}">Raw構造</button>
                </footer>
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

const handleFile = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    state.files = [];
    state.selectedFileIndex = -1;
    state.isLoading = true;
    render();
    try {
        if (file.name.endsWith('.zip')) {
            const zipData = await file.arrayBuffer();
            const zip = await JSZip.loadAsync(zipData);
            for (const filename of Object.keys(zip.files)) {
                if (filename.toLowerCase().endsWith('.xml')) {
                    const content = await zip.files[filename].async('string');
                    const parsed = parseXML(content);
                    state.files.push({ name: filename, content, parsed, analysis: extractUniversalData(parsed) });
                }
            }
        } else if (file.name.toLowerCase().endsWith('.xml')) {
            const content = await file.text();
            const parsed = parseXML(content);
            state.files.push({ name: file.name, content, parsed, analysis: extractUniversalData(parsed) });
            state.selectedFileIndex = 0;
        }
        if (state.files.length === 0) alert("XMLファイルが見つかりませんでした。");
        else if (state.files.length === 1) state.selectedFileIndex = 0;
    } catch (err) {
        alert("ファイルの解析に失敗しました。");
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
    document.getElementById('fileSelector')?.addEventListener('change', (e) => {
        state.selectedFileIndex = parseInt((e.target as HTMLSelectElement).value);
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
