
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

interface Appendix {
    title: string;
    link?: string;
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
    docNo?: string;
    authorAff?: string;
    authorName?: string;
    paragraphs: string[];
    appendices: Appendix[];
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

const TAG_MAP: Record<string, string> = {
    "S001": "整理番号", "S002": "氏名", "S003": "健康保険_標準報酬", "S004": "厚生年金_標準報酬",
    "S005": "適用年月", "S006": "生年月日", "S007": "種別", "S008": "備考",
    "T001": "到達番号", "T002": "所在地", "T003": "事業所名称", "T004": "代表者氏名",
    "T005": "作成年月日", "T006": "郵便番号", "T007": "年金事務所名", "T008": "事業所整理記号", "T009": "事業所番号"
};

const extractUniversalData = (node: XMLNode): UniversalData => {
    const headers: Record<string, string> = {};
    const officeInfo: Record<string, string> = {};
    const sections: UniversalData['sections'] = [];
    const appendices: Appendix[] = [];
    let paragraphs: string[] = [];
    let arrivalNumber = "", postCode = "", address = "", companyName = "", recipientName = "", creationDate = "", officeName = "";
    let docNo = "", authorAff = "", authorName = "", title = "";

    const processNode = (n: XMLNode, path: string = "") => {
        const name = TAG_MAP[n.name] || n.name;
        const val = n.content || "";

        if (n.name === "DOCNO") docNo = val;
        if (n.name === "DATE") creationDate = val;
        if (n.name === "TITLE") title = val;

        // TO Section
        if (n.name === "TO") {
            n.children.forEach(c => {
                if (c.name === "AFF") companyName = c.content || "";
                if (c.name === "NAME") recipientName = (recipientName ? recipientName + " " : "") + (c.content || "");
                if (c.name === "HONORIFC") recipientName = (recipientName ? recipientName + " " : "") + (c.content || "");
            });
        }

        // AUTHOR Section
        if (n.name === "AUTHOR") {
            n.children.forEach(c => {
                if (c.name === "AFF") authorAff = c.content || "";
                if (c.name === "NAME") authorName = c.content || "";
            });
        }

        // APPENDIX Section
        if (n.name === "APPENDIX") {
            let appTitle = "";
            let appLink = "";
            n.children.forEach(c => {
                if (c.name === "APPTITLE") appTitle = c.content || "";
                if (c.name === "DOCLINK") appLink = c.content || "";
            });
            if (appTitle) appendices.push({ title: appTitle, link: appLink });
        }

        // MAINTXT Section (Paragraphs)
        if (n.name === "MAINTXT" || n.name === "MAINTXT3") {
            n.children.forEach(c => {
                if (c.name === "P" && c.content && c.content.trim()) {
                    paragraphs.push(c.content.trim());
                }
            });
        }

        if (name.includes("到達番号")) arrivalNumber = val || arrivalNumber;
        if (name.includes("所在地") || name.includes("住所")) address = val || address;
        if (name.includes("郵便番号")) postCode = val || postCode;
        if (name.includes("年金事務所")) officeName = val || officeName;
        if (["整理記号", "事業所番号", "識別情報"].some(k => name.includes(k))) officeInfo[name] = val;

        if (n.children.length === 0) {
            if (val) headers[path + name] = val;
            return;
        }

        const counts: Record<string, number> = {};
        n.children.forEach(c => counts[c.name] = (counts[c.name] || 0) + 1);
        const repeatingTagName = Object.keys(counts).find(tag => counts[tag] > 1);

        if (repeatingTagName || n.name.toLowerCase().includes("list") || n.name.includes("情報")) {
            const listItems = repeatingTagName ? n.children.filter(c => c.name === repeatingTagName) : n.children.filter(c => c.children.length > 0);
            if (listItems.length > 0) {
                const tableHeaders = new Set<string>();
                const rows = listItems.map(item => {
                    const row: Record<string, string> = {};
                    const flatten = (cn: XMLNode) => {
                        const cName = TAG_MAP[cn.name] || cn.name;
                        if (cn.children.length === 0) {
                            row[cName] = cn.content || "";
                            tableHeaders.add(cName);
                        } else cn.children.forEach(child => flatten(child));
                    };
                    flatten(item);
                    return row;
                });
                const isRealDataTable = Array.from(tableHeaders).some(h => h.match(/氏名|報酬|整理番号|年月|S00/i));
                if (isRealDataTable) {
                    sections.push({ name: repeatingTagName || n.name, isTable: true, headers: Array.from(tableHeaders), data: rows });
                    return;
                }
            }
        }
        n.children.forEach(c => processNode(c, path + name + "_"));
    };

    processNode(node);
    if (!title) title = node.name;
    if (title.match(/Kokuho|S00|決定通知|S001|StandardRemuneration|HealthInsurance/)) {
        title = "健康保険・厚生年金保険 被保険者標準報酬決定通知書";
    }

    return { title, arrivalNumber, postCode, address, companyName, recipientName, creationDate, officeName, officeInfo, headers, sections, docNo, authorAff, authorName, paragraphs, appendices };
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
                } catch (err) { addLog(`解析失敗: ${name} - ${err}`); }
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
        if (state.cases.length > 0) { state.selectedCaseIdx = 0; state.selectedFileIdx = 0; }
    } catch (err) { addLog(`処理エラー: ${err}`); } finally {
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
        root.innerHTML = `<div class="h-screen flex flex-col items-center justify-center bg-slate-50 p-10">
            <div class="bg-white p-20 rounded-[4rem] shadow-2xl border text-center max-w-2xl w-full">
                <div class="w-24 h-24 bg-blue-600 rounded-3xl flex items-center justify-center mx-auto mb-10 text-white shadow-xl rotate-3"><i data-lucide="upload-cloud" size="48"></i></div>
                <h1 class="text-4xl font-black mb-6 tracking-tighter">e-Gov Pro Explorer</h1>
                <p class="text-slate-500 mb-12 font-medium">ZIPまたはフォルダを選択してください</p>
                <div class="grid grid-cols-2 gap-6">
                    <label class="p-8 bg-blue-600 text-white rounded-[2rem] font-black cursor-pointer hover:bg-blue-700 transition-all active:scale-95 shadow-lg">フォルダを選択<input type="file" id="folderInput" class="hidden" webkitdirectory directory /></label>
                    <label class="p-8 bg-slate-900 text-white rounded-[2rem] font-black cursor-pointer hover:bg-black transition-all active:scale-95 shadow-lg">ZIPを選択<input type="file" id="zipInput" class="hidden" accept=".zip" /></label>
                </div>
            </div>
        </div>`;
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
                                    <button class="w-full text-left ml-5 p-3 text-xs font-bold rounded-lg mt-1 select-file-btn ${cIdx === state.selectedCaseIdx && fIdx === state.selectedFileIdx ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:bg-blue-50'}" data-case="${cIdx}" data-file="${fIdx}">${f.name}</button>
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
    // Determine if this is a "Notice" type or a "Table" type
    const isNotice = (data.paragraphs.length > 0 || data.appendices.length > 0) && data.sections.length === 0;

    if (isNotice) {
        // Summary Header for Notice types (①〜④ items)
        const findOfficeVal = (pattern: RegExp) => {
            const key = Object.keys(data.officeInfo).find(k => k.match(pattern)) || Object.keys(data.headers).find(k => k.match(pattern));
            return key ? (data.officeInfo[key] || data.headers[key]) : "　　　　　　";
        };

        const idInfo = findOfficeVal(/識別情報|文書番号|到達番号/);
        const officeId = findOfficeVal(/整理記号/);
        const officeNum = findOfficeVal(/事業所番号/);

        return `
            <div class="bg-white shadow-2xl w-full max-w-[900px] min-h-[1200px] p-10 md:p-16 text-slate-900 rounded-sm relative mb-20 leading-relaxed font-['Noto_Sans_JP']">
                <!-- Banner Area -->
                <div class="flex justify-between items-start mb-8 text-[12px] font-bold">
                    <div class="flex gap-10">
                        <div class="space-y-0.5">
                            <p>健康保険</p>
                            <p>厚生年金保険</p>
                            <p>国民年金</p>
                        </div>
                        <h2 class="text-[18px] self-center tracking-[0.2em]">CSV形式届書総括票</h2>
                    </div>
                    <div class="border border-slate-900 px-6 py-2 text-[14px]">電子申請用</div>
                </div>

                <!-- Summary Info Grid -->
                <div class="grid grid-cols-2 gap-y-2 mb-16 text-[13px] font-medium">
                    <div class="flex gap-4"><span>①識別情報</span><span class="flex-1 border-b border-slate-300">${idInfo}</span></div>
                    <div class="flex gap-4"><span>②作成年月日</span><span class="flex-1 border-b border-slate-300">${data.creationDate || '令和　年　月　日'}</span></div>
                    <div class="flex gap-4"><span>③事業所整理記号</span><span class="flex-1 border-b border-slate-300">${officeId}</span></div>
                    <div class="flex gap-4"><span>④事業所番号</span><span class="flex-1 border-b border-slate-300">${officeNum}</span></div>
                </div>

                <!-- Document Body Content -->
                <div class="text-right text-[15px] font-medium mb-10">
                    <p class="mb-1">${data.docNo || ''}</p>
                    <p>${data.creationDate || ''}</p>
                </div>
                
                <div class="text-left text-[16px] font-bold mb-10 space-y-1">
                    <p class="text-[18px]">${data.companyName || ''}</p>
                    <p class="text-[18px]">${data.recipientName || ''}</p>
                </div>

                <div class="text-right text-[15px] font-bold mb-16 space-y-1">
                    <p>${data.authorAff || '日本年金機構'}</p>
                    <p>${data.authorName || '日本年金機構理事長'}</p>
                </div>

                <div class="text-center mb-16">
                    <h1 class="text-xl font-black">${data.title}</h1>
                </div>

                <div class="space-y-6 text-[15px] mb-12 text-justify whitespace-pre-wrap">
                    ${data.paragraphs.map(p => `<p>${p}</p>`).join('')}
                </div>

                <!-- Appendices (Links) -->
                ${data.appendices.length > 0 ? `
                    <div class="space-y-2 mb-16">
                        ${data.appendices.map(app => `
                            <div class="flex gap-2 text-blue-700 underline font-medium">
                                <span>${app.title}</span>
                                <span class="text-slate-500 no-underline">( ${app.link || 'リンクファイル'} )</span>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}

                <!-- Informational Text (Static Bottom Section) -->
                <div class="text-[14px] space-y-4 pt-10">
                    <p class="font-bold">【ご案内：「オンライン事業所年金情報サービス」をぜひご利用ください。】</p>
                    <p>日本年金機構では、各種情報・通知書を電子送付するサービス「オンライン事業所年金情報サービス」を提供しています。紙の通知書よりも早く確認が可能で、紙の削減により環境負荷の軽減にも繋がります。ぜひこの機会にオンライン事業所年金情報サービスをご利用ください。</p>
                    <div class="pt-6 space-y-1">
                        <p>電子データで受け取ることができる情報・通知書は以下のとおりです。</p>
                        <p>＜事業主の方＞</p>
                        <ul class="list-disc ml-6 space-y-0.5">
                            <li>保険料納入告知額・領収済額通知書（社会保険料を口座振替している事業主の方のみ）</li>
                            <li>社会保険料額情報</li>
                            <li>保険料増減内訳書</li>
                            <li>基本保険料算出内訳書</li>
                            <li>賞与保険料算出内訳書</li>
                            <li>被保険者データ（「届書作成プログラム」に本データを取り込むことで簡単に社会保険手続きを電子申請できます）</li>
                        </ul>
                    </div>
                </div>
            </div>
        `;
    }

    // Default Table View (for Standard Remuneration etc.)
    const calcs = calculateHalfAmount(data);
    return `
        <div class="bg-white shadow-2xl w-full max-w-[900px] min-h-[1200px] p-24 md:p-32 text-slate-900 rounded-sm relative mb-20 font-['Noto_Sans_JP']">
            <div class="flex justify-between mb-20 text-sm font-bold">
                <div>
                    <p class="text-slate-400">〒 ${data.postCode || '--- ----'}</p>
                    <p>${data.address || ''}</p>
                    <p class="text-2xl font-black mt-5">${data.companyName || '事業所名称なし'}</p>
                    <p class="text-2xl font-black">${data.recipientName || ''}</p>
                </div>
                <div class="text-right">
                    <div class="bg-slate-50 p-5 rounded-2xl border">
                        <p class="text-[10px] text-slate-400 uppercase font-black mb-1">文書番号</p>
                        <p class="font-mono font-black text-lg">${data.docNo || data.arrivalNumber || '---'}</p>
                    </div>
                </div>
            </div>

            <div class="text-center mb-20"><h1 class="text-3xl font-black border-b-4 border-slate-900 inline-block px-10 pb-2">${data.title}</h1></div>

            <div class="grid grid-cols-2 gap-10 mb-10 bg-slate-50 p-8 rounded-2xl border">
                <div><p class="text-[10px] font-black text-slate-400 mb-1 uppercase">事業所整理記号</p><p class="text-xl font-mono font-black">${data.officeInfo["事業所整理記号"] || data.headers["事業所整理記号"] || '---'}</p></div>
                <div><p class="text-[10px] font-black text-slate-400 mb-1 uppercase">事業所番号</p><p class="text-xl font-mono font-black">${data.officeInfo["事業所番号"] || data.headers["事業所番号"] || '---'}</p></div>
            </div>

            ${data.sections.length > 0 ? data.sections.map((section, sIdx) => `
                <div class="mb-10 overflow-x-auto">
                    <h3 class="text-xs font-black text-slate-400 mb-4 uppercase tracking-widest">${section.name}</h3>
                    <table class="w-full border-collapse border-4 border-slate-900 text-[13px]">
                        <thead class="bg-slate-50">
                            <tr>
                                <th class="border-2 border-slate-900 p-3 font-black">整理番号</th>
                                <th class="border-2 border-slate-900 p-3 font-black">氏名</th>
                                <th class="border-2 border-slate-900 p-3 font-black">適用年月</th>
                                <th class="border-2 border-slate-900 p-3 font-black">健康保険<br>(標準報酬)</th>
                                <th class="border-2 border-slate-900 p-3 font-black">厚生年金<br>(標準報酬)</th>
                                <th class="border-2 border-slate-900 p-3 font-black">生年月日</th>
                                ${calcs ? `<th class="border-2 border-slate-900 p-3 bg-blue-50 text-blue-700 font-black">折半額(概算)</th>` : ''}
                            </tr>
                        </thead>
                        <tbody>
                            ${section.data.map((row, rIdx) => {
                                const findVal = (regex: RegExp) => { const key = Object.keys(row).find(k => k.match(regex)); return key ? row[key] : '-'; };
                                return `<tr>
                                    <td class="border-2 border-slate-900 p-3 text-center font-mono font-bold">${findVal(/整理番号|S001/)}</td>
                                    <td class="border-2 border-slate-900 p-3 font-black text-[15px]">${findVal(/氏名|S002/)}</td>
                                    <td class="border-2 border-slate-900 p-3 text-center font-bold text-slate-500">${findVal(/適用年月|S005/)}</td>
                                    <td class="border-2 border-slate-900 p-3 text-right font-black text-[15px]">${findVal(/健康保険|S003/)}</td>
                                    <td class="border-2 border-slate-900 p-3 text-right font-black text-[15px]">${findVal(/厚生年金|S004/)}</td>
                                    <td class="border-2 border-slate-900 p-3 text-center text-slate-400">${findVal(/生年月日|S006/)}</td>
                                    ${calcs ? `<td class="border-2 border-slate-900 p-3 text-right font-black text-blue-700 bg-blue-50/40">¥${calcs[sIdx][rIdx]?.toLocaleString()}</td>` : ''}
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `).join('') : ''}

            <div class="mt-40 pt-10 border-t flex justify-between items-end">
                <div class="space-y-2">
                    <p class="text-slate-400 font-bold mb-10">${data.creationDate || ''}</p>
                    <p class="text-3xl font-black tracking-tighter">${data.authorName || '日本年金機構 理事長'}</p>
                    <p class="text-slate-500 font-bold">（ ${data.officeName || '所轄年金事務所'} ）</p>
                </div>
            </div>
        </div>
    `;
};

const calculateHalfAmount = (data: UniversalData) => {
    if (data.sections.length === 0) return null;
    return data.sections.map(section => section.data.map(row => {
        const hKey = Object.keys(row).find(k => k.match(/健康保険|S003/));
        const pKey = Object.keys(row).find(k => k.match(/厚生年金|S004/));
        const parseVal = (v: any) => { if (!v) return 0; let n = parseInt(String(v).replace(/[^0-9]/g, '')) || 0; if (String(v).includes('千円')) n *= 1000; return n; };
        const hHalf = Math.floor((parseVal(row[hKey || '']) * (state.rates.health / 100)) / 2);
        const pHalf = Math.floor((parseVal(row[pKey || '']) * (state.rates.pension / 100)) / 2);
        return hHalf + pHalf;
    }));
};

const renderTree = (node: XMLNode): string => {
    const traverse = (n: XMLNode): string => `<div class="ml-5 border-l border-white/10 pl-3 py-0.5"><span class="text-blue-400">&lt;${n.name}&gt;</span>${n.content ? `<span class="text-emerald-400 font-bold ml-2">${n.content}</span>` : ''}<div>${n.children.map(c => traverse(c)).join('')}</div><span class="text-blue-400">&lt;/${n.name}&gt;</span></div>`;
    return `<div class="bg-slate-900 p-10 rounded-3xl w-full max-w-4xl font-mono text-xs text-blue-100 overflow-auto">${traverse(node)}</div>`;
};

const renderSettings = () => `<div class="fixed inset-0 bg-black/80 backdrop-blur-md z-[100] flex items-center justify-center p-5"><div class="bg-white p-12 rounded-[3rem] max-w-md w-full shadow-2xl animate-in zoom-in-95"><h2 class="text-3xl font-black mb-8 tracking-tighter">保険料率設定</h2><div class="space-y-6">${Object.entries(state.rates).map(([k, v]) => `<div><label class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">${k === 'health' ? '健康保険' : k === 'pension' ? '厚生年金' : '介護保険'}</label><div class="flex items-center gap-4"><input type="number" step="0.001" value="${v}" data-key="${k}" class="rate-input flex-1 p-4 bg-slate-100 rounded-2xl font-black text-2xl outline-none" /><span class="text-2xl font-black text-slate-300">%</span></div></div>`).join('')}</div><button id="closeSettings" class="w-full mt-10 py-5 bg-blue-600 text-white font-black rounded-2xl shadow-xl active:scale-95 transition-all">反映して閉じる</button></div></div>`;

const attachEvents = () => {
    document.getElementById('resetBtn')?.addEventListener('click', () => { state.cases = []; render(); });
    document.getElementById('toggleSettings')?.addEventListener('click', () => { state.showSettings = true; render(); });
    document.getElementById('closeSettings')?.addEventListener('click', () => { state.showSettings = false; render(); });
    document.getElementById('viewSummaryBtn')?.addEventListener('click', () => { state.viewMode = 'summary'; render(); });
    document.getElementById('viewTreeBtn')?.addEventListener('click', () => { state.viewMode = 'tree'; render(); });
    document.querySelectorAll('.toggle-case-btn').forEach(btn => btn.addEventListener('click', (e) => { const idx = parseInt((e.currentTarget as HTMLElement).dataset.index!); state.cases[idx].isOpen = !state.cases[idx].isOpen; render(); }));
    document.querySelectorAll('.select-file-btn').forEach(btn => btn.addEventListener('click', (e) => { const target = e.currentTarget as HTMLElement; state.selectedCaseIdx = parseInt(target.dataset.case!); state.selectedFileIdx = parseInt(target.dataset.file!); render(); }));
    document.querySelectorAll('.rate-input').forEach(input => input.addEventListener('change', (e) => { const el = e.target as HTMLInputElement; const key = el.dataset.key as any; state.rates[key] = parseFloat(el.value); }));
};

render();
