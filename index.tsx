
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
}

// --- App State ---
const state = {
    cases: [] as CaseEntry[],
    selectedCaseIdx: -1,
    selectedFileIdx: -1,
    viewMode: 'summary' as 'summary' | 'tree',
    showSettings: false,
    isLoading: false,
    logs: [] as string[],
    rates: { health: 9.98, pension: 18.3, nursing: 1.60 }
};

const addLog = (msg: string) => {
    state.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (state.logs.length > 50) state.logs.shift();
};

// --- XML Utilities ---
const parseXML = (xmlString: string): XMLNode => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "text/xml");
    if (xmlDoc.getElementsByTagName("parsererror").length > 0) throw new Error("Invalid XML");

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

const extractUniversalData = (node: XMLNode): UniversalData => {
    const headers: Record<string, string> = {};
    const officeInfo: Record<string, string> = {};
    const sections: UniversalData['sections'] = [];
    
    let arrivalNumber = "", postCode = "", address = "", companyName = "", recipientName = "", creationDate = "", officeName = "";

    const processNode = (n: XMLNode, path: string = "") => {
        const name = n.name;
        const val = n.content || "";

        if (name.includes("到達番号") || name === "ArrivalNumber") arrivalNumber = val || arrivalNumber;
        if (name.includes("郵便番号") || name === "PostCode") postCode = val || postCode;
        if (name.includes("所在地") || name.includes("住所") || name === "Address") address = val || address;
        if (name.includes("事業所名称") || name.includes("会社名") || name === "CompanyName") companyName = val || companyName;
        if (name.includes("氏名") || name.includes("代表者") || name === "Name") recipientName = val || recipientName;
        if (name.includes("作成年月日") || name.includes("通知年月日") || name === "Date") creationDate = val || creationDate;
        if (name.includes("年金事務所名") || name === "OfficeName") officeName = val || officeName;
        
        if (["事業所整理記号", "事業所番号", "OfficeID"].some(k => name.includes(k))) {
            officeInfo[name] = val;
        }

        if (n.children.length === 0) {
            if (val) headers[path + name] = val;
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
            n.children.forEach(c => processNode(c, path + name + "_"));
        }
    };
    processNode(node);
    
    let title = node.name;
    if (title.match(/Kokuho|S00|決定通知/)) {
        title = "健康保険・厚生年金保険 被保険者標準報酬決定通知書";
    }

    return { title, arrivalNumber, postCode, address, companyName, recipientName, creationDate, officeName, officeInfo, headers, sections };
};

const handleUpload = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const rawFiles = Array.from(input.files || []);
    if (rawFiles.length === 0) return;

    state.isLoading = true;
    state.cases = [];
    state.logs = [];
    addLog(`${rawFiles.length} 個の対象をスキャン中...`);
    render();

    const caseMap = new Map<string, AppFile[]>();
    const allPdfs = new Set<string>();

    const addToFileMap = (path: string, fileName: string, content: string) => {
        const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : "root";
        
        if (fileName.toLowerCase().endsWith('.pdf')) {
            allPdfs.add(path);
            return;
        }

        if (fileName.toLowerCase().endsWith('.xml')) {
            try {
                const parsed = parseXML(content);
                const analysis = extractUniversalData(parsed);
                
                let detectedXsl = "";
                const piMatch = parsed.processingInstructions.find(pi => pi.includes('href='));
                if (piMatch) {
                    const match = piMatch.match(/href="([^"]+)"/);
                    if (match) detectedXsl = match[1];
                }
                
                const fileEntry: AppFile = {
                    name: fileName,
                    fullPath: path,
                    content,
                    parsed,
                    analysis,
                    detectedXsl
                };

                if (!caseMap.has(dir)) caseMap.set(dir, []);
                caseMap.get(dir)!.push(fileEntry);
            } catch (err) {
                addLog(`エラー: ${fileName} の解析に失敗しました。`);
            }
        }
    };

    for (const f of rawFiles) {
        if (f.name.toLowerCase().endsWith('.zip')) {
            try {
                const zip = await JSZip.loadAsync(f);
                for (const filename of Object.keys(zip.files)) {
                    if (zip.files[filename].dir) continue;
                    const content = await zip.files[filename].async('string');
                    const baseName = filename.split('/').pop() || filename;
                    addToFileMap(filename, baseName, content);
                }
            } catch (err) {
                addLog(`ZIPエラー: ${f.name} を開けませんでした。`);
            }
        } else {
            const path = (f as any).webkitRelativePath || f.name;
            const content = await f.text();
            addToFileMap(path, f.name, content);
        }
    }

    state.cases = Array.from(caseMap.entries()).map(([dir, xmls]) => {
        xmls.forEach(xml => {
            const xmlBase = xml.fullPath.substring(0, xml.fullPath.lastIndexOf('.'));
            xml.hasPdf = Array.from(allPdfs).some(p => p.startsWith(xmlBase));
        });
        return {
            folderPath: dir,
            folderName: dir === "root" ? "ルート案件" : dir.split('/').pop() || dir,
            files: xmls
        };
    });

    if (state.cases.length > 0) {
        state.selectedCaseIdx = 0;
        state.selectedFileIdx = 0;
        addLog(`${state.cases.length} 個のフォルダ、合計 ${state.cases.reduce((acc, c) => acc + c.files.length, 0)} 個のXMLを検出しました。`);
    } else {
        addLog("表示可能なXMLファイルが見つかりませんでした。");
    }

    state.isLoading = false;
    render();
};

