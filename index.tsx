
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
 * e-GovのXMLからローカルでデータを抽出する強化版エンジン
 */
const localExtractData = (node: XMLNode): AnalysisResult => {
    let bestRows: any[] = [];
    let bestHeaderSet = new Set<string>();
    let maxCount = 0;

    // XMLツリーを走査して、最も「表らしい」部分を探す
    const findTableCandidates = (n: XMLNode) => {
        if (n.children.length > 0) {
            // 子要素のタグ名の出現回数をカウント
            const counts: Record<string, number> = {};
            n.children.forEach(c => {
                counts[c.name] = (counts[c.name] || 0) + 1;
            });

            // 2回以上繰り返されているタグがあれば、それをレコードの候補とする
            for (const [tagName, count] of Object.entries(counts)) {
                if (count >= 1) {
                    const currentRows: any[] = [];
                    const currentHeaderSet = new Set<string>();

                    // 該当するタグを持つ子要素からデータを抽出
                    const targetChildren = n.children.filter(c => c.name === tagName);
                    targetChildren.forEach(record => {
                        const rowData: Record<string, string> = {};
                        const extractFields = (fn: XMLNode, prefix = "") => {
                            if (fn.children.length === 0) {
                                const key = prefix + fn.name;
                                rowData[key] = fn.content || "";
                                currentHeaderSet.add(key);
                            } else {
                                fn.children.forEach(c => extractFields(c, fn.name + "_"));
                            }
                        };
                        extractFields(record);
                        if (Object.keys(rowData).length > 0) {
                            currentRows.push(rowData);
                        }
                    });

                    // より多くのレコードを持っている、または情報量が多い方を採用
                    const score = currentRows.length * currentHeaderSet.size;
                    if (score > maxCount) {
                        maxCount = score;
                        bestRows = currentRows;
                        bestHeaderSet = currentHeaderSet;
                    }
                }
            }
        }
        n.children.forEach(findTableCandidates);
    };

    findTableCandidates(node);

    // ヘッダーと行データの整形
    const headers = Array.from(bestHeaderSet);
    const formattedRows = bestRows.map(r => headers.map(h => r[h] || ""));

    return {
        title: node.name === "通知書" ? "e-Gov 通知書データ" : "解析結果",
        tableData: {
            headers: headers.map(h => h.replace(/.*_/, "")), // 表示用に短縮
            rows: formattedRows
        }
    };
};

