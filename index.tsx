
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
    selectedFileIndex: -1, // -1 means no file selected (show picker)
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

            sections.push({
                name: n.name,
                isTable: true,
                headers: Array.from(tableHeaders),
                data: rows
            });
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
        // --- Upload Screen ---
        root.innerHTML = `
            <div class="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-6">
                <div class="bg-white p-12 rounded-[3.5rem] shadow-2xl border border-slate-200 w-full max-w-2xl text-center">
                    <div class="bg-slate-900 w-24 h-24 rounded-3xl flex items-center justify-center mx-auto mb-10 text-white shadow-xl rotate-3">
                        <i data-lucide="folder-archive" size="48"></i>
                    </div>
                    <h2 class="text-4xl font-black mb-6 text-slate-900 tracking-tight">e-Gov ZIP / XML Reader</h2>
                    <p class="text-slate-500 mb-12 text-lg font-medium leading-relaxed">
                        e-GovからダウンロードしたZIPファイル、またはXMLファイルを読み込みます。<br>
                        複数の書類が含まれている場合も、選択して閲覧可能です。
                    </p>
                    <label class="group relative block w-full py-6 px-10 bg-blue-600 hover:bg-blue-700 text-white font-black text-xl rounded-2xl cursor-pointer transition-all shadow-xl active:scale-95">
                        <span class="flex items-center justify-center gap-3"><i data-lucide="upload-cloud"></i> ファイルを選択 (ZIP/XML)</span>
                        <input type="file" id="fileInput" class="hidden" accept=".xml,.zip" />
                    </label>
                </div>
            </div>
        `;
        document.getElementById('fileInput')?.addEventListener('change', handleFile);
    } else if (state.selectedFileIndex === -1) {
        // --- File Selection List (Picker) ---
        root.innerHTML = `
            <div class="min-h-screen bg-slate-50 flex flex-col p-8">
                <header class="max-w-5xl mx-auto w-full mb-12 flex justify-between items-center">
                    <div>
                        <h2 class="text-3xl font-black text-slate-900">書類の選択</h2>
                        <p class="text-slate-500 font-bold">ZIPファイル内に ${state.files.length} つのXMLファイルが見つかりました。</p>
                    </div>
                    <button id="resetBtn" class="bg-white text-slate-600 px-6 py-3 rounded-2xl font-black shadow-sm border hover:bg-slate-50 transition-all">別のZIPを選択</button>
                </header>
                <div class="max-w-5xl mx-auto w-full grid grid-cols-1 md:grid-cols-2 gap-6">
                    ${state.files.map((file, index) => `
                        <div class="bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-200 hover:border-blue-500 hover:shadow-2xl transition-all cursor-pointer group select-file-btn" data-index="${index}">
                            <div class="flex items-start gap-5">
                                <div class="bg-slate-100 p-4 rounded-2xl text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-600 transition-colors">
                                    <i data-lucide="file-text" size="32"></i>
                                </div>
                                <div class="flex-1">
                                    <h3 class="text-xl font-black text-slate-800 mb-1 break-all">${file.name}</h3>
                                    <p class="text-sm font-bold text-slate-400 uppercase tracking-widest">${file.analysis?.title || '書類名称不明'}</p>
                                    <div class="mt-6 flex items-center text-blue-600 font-black text-sm">
                                        内容を表示する <i data-lucide="arrow-right" size="16" class="ml-2"></i>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        attachPickerEvents();
    } else {
        // --- Document View ---
        const currentFile = state.files[state.selectedFileIndex];
        const analysis = currentFile.analysis;
        const calculations = analysis ? calculateIfPossible(analysis) : null;

        root.innerHTML = `
            <div class="min-h-screen flex flex-col bg-[#f8fafc]">
                <header class="bg-white border-b border-slate-200 px-8 py-4 sticky top-0 z-50 flex items-center justify-between shadow-sm">
                    <div class="flex items-center gap-4 cursor-pointer" id="backToPicker">
                        <div class="bg-slate-900 p-2 rounded-lg text-white"><i data-lucide="arrow-left" size="18"></i></div>
                        <div>
                            <h1 class="text-sm font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Back to list</h1>
                            <span class="text-lg font-black tracking-tighter">e-Gov Universal Viewer</span>
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        ${state.files.length > 1 ? `
                            <select id="fileSelector" class="bg-slate-100 border-none rounded-xl px-4 py-2 text-sm font-bold text-slate-700 outline-none">
                                ${state.files.map((f, i) => `<option value="${i}" ${i === state.selectedFileIndex ? 'selected' : ''}>${f.name}</option>`).join('')}
                            </select>
                        ` : ''}
                        <button id="toggleSettings" class="px-4 py-2 rounded-xl text-sm font-bold border ${state.showSettings ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200'}">
                            <i data-lucide="settings" size="16" class="inline mr-1"></i>計算設定
                        </button>
                    </div>
                </header>
                <main class="flex-1 max-w-[1400px] w-full mx-auto p-8">
                    ${state.showSettings ? `
                        <div class="mb-8 p-8 bg-white rounded-3xl shadow-xl border border-blue-100 grid grid-cols-1 md:grid-cols-3 gap-6 animate-in slide-in-from-top-2">
                            ${Object.entries(state.rates).map(([k, v]) => `
                                <div>
                                    <label class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">${k === 'health' ? '健康保険' : k === 'pension' ? '厚生年金' : '介護保険'} (%)</label>
                                    <input type="number" step="0.001" value="${v}" data-key="${k}" class="rate-input w-full p-4 bg-slate-50 border rounded-xl font-mono font-bold" />
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                    ${state.viewMode === 'summary' && analysis ? `
                        <div class="space-y-8">
                            <div class="bg-white rounded-[2.5rem] shadow-xl border border-slate-200 overflow-hidden">
                                <div class="bg-slate-900 p-8 text-white flex items-center justify-between">
                                    <div><h2 class="text-2xl font-black">${analysis.title}</h2></div>
                                    <div class="bg-white/10 px-4 py-2 rounded-xl text-xs font-bold">${currentFile.name}</div>
                                </div>
                                <div class="p-8 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 bg-slate-50/50">
                                    ${Object.entries(analysis.headers).map(([k, v]) => `
                                        <div class="bg-white p-4 rounded-xl border border-slate-100 shadow-sm">
                                            <p class="text-[9px] font-black text-slate-400 uppercase tracking-tighter mb-1">${k.replace(/_/g, ' ')}</p>
                                            <p class="text-sm font-bold text-slate-800 break-all">${v}</p>
                                        </div>
                                    `).join('')}
                                    ${Object.keys(analysis.headers).length === 0 ? '<p class="col-span-full text-slate-400 italic text-sm">共通情報は検出されませんでした。</p>' : ''}
                                </div>
                            </div>
                            ${analysis.sections.map((section, sIdx) => `
                                <div class="bg-white rounded-[2.5rem] shadow-xl border border-slate-200 overflow-hidden">
                                    <div class="p-6 border-b bg-slate-50/30 flex items-center gap-3">
                                        <div class="w-1.5 h-6 bg-blue-600 rounded-full"></div>
                                        <h3 class="text-lg font-black text-slate-800">${section.name} リスト</h3>
                                    </div>
                                    <div class="overflow-x-auto">
                                        <table class="w-full text-left whitespace-nowrap">
                                            <thead class="bg-slate-50">
                                                <tr>
                                                    ${section.headers?.map(h => `<th class="p-4 text-[10px] font-black text-slate-400 uppercase tracking-tighter border-b">${h.replace(/.*_/, '')}</th>`).join('')}
                                                    ${calculations && section.isTable ? `<th class="p-4 text-[10px] font-black text-blue-600 border-b text-right">本人負担額</th>` : ''}
                                                </tr>
                                            </thead>
                                            <tbody class="divide-y divide-slate-100">
                                                ${section.data.map((row, rIdx) => `
                                                    <tr class="hover:bg-blue-50/10 transition-colors">
                                                        ${section.headers?.map(h => `<td class="p-4 text-sm font-medium text-slate-600">${row[h] || '-'}</td>`).join('')}
                                                        ${calculations && section.isTable ? `<td class="p-4 text-sm font-black text-right text-blue-700 bg-blue-50/10">¥${calculations[rIdx]?.toLocaleString()}</td>` : ''}
                                                    </tr>
                                                `).join('')}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            `).join('')}
                            ${analysis.sections.length === 0 ? '<div class="text-center py-20 bg-white rounded-[2.5rem] border-2 border-dashed border-slate-200 text-slate-400 font-bold">明細データは検出されませんでした。</div>' : ''}
                        </div>
                    ` : `
                        <div class="bg-slate-900 p-10 rounded-[3rem] shadow-2xl overflow-auto text-blue-200 font-mono text-xs max-h-[80vh]">
                            ${currentFile.parsed ? renderTree(currentFile.parsed) : 'No data'}
                        </div>
                    `}
                </main>
                <div class="fixed bottom-8 right-8 flex gap-2">
                    <button id="viewSummary" class="px-6 py-3 rounded-2xl font-black text-sm shadow-2xl transition-all ${state.viewMode === 'summary' ? 'bg-blue-600 text-white scale-110' : 'bg-white text-slate-600'}">帳票表示</button>
                    <button id="viewTree" class="px-6 py-3 rounded-2xl font-black text-sm shadow-2xl transition-all ${state.viewMode === 'tree' ? 'bg-blue-600 text-white scale-110' : 'bg-white text-slate-600'}">Raw構造</button>
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
            <span class="text-indigo-400">&lt;${node.name}&gt;</span>
            ${node.content ? `<span class="text-white ml-2">${node.content}</span>` : ''}
            <div>${node.children.map(c => renderTree(c)).join('')}</div>
            <span class="text-indigo-400">&lt;/${node.name}&gt;</span>
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
            state.selectedFileIndex = 0; // Only one file, select it directly
        }
        if (state.files.length === 0) alert("XMLファイルが見つかりませんでした。");
        else if (state.files.length === 1) state.selectedFileIndex = 0;
    } catch (err) {
        alert("エラーが発生しました。");
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
        if (state.files.length > 1) {
            state.selectedFileIndex = -1; 
        } else {
            state.files = [];
        }
        render(); 
    });
    document.getElementById('toggleSettings')?.addEventListener('click', () => { state.showSettings = !state.showSettings; render(); });
    document.getElementById('viewSummary')?.addEventListener('click', () => { state.viewMode = 'summary'; render(); });
    document.getElementById('viewTree')?.addEventListener('click', () => { state.viewMode = 'tree'; render(); });
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