const render = () => {
    const root = document.getElementById('root');
    if (!root) return;

    if (state.isLoading) {
        root.innerHTML = `
            <div class="min-h-screen flex items-center justify-center bg-slate-100 p-6">
                <div class="text-center">
                    <div class="animate-spin rounded-full h-16 w-16 border-b-4 border-blue-600 mx-auto mb-4"></div>
                    <p class="text-slate-600 font-bold">ファイルを解析中...</p>
                </div>
            </div>
        `;
        return;
    }

    if (state.cases.length === 0) {
        root.innerHTML = `
            <div class="min-h-screen flex items-center justify-center bg-slate-100 p-6">
                <div class="bg-white p-12 rounded-[3rem] shadow-2xl border border-slate-200 w-full max-w-2xl text-center">
                    <div class="bg-blue-600 w-24 h-24 rounded-3xl flex items-center justify-center mx-auto mb-10 text-white shadow-xl rotate-3">
                        <i data-lucide="folder-search" size="48"></i>
                    </div>
                    <h2 class="text-4xl font-black mb-4 text-slate-900 tracking-tighter">e-Gov Pro Viewer</h2>
                    <p class="text-slate-500 mb-12 text-lg font-medium leading-relaxed">
                        通知書フォルダ、またはダウンロードしたZIPを選択してください。<br/>
                        複数のXMLが含まれていても自動的に分類します。
                    </p>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <label class="block py-6 px-8 bg-blue-600 hover:bg-blue-700 text-white font-black rounded-3xl cursor-pointer transition-all active:scale-95 shadow-lg group">
                            <i data-lucide="folder-plus" class="mx-auto mb-2 group-hover:scale-110 transition-transform"></i>
                            フォルダを選択
                            <input type="file" id="folderInput" class="hidden" webkitdirectory />
                        </label>
                        <label class="block py-6 px-8 bg-slate-800 hover:bg-slate-900 text-white font-black rounded-3xl cursor-pointer transition-all active:scale-95 shadow-lg group">
                            <i data-lucide="file-archive" class="mx-auto mb-2 group-hover:scale-110 transition-transform"></i>
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

    const currentCase = state.cases[state.selectedCaseIdx];
    const currentFile = currentCase.files[state.selectedFileIdx];
    const data = currentFile.analysis;

    root.innerHTML = `
        <div class="h-screen flex flex-col bg-slate-100 overflow-hidden">
            <header class="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between z-50 shadow-sm">
                <div class="flex items-center gap-4">
                    <button id="resetBtn" class="p-2 hover:bg-slate-100 rounded-xl transition-colors text-slate-400"><i data-lucide="home" size="20"></i></button>
                    <h1 class="text-lg font-black text-slate-800 tracking-tight">e-Gov Pro Viewer</h1>
                </div>
                <div class="flex items-center gap-4">
                    <button id="toggleSettings" class="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-xl text-xs font-black transition-all">
                        <i data-lucide="settings" size="14"></i> 保険料率
                    </button>
                </div>
            </header>

            <div class="flex-1 flex overflow-hidden">
                <aside class="w-80 bg-white border-r border-slate-200 flex flex-col shadow-inner">
                    <div class="p-4 border-b bg-slate-50 flex items-center justify-between">
                        <h2 class="text-[10px] font-black text-slate-400 uppercase tracking-widest">案件・書類リスト</h2>
                    </div>
                    <div class="flex-1 overflow-y-auto custom-scrollbar">
                        ${state.cases.map((c, cIdx) => `
                            <div class="border-b border-slate-100">
                                <div class="px-4 py-3 bg-slate-50/50 flex items-center gap-2">
                                    <i data-lucide="folder" size="14" class="text-blue-500"></i>
                                    <span class="text-[11px] font-black text-slate-700 truncate">${c.folderName}</span>
                                    <span class="ml-auto text-[9px] bg-slate-200 px-1.5 rounded-md font-bold text-slate-500">${c.files.length}</span>
                                </div>
                                <div class="py-1">
                                    ${c.files.map((f, fIdx) => `
                                        <button class="w-full text-left px-8 py-3 text-xs font-bold transition-all flex items-center justify-between select-file-btn ${cIdx === state.selectedCaseIdx && fIdx === state.selectedFileIdx ? 'bg-blue-600 text-white shadow-lg' : 'hover:bg-blue-50 text-slate-500'}" data-case="${cIdx}" data-file="${fIdx}">
                                            <span class="truncate pr-2">${f.name}</span>
                                            ${f.hasPdf ? '<i data-lucide="file-check" size="12" class="text-green-500"></i>' : ''}
                                        </button>
                                    `).join('')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </aside>

                <main class="flex-1 bg-slate-200 overflow-y-auto p-4 md:p-12 relative flex flex-col items-center">
                    <div class="mb-6 flex gap-2 sticky top-0 z-10">
                        <button id="viewSummaryBtn" class="px-6 py-2 rounded-full text-xs font-black transition-all shadow-md ${state.viewMode === 'summary' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}">通知書表示</button>
                        <button id="viewTreeBtn" class="px-6 py-2 rounded-full text-xs font-black transition-all shadow-md ${state.viewMode === 'tree' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}">XMLソース</button>
                    </div>
                    ${state.viewMode === 'summary' && data ? renderDocument(data, currentFile) : renderTree(currentFile.parsed!)}
                </main>
            </div>

            <footer class="bg-slate-900 text-blue-300 px-6 py-2 h-32 border-t border-slate-800 font-mono text-[10px] overflow-y-auto">
                <div class="flex justify-between items-center mb-2 sticky top-0 bg-slate-900 py-1 border-b border-white/5">
                    <span class="font-black text-slate-500 uppercase tracking-widest">System Logs</span>
                    <button id="clearLogs" class="text-slate-500 hover:text-white transition-colors">CLEAR</button>
                </div>
                ${state.logs.map(log => `<div>${log}</div>`).join('')}
                ${state.logs.length === 0 ? '<div class="italic opacity-30">No logs available.</div>' : ''}
            </footer>

            ${state.showSettings ? renderSettings() : ''}
        </div>
    `;

    attachEvents();
    if ((window as any).lucide) (window as any).lucide.createIcons();
};

const renderDocument = (data: UniversalData, file: AppFile) => {
    const calculations = calculateIfPossible(data);
    return `
        <div class="bg-white shadow-2xl w-full max-w-[900px] min-h-[1200px] p-12 md:p-20 text-slate-900 relative border border-slate-300 mb-20 animate-in fade-in duration-300">
            <div class="flex justify-between items-start mb-12">
                <div class="text-[14px] font-bold leading-relaxed">
                    <p class="mb-1">〒${data.postCode || '--- ----'}</p>
                    <p class="mb-4">${data.address || '---'}</p>
                    <p class="text-xl mb-4 font-black">${data.companyName || '---'}</p>
                    <p class="text-xl font-black">${data.recipientName || '---'}　様</p>
                </div>
                <div class="text-right">
                    <p class="text-[11px] font-bold text-slate-400">到達番号 ${data.arrivalNumber || '---'}</p>
                    ${file.detectedXsl ? `<p class="text-[9px] font-mono text-blue-400 mt-1">スタイル: ${file.detectedXsl}</p>` : ''}
                </div>
            </div>

            <div class="text-center mb-16">
                <h1 class="text-2xl font-black border-b-[2.5px] border-slate-900 inline-block px-12 pb-1 tracking-tight">
                    ${data.title}
                </h1>
            </div>

            <div class="flex gap-12 mb-10">
                <div>
                    <span class="text-[10px] font-black text-slate-400 block mb-1 uppercase tracking-widest">事業所整理記号</span>
                    <span class="text-lg font-mono font-bold">${data.officeInfo["事業所整理記号"] || data.headers["事業所整理記号"] || "---"}</span>
                </div>
                <div>
                    <span class="text-[10px] font-black text-slate-400 block mb-1 uppercase tracking-widest">事業所番号</span>
                    <span class="text-lg font-mono font-bold">${data.officeInfo["事業所番号"] || data.headers["事業所番号"] || "---"}</span>
                </div>
            </div>

            ${data.sections.map(section => `
                <div class="mb-12 overflow-x-auto">
                    <table class="w-full border-collapse border-[1.5px] border-slate-900 text-[11px]">
                        <thead>
                            <tr class="bg-slate-50">
                                <th rowspan="2" class="border border-slate-900 p-2 w-14 text-center font-bold">整理番号</th>
                                <th rowspan="2" class="border border-slate-900 p-2 font-bold text-center">被保険者氏名</th>
                                <th rowspan="2" class="border border-slate-900 p-2 w-16 text-center font-bold">適用年月</th>
                                <th colspan="2" class="border border-slate-900 p-1 text-center font-bold">決定後の標準報酬月額</th>
                                <th rowspan="2" class="border border-slate-900 p-2 w-24 text-center font-bold">生年月日</th>
                                <th rowspan="2" class="border border-slate-900 p-2 w-16 text-center font-bold">種別</th>
                                ${calculations ? `<th rowspan="2" class="border border-slate-900 p-2 w-24 text-center font-bold bg-blue-50 text-blue-700">概算負担額</th>` : ''}
                            </tr>
                            <tr class="bg-slate-50">
                                <th class="border border-slate-900 p-1 w-20 text-center font-bold text-[9px]">(健保)</th>
                                <th class="border border-slate-900 p-1 w-20 text-center font-bold text-[9px]">(厚年)</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${section.data.map((row, rIdx) => {
                                const hKey = section.headers?.find(h => h.match(/健保|標準報酬月額|Health/));
                                const pKey = section.headers?.find(h => h.match(/厚年|標準報酬月額|Pension/));
                                const bKey = section.headers?.find(h => h.match(/生年月日|Birth/));
                                const nKey = section.headers?.find(h => h.match(/氏名|Name/));
                                const iKey = section.headers?.find(h => h.match(/番号|ID/));
                                const tKey = section.headers?.find(h => h.match(/適用年月|Apply/));
                                const cKey = section.headers?.find(h => h.match(/種別|区分|Type/));

                                return `
                                    <tr class="hover:bg-slate-50 transition-colors">
                                        <td class="border border-slate-900 p-2 text-center font-mono">${row[iKey!] || '-'}</td>
                                        <td class="border border-slate-900 p-2 font-bold text-[13px]">${row[nKey!] || '-'}</td>
                                        <td class="border border-slate-900 p-2 text-center">${row[tKey!] || '-'}</td>
                                        <td class="border border-slate-900 p-2 text-right font-bold">${row[hKey!] || '-'}</td>
                                        <td class="border border-slate-900 p-2 text-right font-bold">${row[pKey!] || '-'}</td>
                                        <td class="border border-slate-900 p-2 text-center">${row[bKey!] || '-'}</td>
                                        <td class="border border-slate-900 p-2 text-center">${row[cKey!] || '-'}</td>
                                        ${calculations ? `
                                            <td class="border border-slate-900 p-2 text-right font-black text-blue-700 bg-blue-50/50">
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

            <div class="mt-20 text-[10px] space-y-2 text-slate-500 font-bold border-t pt-8">
                <p>※1 元号　S：昭和　H：平成　R：令和</p>
                <p>※2 種別　第一種：男性　第二種：女性　第三種：坑内員　等</p>
                <p class="mt-4">上記の通り標準報酬が決定されたので通知します。</p>
                <div class="pt-12 flex justify-between items-end text-slate-900">
                    <div class="font-bold">
                        <p class="mb-4">${data.creationDate || '令和７年１２月 ５日'}</p>
                        <p class="text-lg">日本年金機構 理事長</p>
                        <p class="mt-1">（ ${data.officeName || '年金事務所'} ）</p>
                    </div>
                </div>
            </div>
        </div>
    `;
};

const renderTree = (node: XMLNode): string => {
    const traverse = (n: XMLNode): string => `
        <div class="xml-node my-0.5 border-l border-white/10 pl-4 py-0.5">
            <span class="text-indigo-400 opacity-60">&lt;${n.name}&gt;</span>
            ${n.content ? `<span class="text-white ml-1 font-bold">${n.content}</span>` : ''}
            <div>${n.children.map(c => traverse(c)).join('')}</div>
            <span class="text-indigo-400 opacity-60">&lt;/${n.name}&gt;</span>
        </div>
    `;
    return `
        <div class="bg-slate-900 p-10 rounded-[3rem] shadow-2xl overflow-auto text-blue-200 font-mono text-[11px] w-full max-w-4xl min-h-[800px] animate-in slide-in-from-right duration-300">
            ${traverse(node)}
        </div>
    `;
};

const renderSettings = () => `
    <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[200] flex items-center justify-center p-6">
        <div class="bg-white rounded-[3rem] shadow-2xl p-10 max-w-sm w-full animate-in zoom-in duration-200">
            <h3 class="text-xl font-black mb-8 flex items-center gap-2 text-slate-800"><i data-lucide="calculator"></i> 保険料率設定 (%)</h3>
            <div class="space-y-6">
                ${Object.entries(state.rates).map(([k, v]) => `
                    <div>
                        <label class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">${k === 'health' ? '健康保険' : k === 'pension' ? '厚生年金' : '介護保険'}</label>
                        <input type="number" step="0.001" value="${v}" data-key="${k}" class="rate-input w-full p-4 bg-slate-100 border-none rounded-2xl font-black text-slate-700 focus:ring-2 ring-blue-500 outline-none" />
                    </div>
                `).join('')}
            </div>
            <button id="closeSettings" class="w-full mt-10 py-5 bg-slate-900 text-white font-black rounded-2xl hover:bg-slate-800 transition-all shadow-xl">保存して適用</button>
        </div>
    </div>
`;

const calculateIfPossible = (data: UniversalData) => {
    const section = data.sections.find(s => s.isTable);
    if (!section || !section.headers) return null;
    const hIdx = section.headers.findIndex(h => h.match(/健保|標準報酬月額|Health/));
    if (hIdx === -1) return null;
    const pIdx = section.headers.findIndex(h => h.match(/厚年|標準報酬月額|Pension/));

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

const attachEvents = () => {
    document.getElementById('resetBtn')?.addEventListener('click', () => { 
        state.cases = []; 
        state.selectedCaseIdx = -1; 
        state.selectedFileIdx = -1; 
        render(); 
    });
    document.getElementById('toggleSettings')?.addEventListener('click', () => { state.showSettings = !state.showSettings; render(); });
    document.getElementById('closeSettings')?.addEventListener('click', () => { state.showSettings = false; render(); });
    document.getElementById('clearLogs')?.addEventListener('click', () => { state.logs = []; render(); });
    
    document.getElementById('viewSummaryBtn')?.addEventListener('click', () => { state.viewMode = 'summary'; render(); });
    document.getElementById('viewTreeBtn')?.addEventListener('click', () => { state.viewMode = 'tree'; render(); });

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
            const key = el.dataset.key as 'health' | 'pension' | 'nursing';
            state.rates[key] = parseFloat(el.value);
        });
    });
};

render();
