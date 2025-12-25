
import { GoogleGenAI, Type } from "@google/genai";
// Import shared types from the types module
import { XMLNode, AnalysisResult } from "./types";

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

// --- XML Parser ---
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

// --- Gemini Service ---
const analyzeXML = async (xmlString: string): Promise<AnalysisResult> => {
    // Fix: Use process.env.API_KEY directly as per guidelines
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const contentSnippet = xmlString.length > 300000 ? xmlString.substring(0, 300000) + "..." : xmlString;

    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Extract social insurance data from this e-Gov XML. Return JSON: {title: string, tableData: {headers: string[], rows: string[][]}}. XML: ${contentSnippet}`,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING },
                    summary: { type: Type.STRING },
                    tableData: {
                        type: Type.OBJECT,
                        properties: {
                            headers: { type: Type.ARRAY, items: { type: Type.STRING } },
                            rows: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.STRING } } }
                        }
                    }
                },
                required: ["title", "tableData"]
            }
        }
    });
    // Fix: response.text is a property, not a function
    return JSON.parse(response.text || '{}');
};

// --- Calculator ---
const calculatePremiums = () => {
    if (!state.analysis?.tableData) return [];
    const { headers, rows } = state.analysis.tableData;
    const hIdx = headers.findIndex(h => h.includes("健保") || h.includes("標準額"));
    const pIdx = headers.findIndex(h => h.includes("厚年"));
    const bIdx = headers.findIndex(h => h.includes("生年月日"));

    return rows.map(row => {
        const healthAmount = parseInt(row[hIdx]?.replace(/[^0-9]/g, '') || '0') * (row[hIdx]?.includes('千円') ? 1000 : 1);
        const pensionAmount = parseInt(row[pIdx]?.replace(/[^0-9]/g, '') || '0') * (row[pIdx]?.includes('千円') ? 1000 : 1);
        
        // 年齢推定（簡易）
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
                    <div class="bg-blue-50 w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-8 text-blue-600">
                        <i data-lucide="upload-cloud" size="40"></i>
                    </div>
                    <h2 class="text-3xl font-extrabold mb-4 text-slate-800">XMLを読み込む</h2>
                    <p class="text-slate-500 mb-10 leading-relaxed font-medium">e-Govの通知書XMLを選択してください。</p>
                    <label class="block w-full py-5 px-8 bg-blue-600 hover:bg-blue-700 text-white font-bold text-lg rounded-2xl cursor-pointer transition-all shadow-lg">
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
                            <button id="toggleSettings" class="px-4 py-2 rounded-xl text-sm font-bold border ${state.showSettings ? 'bg-blue-600 text-white' : 'bg-white text-slate-600'}">
                                <i data-lucide="settings" size="16" class="inline mr-2"></i>料率
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
                        <div class="mb-8 p-8 bg-white rounded-3xl border border-blue-100 shadow-xl grid grid-cols-1 sm:grid-cols-3 gap-8">
                            ${Object.entries(state.rates).map(([key, val]) => `
                                <div>
                                    <label class="block text-xs font-bold text-slate-400 uppercase mb-2">${key}</label>
                                    <input type="number" step="0.01" value="${val}" data-key="${key}" class="rate-input w-full p-4 bg-slate-50 border rounded-xl font-bold" />
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}

                    ${state.isLoading ? `
                        <div class="p-16 text-center bg-blue-50/50 rounded-[2rem] border-2 border-dashed border-blue-100">
                            <div class="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full spin mx-auto mb-6"></div>
                            <p class="text-xl font-bold text-blue-800">AI解析中...</p>
                        </div>
                    ` : ''}

                    ${state.viewMode === 'summary' && state.analysis ? `
                        <div class="bg-white rounded-[2.5rem] shadow-xl border overflow-hidden">
                            <div class="p-8 border-b bg-slate-50/50 flex justify-between items-center">
                                <h2 class="text-2xl font-black">${state.analysis.title}</h2>
                                <button id="downloadCsv" class="px-6 py-3 bg-slate-800 text-white rounded-xl text-sm font-bold">CSV保存</button>
                            </div>
                            <div class="overflow-x-auto">
                                <table class="w-full text-left">
                                    <thead class="bg-slate-50">
                                        <tr>
                                            ${state.analysis.tableData?.headers.map(h => `<th class="p-5 text-[11px] font-black text-slate-400 uppercase border-b">${h}</th>`).join('')}
                                            <th class="p-5 text-[11px] font-black text-blue-600 uppercase border-b text-right">本人負担合計</th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y">
                                        ${results.map(r => `
                                            <tr class="hover:bg-blue-50/10">
                                                ${r.original.map(cell => `<td class="p-5 text-sm text-slate-700">${cell}</td>`).join('')}
                                                <td class="p-5 text-sm font-bold text-right text-blue-700">¥${r.total.toLocaleString()}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    ` : ''}

                    ${state.viewMode === 'tree' && state.parsedNode ? `
                        <div class="bg-slate-900 p-8 rounded-[2rem] shadow-2xl overflow-auto text-slate-300 font-mono text-sm max-h-[80vh]">
                            ${renderTree(state.parsedNode)}
                        </div>
                    ` : ''}
                </main>
            </div>
        `;
        attachEvents();
    }
    // Lucideアイコンの初期化
    if ((window as any).lucide) (window as any).lucide.createIcons();
};

const renderTree = (node: XMLNode): string => {
    return `
        <div class="xml-node">
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
    reader.onload = async (ev) => {
        const text = ev.target?.result as string;
        state.xmlContent = text;
        state.isLoading = true;
        state.parsedNode = parseXML(text);
        render();

        try {
            state.analysis = await analyzeXML(text);
        } catch (err) {
            console.error(err);
        } finally {
            state.isLoading = false;
            render();
        }
    };
    reader.readAsText(file);
};

const attachEvents = () => {
    document.getElementById('resetBtn')?.addEventListener('click', () => { state.xmlContent = null; render(); });
    document.getElementById('toggleSettings')?.addEventListener('click', () => { state.showSettings = !state.showSettings; render(); });
    document.getElementById('viewSummary')?.addEventListener('click', () => { state.viewMode = 'summary'; render(); });
    document.getElementById('viewTree')?.addEventListener('click', () => { state.viewMode = 'tree'; render(); });
    document.querySelectorAll('.rate-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const key = (e.target as HTMLInputElement).dataset.key as 'health' | 'pension' | 'nursing';
            state.rates[key] = parseFloat((e.target as HTMLInputElement).value);
            render();
        });
    });
    document.getElementById('downloadCsv')?.addEventListener('click', () => {
        if (!state.analysis?.tableData) return;
        const results = calculatePremiums();
        const csv = results.map(r => [...r.original, r.total].join(',')).join('\n');
        const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'calc_results.csv';
        a.click();
    });
};

// 実行開始
render();