// --- Gemini Service ---
const analyzeWithAI = async (xmlString: string): Promise<AnalysisResult> => {
    if (!process.env.API_KEY) throw new Error("API Key not configured");
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const contentSnippet = xmlString.substring(0, 200000);

    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Extract social insurance table from e-Gov XML. Output JSON {title, tableData: {headers, rows}}. XML: ${contentSnippet}`,
        config: { 
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING },
                    tableData: {
                        type: Type.OBJECT,
                        properties: {
                            headers: { type: Type.ARRAY, items: { type: Type.STRING } },
                            rows: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.STRING } } }
                        },
                        required: ["headers", "rows"]
                    }
                },
                required: ["title", "tableData"]
            }
        }
    });
    return JSON.parse(response.text || "{}");
};

// --- Calculator ---
const calculatePremiums = () => {
    if (!state.analysis?.tableData) return [];
    const { headers, rows } = state.analysis.tableData;
    
    const findIdx = (keywords: string[]) => headers.findIndex(h => keywords.some(k => h.includes(k)));
    
    const hIdx = findIdx(["健保", "健康保険", "標準額", "標準報酬"]);
    const pIdx = findIdx(["厚年", "厚生年金"]);
    const bIdx = findIdx(["生年月日", "生年"]);

    return rows.map(row => {
        const healthAmount = parseInt(row[hIdx]?.replace(/[^0-9]/g, '') || '0') * (row[hIdx]?.includes('千円') ? 1000 : 1);
        const pensionAmount = parseInt(row[pIdx]?.replace(/[^0-9]/g, '') || '0') * (row[pIdx]?.includes('千円') ? 1000 : 1);
        
        const birthStr = row[bIdx] || "";
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

// --- Renderer ---
const render = () => {
    const root = document.getElementById('root');
    if (!root) return;

    if (!state.xmlContent) {
        root.innerHTML = `
            <div class="min-h-screen flex flex-col items-center justify-center bg-[#f8fafc] p-4">
                <div class="bg-white p-12 rounded-[2.5rem] shadow-xl border border-slate-100 w-full max-w-xl text-center">
                    <div class="bg-blue-600 w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-8 text-white shadow-lg">
                        <i data-lucide="file-up" size="40"></i>
                    </div>
                    <h2 class="text-3xl font-extrabold mb-4 text-slate-800">XMLを読み込む</h2>
                    <p class="text-slate-500 mb-10 leading-relaxed font-medium">e-Govの社会保険通知書などのXMLファイルを選択してください。AIを使わずブラウザ内で即座に解析します。</p>
                    <label class="block w-full py-5 px-8 bg-blue-600 hover:bg-blue-700 text-white font-bold text-lg rounded-2xl cursor-pointer transition-all shadow-lg active:scale-95">
                        ファイルを選択
                        <input type="file" id="fileInput" class="hidden" accept=".xml" />
                    </label>
                </div>
            </div>
        `;
        document.getElementById('fileInput')?.addEventListener('change', handleFile);
    } else {
        const results = calculatePremiums();
        root.innerHTML = `
            <div class="min-h-screen flex flex-col bg-[#f8fafc]">
                <header class="bg-white border-b border-slate-200 px-6 py-4 sticky top-0 z-50">
                    <div class="max-w-[1600px] mx-auto flex items-center justify-between">
                        <div class="flex items-center gap-3 cursor-pointer" id="resetBtn">
                            <div class="bg-blue-600 p-2 rounded text-white shadow-sm"><i data-lucide="file-text" size="20"></i></div>
                            <h1 class="text-lg font-bold tracking-tight">e-Gov XML Calculator</h1>
                        </div>
                        <div class="flex items-center gap-3">
                            <button id="toggleSettings" class="px-4 py-2 rounded-xl text-sm font-bold border ${state.showSettings ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 shadow-sm'}">
                                <i data-lucide="settings" size="16" class="inline mr-2"></i>保険料率
                            </button>
                            <div class="flex gap-1 bg-slate-100 p-1 rounded-xl">
                                <button id="viewSummary" class="px-5 py-2 rounded-lg text-sm font-bold ${state.viewMode === 'summary' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'}">帳票</button>
                                <button id="viewTree" class="px-5 py-2 rounded-lg text-sm font-bold ${state.viewMode === 'tree' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'}">構造</button>
                            </div>
                        </div>
                    </div>
                </header>

                <main class="flex-1 max-w-[1600px] w-full mx-auto p-6">
                    ${state.showSettings ? `
                        <div class="mb-8 p-8 bg-white rounded-3xl border border-blue-100 shadow-xl animate-in slide-in-from-top-4 duration-300">
                            <h3 class="text-sm font-black text-slate-800 mb-6 uppercase tracking-widest">保険料率設定（本人負担分）</h3>
                            <div class="grid grid-cols-1 sm:grid-cols-3 gap-8">
                                ${Object.entries(state.rates).map(([key, val]) => `
                                    <div>
                                        <label class="block text-xs font-bold text-slate-400 uppercase mb-2">
                                            ${key === 'health' ? '健康保険 (%)' : key === 'pension' ? '厚生年金 (%)' : '介護保険 (%)'}
                                        </label>
                                        <input type="number" step="0.001" value="${val}" data-key="${key}" class="rate-input w-full p-4 bg-slate-50 border border-slate-200 rounded-xl font-mono font-bold text-blue-600 focus:ring-2 focus:ring-blue-500 outline-none transition-all" />
                                    </div>
                                `).join('')}
                            </div>
                            <p class="mt-4 text-[10px] text-slate-400">※各料率を1/2した額（折半額）で計算されます。</p>
                        </div>
                    ` : ''}

                    ${state.viewMode === 'summary' ? `
                        <div class="bg-white rounded-[2.5rem] shadow-xl border border-slate-200 overflow-hidden">
                            <div class="p-8 border-b bg-slate-50/30 flex justify-between items-center">
                                <div>
                                    <h2 class="text-2xl font-black text-slate-800">${state.analysis?.title || '解析結果'}</h2>
                                    <p class="text-sm text-slate-400 font-medium">ローカルエンジンにより解析済み</p>
                                </div>
                                <div class="flex gap-2">
                                    <button id="downloadCsv" class="px-6 py-3 bg-slate-800 text-white rounded-xl text-sm font-bold hover:bg-slate-900 transition-all shadow-md active:scale-95">
                                        CSVダウンロード
                                    </button>
                                </div>
                            </div>
                            <div class="overflow-x-auto">
                                <table class="w-full text-left whitespace-nowrap">
                                    <thead class="bg-slate-50">
                                        <tr>
                                            ${state.analysis?.tableData?.headers.map(h => `
                                                <th class="p-5 text-[10px] font-black text-slate-400 uppercase border-b tracking-tighter">${h}</th>
                                            `).join('') || ''}
                                            <th class="p-5 text-[10px] font-black text-blue-600 uppercase border-b text-right tracking-tighter">概算本人負担額</th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y divide-slate-100">
                                        ${results.map(r => `
                                            <tr class="hover:bg-blue-50/20 transition-colors">
                                                ${r.original.map(cell => `<td class="p-5 text-sm text-slate-600 font-medium">${cell}</td>`).join('')}
                                                <td class="p-5 text-sm font-black text-right text-blue-700 bg-blue-50/10">¥${r.total.toLocaleString()}</td>
                                            </tr>
                                        `).join('')}
                                        ${results.length === 0 ? '<tr><td colspan="100" class="p-20 text-center text-slate-400 font-bold">データが検出されませんでした。ファイルの中身を確認してください。</td></tr>' : ''}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    ` : `
                        <div class="bg-slate-900 p-8 rounded-[2rem] shadow-2xl overflow-auto text-slate-300 font-mono text-sm max-h-[80vh] border border-slate-800">
                            ${state.parsedNode ? renderTree(state.parsedNode) : ''}
                        </div>
                    `}
                </main>
            </div>
        `;
        attachEvents();
    }
    if ((window as any).lucide) (window as any).lucide.createIcons();
};

const renderTree = (node: XMLNode): string => {
    return `
        <div class="xml-node my-1">
            <span class="text-blue-400 font-bold">&lt;${node.name}&gt;</span>
            ${Object.entries(node.attributes).map(([k, v]) => `<span class="text-xs text-slate-500 ml-2">${k}="${v}"</span>`).join('')}
            ${node.content ? `<span class="text-white ml-2">${node.content}</span>` : ''}
            <div>${node.children.map(c => renderTree(c)).join('')}</div>
            <span class="text-blue-400 font-bold">&lt;/${node.name}&gt;</span>
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
            
            if (process.env.API_KEY) {
                analyzeWithAI(text).then(aiResult => {
                    if (aiResult.tableData && aiResult.tableData.rows.length > 0) {
                        state.analysis = aiResult;
                        render();
                    }
                }).catch(err => console.debug("AI enhancement skipped:", err));
            }
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
