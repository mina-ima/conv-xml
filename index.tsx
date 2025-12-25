
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
    const officeInfo: Record<string, string> = {};
    const sections: UniversalData['sections'] = [];
    let arrivalNumber = "";

    const processNode = (n: XMLNode, path: string = "") => {
        // Find arrival number
        if (n.name.includes("到達番号")) arrivalNumber = n.content || "";
        
        // Categorize office info
        if (["事業所整理記号", "事業所番号", "所在地", "事業所名称"].some(k => n.name.includes(k))) {
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
    
    // Attempt to define a friendly title if the root is cryptic
    let title = node.name;
    if (title.includes("Kokuho") || title.includes("S00")) {
        title = "健康保険・厚生年金保険 被保険者標準報酬決定通知書";
    }

    return { title, arrivalNumber, officeInfo, headers, sections };
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
                <div class="bg-white p-12 rounded-[2rem] shadow-2xl border border-slate-200 w-full max-w-lg text-center">
                    <div class="bg-slate-900 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-8 text-white shadow-xl">
                        <i data-lucide="file-up" size="32"></i>
                    </div>
                    <h2 class="text-2xl font-black mb-2 text-slate-800 tracking-tighter">e-Gov通知書ビューア</h2>
                    <p class="text-slate-500 mb-10 text-sm font-medium">ZIPまたはXMLをドラッグ＆ドロップしてください。</p>
                    <label class="block w-full py-5 px-6 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-2xl cursor-pointer transition-all active:scale-95 shadow-lg">
                        ファイルを選択
                        <input type="file" id="fileInput" class="hidden" accept=".xml,.zip" />
                    </label>
                </div>
            </div>
        `;
        document.getElementById('fileInput')?.addEventListener('change', handleFile);
    } else if (state.selectedFileIndex === -1) {
        root.innerHTML = `
            <div class="min-h-screen bg-slate-50 flex flex-col items-center py-16 px-4">
                <div class="w-full max-w-2xl">
                    <div class="flex items-center justify-between mb-10">
                        <h2 class="text-2xl font-black text-slate-900">案件フォルダ内書類</h2>
                        <button id="resetBtn" class="text-xs font-black bg-white text-slate-600 px-5 py-2.5 rounded-xl border hover:bg-slate-50 shadow-sm transition-all">別のZIPを開く</button>
                    </div>
                    <div class="grid gap-3">
                        ${state.files.map((file, index) => `
                            <button class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 hover:border-blue-500 hover:shadow-md transition-all flex items-center gap-4 text-left select-file-btn" data-index="${index}">
                                <div class="bg-blue-50 p-3 rounded-xl text-blue-600"><i data-lucide="file-text" size="24"></i></div>
                                <div class="flex-1 min-w-0">
                                    <h3 class="text-sm font-black text-slate-800 truncate mb-0.5">${file.name}</h3>
                                    <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest">${file.analysis?.title || '書類名称なし'}</p>
                                </div>
                                <i data-lucide="arrow-right" size="18" class="text-slate-300"></i>
                            </button>
                        `).join('')}
                    </div>
                </div>
            </div>
        `;
        attachPickerEvents();
    } else {
        const currentFile = state.files[state.selectedFileIndex];
        const data = currentFile.analysis;
        const calculations = data ? calculateIfPossible(data) : null;

        if (state.viewMode === 'summary' && data) {
            root.innerHTML = `
                <div class="min-h-screen bg-slate-200 flex flex-col overflow-y-auto">
                    <!-- Global Toolbar -->
                    <header class="bg-slate-900/90 backdrop-blur-md text-white px-6 py-3 flex items-center justify-between sticky top-0 z-[100] shadow-xl">
                        <div class="flex items-center gap-5">
                            <button id="backToPicker" class="hover:bg-white/10 p-2 rounded-xl transition-colors"><i data-lucide="arrow-left" size="20"></i></button>
                            <span class="text-xs font-black tracking-widest opacity-40">DIGITAL DOCUMENT VIEW</span>
                        </div>
                        <div class="flex items-center gap-3">
                             <button id="toggleSettings" class="flex items-center gap-2 px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-bold transition-all">
                                <i data-lucide="settings" size="14"></i> 保険料率
                            </button>
                            <button id="viewTree" class="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-bold">XML構造</button>
                        </div>
                    </header>

                    <!-- Document Area -->
                    <div class="flex-1 p-4 md:p-12 flex justify-center pb-24">
                        <div class="bg-white shadow-2xl w-full max-w-[900px] min-h-[1200px] p-10 md:p-16 text-slate-800 relative border border-slate-300">
                            
                            <!-- Document Header -->
                            <div class="flex justify-between items-start mb-16">
                                <div class="space-y-4">
                                    <div class="text-[14px] leading-relaxed">
                                        <p class="font-bold">${data.headers["所在地"] || data.officeInfo["所在地"] || ""}</p>
                                        <p class="text-xl font-bold mt-1">${data.headers["事業所名称"] || data.officeInfo["事業所名称"] || ""}</p>
                                        <p class="text-xl font-bold mt-4">${data.headers["氏名"] || data.headers["代表者名"] || ""}　様</p>
                                    </div>
                                </div>
                                <div class="text-right">
                                    <p class="text-[11px] font-bold text-slate-400">到達番号 ${data.arrivalNumber || '---'}</p>
                                </div>
                            </div>

                            <!-- Big Title -->
                            <div class="text-center mb-12">
                                <h1 class="text-2xl font-bold border-b-2 border-slate-800 inline-block pb-1 px-8">
                                    ${data.title}
                                </h1>
                            </div>

                            <!-- Office Summary -->
                            <div class="mb-12 flex gap-10">
                                <div>
                                    <span class="text-[11px] font-bold text-slate-400 block mb-1">事業所整理記号</span>
                                    <span class="text-lg font-mono font-bold">${data.officeInfo["事業所整理記号"] || "---"}</span>
                                </div>
                                <div>
                                    <span class="text-[11px] font-bold text-slate-400 block mb-1">事業所番号</span>
                                    <span class="text-lg font-mono font-bold">${data.officeInfo["事業所番号"] || "---"}</span>
                                </div>
                            </div>

                            <!-- Main Table Sections -->
                            ${data.sections.map((section, sIdx) => `
                                <div class="mb-10 overflow-x-auto">
                                    <table class="w-full border-collapse border-[1.5px] border-slate-900 text-[12px]">
                                        <thead>
                                            <tr class="bg-slate-50">
                                                <th rowspan="2" class="border border-slate-900 p-2 w-16 text-center font-bold">整理番号</th>
                                                <th rowspan="2" class="border border-slate-900 p-2 font-bold text-center">被保険者氏名</th>
                                                <th rowspan="2" class="border border-slate-900 p-2 w-20 text-center font-bold">適用年月</th>
                                                <th colspan="2" class="border border-slate-900 p-1 text-center font-bold">決定後の標準報酬月額</th>
                                                <th rowspan="2" class="border border-slate-900 p-2 w-24 text-center font-bold">生年月日</th>
                                                <th rowspan="2" class="border border-slate-900 p-2 w-16 text-center font-bold">種別</th>
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
                                                    <tr>
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

                            <!-- Footer Notes -->
                            <div class="mt-20 text-[11px] space-y-2 text-slate-500 font-medium leading-relaxed border-t pt-8">
                                <p>※1 元号　S：昭和　H：平成　R：令和</p>
                                <p>※2 種別　第一種：男性　第二種：女性　第三種：坑内員　等</p>
                                <p>上記の通り標準報酬が決定されたので通知します。</p>
                                <div class="pt-10 flex justify-between items-end">
                                    <div>
                                        <p class="text-sm font-bold text-slate-800">日本年金機構 理事長</p>
                                    </div>
                                    <div class="text-right">
                                        <p class="text-slate-400">作成日時: ${new Date().toLocaleDateString('ja-JP', {year: 'numeric', month: 'long', day: 'numeric'})}</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Floating Settings Overlay -->
                    ${state.showSettings ? `
                        <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[200] flex items-center justify-center p-6">
                            <div class="bg-white rounded-3xl shadow-2xl p-8 max-w-sm w-full animate-in zoom-in duration-200">
                                <h3 class="text-lg font-black mb-6 flex items-center gap-2"><i data-lucide="calculator"></i> 保険料率設定 (%)</h3>
                                <div class="space-y-4">
                                    ${Object.entries(state.rates).map(([k, v]) => `
                                        <div>
                                            <label class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">${k === 'health' ? '健康保険' : k === 'pension' ? '厚生年金' : '介護保険'}</label>
                                            <input type="number" step="0.001" value="${v}" data-key="${k}" class="rate-input w-full p-4 bg-slate-100 border-none rounded-2xl font-black text-slate-700" />
                                        </div>
                                    `).join('')}
                                </div>
                                <button id="closeSettings" class="w-full mt-8 py-4 bg-slate-900 text-white font-black rounded-2xl hover:bg-slate-800 transition-all">完了</button>
                            </div>
                        </div>
                    ` : ''}
                </div>
            `;
            attachEvents();
        } else {
            // Tree View
            root.innerHTML = `
                <div class="min-h-screen bg-slate-900 text-blue-100 flex flex-col">
                    <header class="p-6 border-b border-white/10 flex justify-between items-center">
                        <h2 class="font-mono text-sm">XML SOURCE TREE</h2>
                        <button id="viewSummary" class="bg-blue-600 text-white px-4 py-2 rounded-xl text-xs font-black">書類表示に戻る</button>
                    </header>
                    <main class="flex-1 p-8 overflow-auto font-mono text-xs leading-relaxed">
                        ${currentFile.parsed ? renderTree(currentFile.parsed) : 'No data'}
                    </main>
                </div>
            `;
            document.getElementById('viewSummary')?.addEventListener('click', () => { state.viewMode = 'summary'; render(); });
        }
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
    document.getElementById('closeSettings')?.addEventListener('click', () => {
        state.showSettings = false;
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
