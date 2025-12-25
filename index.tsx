
import { GoogleGenAI, Type } from "@google/genai";

// --- Types ---
interface XMLNode {
    name: string;
    attributes: Record<string, string>;
    content?: string;
    children: XMLNode[];
}

interface AnalysisResult {
    title: string;
    commonInfo: Record<string, string>;
    tableData?: {
        headers: string[];
        rows: string[][];
    };
}

// --- App State ---
const state = {
    xmlContent: null as string | null,
    parsedNode: null as XMLNode | null,
    analysis: null as AnalysisResult | null,
    isLoading: false,
    viewMode: 'summary' as 'summary' | 'tree',
    showSettings: false,
    rates: {
        health: 9.98,
        pension: 18.3,
        nursing: 1.60
    }
};

// --- XML Parser (Core) ---
const parseXML = (xmlString: string): XMLNode => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "text/xml");
    const parseError = xmlDoc.getElementsByTagName("parsererror");
    if (parseError.length > 0) throw new Error("XMLの解析に失敗しました。");

    const traverse = (element: Element): XMLNode => {
        const attributes: Record<string, string> = {};
        for (let i = 0; i < element.attributes.length; i++) {
            const attr = element.attributes[i];
            attributes[attr.name] = attr.value;
        }
        const children: XMLNode[] = [];
        Array.from(element.childNodes).forEach(child => {
            if (child.nodeType === Node.ELEMENT_NODE) {
                children.push(traverse(child as Element));
            }
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

/**
 * e-GovのXMLから共通情報と明細情報を分離して抽出する
 */
const localExtractData = (node: XMLNode): AnalysisResult => {
    const commonInfo: Record<string, string> = {};
    let bestRows: any[] = [];
    let bestHeaderSet = new Set<string>();
    let maxTableScore = 0;

    // 1. 全てのノードを走査して、全項目の出現頻度を記録
    const allLeaves: Record<string, string[]> = {};
    const collectAll = (n: XMLNode) => {
        if (n.children.length === 0 && n.content) {
            if (!allLeaves[n.name]) allLeaves[n.name] = [];
            allLeaves[n.name].push(n.content);
        }
        n.children.forEach(collectAll);
    };
    collectAll(node);

    // 2. 表（明細）となる部分を特定（複数回繰り返されるタグを優先）
    const findTable = (n: XMLNode) => {
        if (n.children.length >= 1) {
            const counts: Record<string, number> = {};
            n.children.forEach(c => { counts[c.name] = (counts[c.name] || 0) + 1; });

            for (const [tagName, count] of Object.entries(counts)) {
                // 1回以上出現するものを候補とするが、複数回を優先的に評価
                const currentRows: any[] = [];
                const currentHeaderSet = new Set<string>();
                const targets = n.children.filter(c => c.name === tagName);

                targets.forEach(record => {
                    const rowData: Record<string, string> = {};
                    const flatten = (fn: XMLNode, prefix = "") => {
                        if (fn.children.length === 0) {
                            const key = prefix + fn.name;
                            rowData[key] = fn.content || "";
                            currentHeaderSet.add(key);
                        } else {
                            fn.children.forEach(c => flatten(c, fn.name + "_"));
                        }
                    };
                    flatten(record);
                    if (Object.keys(rowData).length > 0) currentRows.push(rowData);
                });

                // スコア計算：行数 × 項目数
                const score = currentRows.length * currentHeaderSet.size;
                if (score > maxTableScore) {
                    maxTableScore = score;
                    bestRows = currentRows;
                    bestHeaderSet = currentHeaderSet;
                }
            }
        }
        n.children.forEach(findTable);
    };
    findTable(node);

    // 3. 表に含まれない、1回しか出てこない項目を「共通情報」とする
    for (const [key, values] of Object.entries(allLeaves)) {
        if (values.length === 1 && !bestHeaderSet.has(key)) {
            // 長すぎる値やタイトルっぽいものは除外して共通情報へ
            if (values[0].length < 100) {
                commonInfo[key] = values[0];
            }
        }
    }

    const headers = Array.from(bestHeaderSet);
    const formattedRows = bestRows.map(r => headers.map(h => r[h] || ""));

    // タイトルの決定（XMLタグ名や共通情報から推測）
    let title = "e-Gov 通知書";
    if (node.name.includes("通知書")) title = node.name;
    const possibleTitles = ["タイトル", "帳票名", "DocumentTitle"];
    for(const t of possibleTitles) if(commonInfo[t]) { title = commonInfo[t]; delete commonInfo[t]; }

    return {
        title,
        commonInfo,
        tableData: {
            headers: headers.map(h => h.replace(/.*_/, "")), // 表示用にネストを解消
            rows: formattedRows
        }
    };
};

// --- Premium Calculator ---
const calculatePremiums = () => {
    if (!state.analysis?.tableData) return [];
    const { headers, rows } = state.analysis.tableData;
    
    // キーワードによるカラムの特定
    const findIdx = (keywords: string[]) => headers.findIndex(h => keywords.some(k => h.includes(k)));
    
    const hIdx = findIdx(["健保", "健康保険", "標準額", "標準報酬", "賞与額"]);
    const pIdx = findIdx(["厚年", "厚生年金"]);
    const bIdx = findIdx(["生年月日", "生年"]);

    return rows.map(row => {
        const parseValue = (val: string) => {
            if (!val) return 0;
            let num = parseInt(val.replace(/[^0-9]/g, '')) || 0;
            if (val.includes('千円')) num *= 1000;
            return num;
        };

        const healthAmount = parseValue(row[hIdx]);
        const pensionAmount = parseValue(row[pIdx]);
        
        const birthStr = row[bIdx] || "";
        // 40歳以上介護保険対象判定
        const isNursing = birthStr.includes("S") || birthStr.includes("19") || (birthStr.includes("H") && parseInt(birthStr.replace(/[^0-9]/g, '')) < 10);

        const healthPremium = Math.floor((healthAmount * (state.rates.health / 100)) / 2);
        const pensionPremium = Math.floor((pensionAmount * (state.rates.pension / 100)) / 2);
        const nursingPremium = isNursing ? Math.floor((healthAmount * (state.rates.nursing / 100)) / 2) : 0;
        
        return {
            original: row,
            total: healthPremium + pensionPremium + nursingPremium
        };
    });
};

// --- UI Renderer ---
const render = () => {
    const root = document.getElementById('root');
    if (!root) return;

    if (!state.xmlContent) {
        root.innerHTML = `
            <div class="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-4">
                <div class="bg-white p-12 rounded-[3.5rem] shadow-2xl border border-slate-200 w-full max-w-2xl text-center">
                    <div class="bg-gradient-to-br from-blue-600 to-indigo-700 w-24 h-24 rounded-[2.2rem] flex items-center justify-center mx-auto mb-10 text-white shadow-xl rotate-3">
                        <i data-lucide="file-digit" size="48"></i>
                    </div>
                    <h2 class="text-4xl font-black mb-6 text-slate-900 tracking-tight">e-Gov XML 閲覧・計算</h2>
                    <p class="text-slate-500 mb-12 text-lg font-medium leading-relaxed px-4">
                        ダウンロードした通知書XMLを読み込みます。<br>
                        共通情報を自動抽出し、保険料の本人負担額を即座に計算します。
                    </p>
                    <label class="group relative block w-full py-6 px-10 bg-slate-900 hover:bg-blue-600 text-white font-black text-xl rounded-2xl cursor-pointer transition-all shadow-2xl active:scale-95 overflow-hidden">
                        <span class="relative z-10 flex items-center justify-center gap-3">
                            <i data-lucide="upload" size="24"></i>
                            ファイルを選択する
                        </span>
                        <div class="absolute inset-0 bg-gradient-to-r from-blue-600 to-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        <input type="file" id="fileInput" class="hidden" accept=".xml" />
                    </label>
                    <p class="mt-8 text-xs text-slate-400 font-bold uppercase tracking-widest">Supports Standard Bonus & Remuneration XML</p>
                </div>
            </div>
        `;
        document.getElementById('fileInput')?.addEventListener('change', handleFile);
    } else {
        const results = calculatePremiums();
        root.innerHTML = `
            <div class="min-h-screen flex flex-col bg-[#fdfdfd]">
                <header class="bg-white/80 backdrop-blur-md border-b border-slate-100 px-8 py-5 sticky top-0 z-50">
                    <div class="max-w-[1400px] mx-auto flex items-center justify-between">
                        <div class="flex items-center gap-4 cursor-pointer group" id="resetBtn">
                            <div class="bg-slate-900 p-2.5 rounded-xl text-white group-hover:bg-blue-600 transition-colors shadow-lg">
                                <i data-lucide="chevron-left" size="20"></i>
                            </div>
                            <div>
                                <h1 class="text-xl font-black tracking-tighter text-slate-900">e-Gov XML Reader</h1>
                                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Professional Version</p>
                            </div>
                        </div>
                        <div class="flex items-center gap-4">
                            <button id="toggleSettings" class="px-5 py-2.5 rounded-xl text-sm font-black border transition-all ${state.showSettings ? 'bg-blue-600 text-white border-blue-600 shadow-blue-200 shadow-lg' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400 shadow-sm'}">
                                <i data-lucide="percent" size="16" class="inline mr-2"></i>料率設定
                            </button>
                            <div class="h-6 w-px bg-slate-200"></div>
                            <div class="flex gap-1 bg-slate-100 p-1.5 rounded-2xl">
                                <button id="viewSummary" class="px-6 py-2 rounded-xl text-xs font-black transition-all ${state.viewMode === 'summary' ? 'bg-white text-blue-600 shadow-md' : 'text-slate-500 hover:text-slate-800'}">帳票表示</button>
                                <button id="viewTree" class="px-6 py-2 rounded-xl text-xs font-black transition-all ${state.viewMode === 'tree' ? 'bg-white text-blue-600 shadow-md' : 'text-slate-500 hover:text-slate-800'}">構造確認</button>
                            </div>
                        </div>
                    </div>
                </header>

                <main class="flex-1 max-w-[1400px] w-full mx-auto p-10">
                    ${state.showSettings ? `
                        <div class="mb-12 p-10 bg-white rounded-[2rem] border-2 border-blue-50 shadow-2xl animate-in zoom-in-95 duration-300">
                            <div class="flex items-center gap-3 mb-8">
                                <div class="w-2 h-8 bg-blue-600 rounded-full"></div>
                                <h3 class="text-xl font-black text-slate-900">健康保険・厚生年金保険料率設定</h3>
                            </div>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-10">
                                ${Object.entries(state.rates).map(([key, val]) => `
                                    <div class="space-y-3">
                                        <label class="block text-xs font-black text-slate-400 uppercase tracking-widest ml-1">
                                            ${key === 'health' ? '健康保険 (%)' : key === 'pension' ? '厚生年金 (%)' : '介護保険 (%)'}
                                        </label>
                                        <div class="relative">
                                            <input type="number" step="0.001" value="${val}" data-key="${key}" class="rate-input w-full p-5 bg-slate-50 border-2 border-transparent focus:border-blue-500 focus:bg-white rounded-2xl font-mono text-2xl font-black text-slate-900 outline-none transition-all" />
                                            <span class="absolute right-5 top-1/2 -translate-y-1/2 text-slate-300 font-black text-xl">%</span>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                            <p class="mt-6 text-[11px] font-bold text-slate-400 bg-slate-50 p-4 rounded-xl">※各料率を1/2した額（本人負担分）として計算します。設定値は保存されません。</p>
                        </div>
                    ` : ''}

                    ${state.viewMode === 'summary' ? `
                        <div class="bg-white rounded-[3rem] shadow-2xl border border-slate-100 overflow-hidden">
                            <!-- Title Area -->
                            <div class="p-12 text-center border-b border-slate-50">
                                <h2 class="text-3xl font-black text-slate-900 mb-2">${state.analysis?.title || '通知書'}</h2>
                                <div class="w-24 h-1.5 bg-blue-600 mx-auto rounded-full"></div>
                            </div>

                            <!-- Common Info Cards (固定項目をここに表示) -->
                            <div class="p-8 bg-slate-50/50 border-b border-slate-100 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                                ${Object.entries(state.analysis?.commonInfo || {}).map(([key, val]) => `
                                    <div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
                                        <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">${key}</p>
                                        <p class="text-base font-bold text-slate-800">${val}</p>
                                    </div>
                                `).join('')}
                                ${Object.keys(state.analysis?.commonInfo || {}).length === 0 ? '<p class="col-span-full text-center text-slate-400 text-sm italic py-4">共通情報は検出されませんでした。</p>' : ''}
                            </div>

                            <!-- Table Area (明細のみを表示) -->
                            <div class="overflow-x-auto">
                                <table class="w-full text-left whitespace-nowrap">
                                    <thead>
                                        <tr class="bg-slate-900 text-white">
                                            ${state.analysis?.tableData?.headers.map(h => `
                                                <th class="p-6 text-[11px] font-black uppercase tracking-widest">${h}</th>
                                            `).join('') || ''}
                                            <th class="p-6 text-[11px] font-black uppercase tracking-widest bg-blue-600 text-right sticky right-0">概算本人負担額</th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y divide-slate-100">
                                        ${results.map(r => `
                                            <tr class="hover:bg-blue-50/10 transition-colors group">
                                                ${r.original.map(cell => `<td class="p-6 text-sm text-slate-700 font-bold group-hover:text-blue-700 transition-colors">${cell}</td>`).join('')}
                                                <td class="p-6 text-lg font-black text-right text-blue-700 bg-blue-50/30 sticky right-0 backdrop-blur-sm">
                                                    <span class="text-xs mr-1 text-blue-400">¥</span>${r.total.toLocaleString()}
                                                </td>
                                            </tr>
                                        `).join('')}
                                        ${results.length === 0 ? '<tr><td colspan="100" class="p-32 text-center text-slate-400 font-black text-xl italic">明細データが見つかりませんでした。</td></tr>' : ''}
                                    </tbody>
                                </table>
                            </div>

                            <div class="p-10 bg-slate-900 flex justify-between items-center text-white">
                                <div>
                                    <p class="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] mb-1">Row Count</p>
                                    <p class="text-2xl font-black">${results.length} 名分のデータ</p>
                                </div>
                                <button id="downloadCsv" class="group px-8 py-4 bg-blue-600 hover:bg-white hover:text-blue-600 text-white rounded-2xl font-black transition-all shadow-xl flex items-center gap-3 active:scale-95">
                                    <i data-lucide="download" size="20"></i>
                                    CSVとして保存
                                </button>
                            </div>
                        </div>
                    ` : `
                        <div class="bg-slate-900 p-12 rounded-[3rem] shadow-2xl overflow-auto text-blue-200 font-mono text-sm max-h-[80vh] border-8 border-slate-800">
                            <div class="mb-6 flex items-center gap-2 text-slate-500">
                                <i data-lucide="code" size="16"></i>
                                <span class="text-xs font-black uppercase tracking-widest">XML Structural Tree View</span>
                            </div>
                            ${state.parsedNode ? renderTree(state.parsedNode) : ''}
                        </div>
                    `}
                </main>

                <footer class="py-10 text-center text-slate-400 text-[10px] font-black uppercase tracking-[0.5em]">
                    e-Gov XML Document Parser & Premium Calculator
                </footer>
            </div>
        `;
        attachEvents();
    }
    if ((window as any).lucide) (window as any).lucide.createIcons();
};

const renderTree = (node: XMLNode): string => {
    return `
        <div class="xml-node my-1 border-l-2 border-slate-800 pl-4 py-1">
            <span class="text-indigo-400 font-bold opacity-80">&lt;${node.name}</span>
            ${Object.entries(node.attributes).map(([k, v]) => `<span class="text-xs text-slate-600 ml-2 italic">${k}="${v}"</span>`).join('')}
            <span class="text-indigo-400 font-bold opacity-80">&gt;</span>
            ${node.content ? `<span class="text-white mx-2 font-sans">${node.content}</span>` : ''}
            <div>${node.children.map(c => renderTree(c)).join('')}</div>
            <span class="text-indigo-400 font-bold opacity-40">&lt;/${node.name}&gt;</span>
        </div>
    `;
};

const handleFile = (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
        const text = ev.target?.result as string;
        state.xmlContent = text;
        try {
            state.parsedNode = parseXML(text);
            state.analysis = localExtractData(state.parsedNode);
            render();
        } catch (err) {
            alert("XMLの解析に失敗しました。ファイル形式を確認してください。");
        }
    };
    reader.readAsText(file);
};

const attachEvents = () => {
    document.getElementById('resetBtn')?.addEventListener('click', () => { 
        state.xmlContent = null; 
        state.analysis = null;
        state.parsedNode = null;
        render(); 
    });
    document.getElementById('toggleSettings')?.addEventListener('click', () => { state.showSettings = !state.showSettings; render(); });
    document.getElementById('viewSummary')?.addEventListener('click', () => { state.viewMode = 'summary'; render(); });
    document.getElementById('viewTree')?.addEventListener('click', () => { state.viewMode = 'tree'; render(); });
    
    document.querySelectorAll('.rate-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const el = e.target as HTMLInputElement;
            const key = el.dataset.key as 'health' | 'pension' | 'nursing';
            state.rates[key] = parseFloat(el.value);
            render();
        });
    });

    document.getElementById('downloadCsv')?.addEventListener('click', () => {
        if (!state.analysis?.tableData) return;
        const results = calculatePremiums();
        const headers = [...state.analysis.tableData.headers, "本人負担合計"].join(',');
        const rows = results.map(r => [...r.original, r.total].join(',')).join('\n');
        const csv = "\uFEFF" + headers + "\n" + rows;
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `egov_export_${new Date().getTime()}.csv`;
        a.click();
    });
};

render();
