
import { GoogleGenAI, Type } from "@google/genai";
import JSZip from "jszip";

// --- Types ---
interface XMLNode {
    name: string;
    content?: string;
    children: XMLNode[];
}

interface UniversalData {
    docType: 'SUMMARY' | 'NOTICE' | 'ANNOUNCEMENT' | 'BONUS_NOTICE';
    title: string;
    // Common fields
    creationDateJP?: string;
    docNo?: string;
    // Summary fields
    idInfo?: string;
    officeRegistry?: string;
    officeNo?: string;
    counts?: Record<string, string>;
    zipCode?: string;
    address?: string;
    companyName?: string;
    ownerName?: string;
    phone?: string;
    submissionDateJP?: string;
    attachmentStatus?: string;
    // Notice fields
    arrivalNumber?: string;
    noticeBox?: string;
    isBonus?: boolean;
    rows: any[];
    officeRegistryNotice?: string;
    officeNoNotice?: string;
    pensionOffice?: string;
    noticeMgmtNo?: string;
    noticeMgmtBranch?: string;
    // Announcement fields
    senderAff?: string;
    senderName?: string;
    mainText?: string[];
    appendixTitle?: string;
    externalUrl?: string;
}

interface AppFile {
    name: string;
    fullPath: string;
    content: string;
    parsed?: XMLNode;
    analysis?: UniversalData;
}

interface CaseEntry {
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
    isLoading: false,
    loadingMsg: "",
    rates: { health: 9.98, pension: 18.3, nursing: 1.60 }
};

// --- Conversion Constants ---
const ERA_MAP: Record<string, string> = { "1": "明治", "3": "大正", "5": "昭和", "7": "平成", "9": "令和", "S": "昭和", "H": "平成", "R": "令和" };
const ERA_OFFSETS: Record<string, number> = { "1": 1867, "3": 1911, "5": 1925, "7": 1988, "9": 2018, "S": 1925, "H": 1988, "R": 2018 };

// --- Utilities ---
const normalize = (val: any): string => {
    if (val === undefined || val === null) return "";
    return String(val).replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).trim();
};

const getFormattedDates = (g: any, y: any, m: any, d: any = "1") => {
    const gn = normalize(g);
    const yn = parseInt(normalize(y).replace(/[^0-9]/g, ""), 10);
    const mn = parseInt(normalize(m).replace(/[^0-9]/g, ""), 10);
    const dn = parseInt(normalize(d).replace(/[^0-9]/g, ""), 10);
    if (isNaN(yn)) return { ad: "", jp: "", short: "" };
    const offset = ERA_OFFSETS[gn] || 0;
    const yearAD = yn + offset;
    const eraName = ERA_MAP[gn] || "令和";
    const eraChar = gn.length === 1 && !isNaN(parseInt(gn)) ? (gn === "9" ? "R" : gn === "7" ? "H" : gn === "5" ? "S" : gn) : gn;
    
    return {
        ad: `${yearAD}/${String(mn)}/${String(dn)}`,
        jp: `${eraChar}${String(yn).padStart(2, '0')}.${String(mn).padStart(2, '0')}.${String(dn).padStart(2, '0')}`,
        fullJp: `${eraName}${String(yn).padStart(2, '0')}年${String(mn).padStart(2, '0')}月${String(dn).padStart(2, '0')}日`
    };
};

// --- Data Extraction ---
const extractDetailed = (node: XMLNode): UniversalData | null => {
    const dataMap: Record<string, any> = {};
    const mainText: string[] = [];
    let appendixTitle = "";
    let externalUrl = "";

    const traverse = (n: XMLNode) => {
        if (n.content !== undefined && n.content !== "") {
            dataMap[n.name] = n.content;
            if (n.name === "P") mainText.push(n.content);
            if (n.name === "APPTITLE") appendixTitle = n.content;
            if (n.name === "a") externalUrl = n.content;
        }
        n.children.forEach(traverse);
    };
    traverse(node);

    // 1. お知らせ形式 (ANNOUNCEMENT)
    if (dataMap["DOCNO"] && (dataMap["TITLE"] === "日本年金機構からのお知らせ" || dataMap["TITLE"] === "日本年金機構からお知らせ")) {
        return {
            docType: 'ANNOUNCEMENT',
            title: dataMap["TITLE"],
            docNo: dataMap["DOCNO"],
            creationDateJP: dataMap["DATE"],
            companyName: dataMap["AFF"] || "", 
            ownerName: dataMap["NAME"] || "",
            senderAff: "日本年金機構",
            senderName: "日本年金機構理事長",
            mainText: mainText,
            appendixTitle: appendixTitle,
            externalUrl: externalUrl,
            rows: []
        };
    }

    // 2. 総括票 (SUMMARY)
    if (dataMap["識別情報x提出元ID"] || dataMap["届書総件数x届書合計"]) {
        const createDate = getFormattedDates("9", dataMap["年"], dataMap["月"], dataMap["日"]);
        return {
            docType: 'SUMMARY',
            title: "CSV形式届書総括票",
            idInfo: `${dataMap["識別情報x提出元ID"] || ''} － ${dataMap["識別情報x通番"] || ''}`,
            creationDateJP: createDate.fullJp,
            officeRegistry: `${dataMap["事業所整理記号x都道府県コード"] || ''} ${dataMap["事業所整理記号x郡市区記号"] || ''} － ${dataMap["事業所整理記号x事業所記号"] || ''}`,
            officeNo: dataMap["事業所番号"] || "",
            zipCode: `${dataMap["事業所所在地x郵便番号x親番号"] || ''} － ${dataMap["事業所所在地x郵便番号x子番号"] || ''}`,
            address: dataMap["事業所所在地"] || "",
            companyName: dataMap["事業所名称"] || "",
            ownerName: dataMap["事業主氏名"] || "",
            phone: `${dataMap["市外局番"] || ''} （ ${dataMap["局番"] || ''} ） ${dataMap["番号"] || ''}`,
            submissionDateJP: createDate.fullJp,
            attachmentStatus: dataMap["なし"] === "1" ? "なし" : dataMap["電子"] === "1" ? "電子" : "郵送",
            counts: {
                "資格取得届": dataMap["届書総件数x資格取得届70歳以上被用者該当届"] || "",
                "被扶養者異動": dataMap["届書数x被扶養者異動国年3号被保険者関係届"] || "",
                "算定基礎届": dataMap["届書数x算定基礎届70歳以上被用者算定基礎届"] || "",
                "賞与支払届": dataMap["届書数x賞与支払届70歳以上被用者賞与支払届"] || "",
                "合計": dataMap["届書総件数x届書合計"] || ""
            },
            rows: []
        };
    }

    // 3. 通知書 (NOTICE / BONUS_NOTICE)
    const rows: any[] = [];
    const findRows = (n: XMLNode) => {
        if (n.name === "_被保険者") {
            const r: any = {};
            n.children.forEach(c => r[c.name] = c.content);
            rows.push(r);
        }
        n.children.forEach(findRows);
    };
    findRows(node);

    if (rows.length > 0) {
        const isBonus = JSON.stringify(rows).includes("賞与");
        const h = rows[0];
        return {
            docType: isBonus ? 'BONUS_NOTICE' : 'NOTICE',
            title: isBonus ? "健康保険・厚生年金保険 標準賞与額決定通知書" : "健康保険・厚生年金保険 被保険者標準報酬決定通知書",
            isBonus, 
            rows,
            arrivalNumber: h["到達番号_項目"] || "",
            noticeBox: h["機構からのお知らせ"] || "",
            zipCode: h["事業所郵便番号_送付先"] || "",
            address: h["事業所所在地_送付先"] || "",
            companyName: h["事業所名称_送付先"] || "",
            ownerName: h["事業主氏名_送付先"] || "",
            creationDateJP: h["通知年月日"] || "",
            officeRegistryNotice: h["事業所整理記号"] || "",
            officeNoNotice: h["事業所番号"] || "",
            pensionOffice: h["年金事務所名"] || "",
            noticeMgmtNo: h["通知管理番号"] || "",
            noticeMgmtBranch: h["通知管理番号枝番"] || "",
        };
    }
    return null;
};

// --- Rendering Functions ---

const renderAnnouncementSheet = (data: UniversalData) => {
    return `
        <div class="bg-white w-full max-w-[1100px] min-h-[1200px] p-16 text-slate-800 shadow-2xl relative font-['Noto_Sans_JP'] border border-slate-200">
            <div class="text-right text-sm space-y-1 mb-8">
                <p class="font-mono text-base tracking-tighter">${data.docNo || ''}</p>
                <p class="text-base">${data.creationDateJP || ''}</p>
            </div>
            <div class="mb-12 space-y-3">
                <p class="text-base font-medium">${data.companyName || ''}</p>
                <p class="text-base font-medium">${data.ownerName || ''}　様</p>
            </div>
            <div class="text-right space-y-1 mb-12">
                <p class="text-base font-medium">${data.senderAff || ''}</p>
                <p class="text-base font-medium">${data.senderName || ''}</p>
            </div>
            <div class="text-center mb-12">
                <h1 class="text-lg font-bold tracking-widest decoration-1 underline-offset-8">${data.title || '日本年金機構からのお知らせ'}</h1>
            </div>
            <div class="max-w-[900px] mx-auto text-[15px] leading-[2.0] space-y-6 text-left mb-12">
                ${data.mainText?.map(p => `<p>${p.trim().replace(/\n/g, '<br>')}</p>`).join('')}
                ${data.appendixTitle ? `<div class="pt-4"><a href="#" class="text-blue-700 underline font-bold hover:text-blue-900 transition-colors">${data.appendixTitle}</a></div>` : ''}
            </div>
        </div>
    `;
};

const renderSummarySheet = (data: UniversalData) => {
    return `
        <div class="bg-white w-full max-w-[1100px] p-12 text-slate-900 shadow-2xl relative font-['Noto_Sans_JP'] border border-slate-300">
            <div class="flex justify-between items-start mb-4">
                <div class="text-[14px] font-bold leading-tight">健康保険<br>厚生年金保険<br>国民年金</div>
                <div class="absolute left-1/2 -translate-x-1/2 text-2xl font-bold tracking-[0.2em] pt-4">ＣＳＶ形式届書総括票</div>
                <div class="border-2 border-slate-900 px-4 py-2 font-bold text-lg">電子申請用</div>
            </div>
            <div class="grid grid-cols-2 gap-x-12 gap-y-4 mt-12 text-[13px] font-medium">
                <div class="flex items-center"><span class="w-32">①識別情報</span><span class="border-b border-slate-900 flex-1 px-4 py-1 font-mono">${data.idInfo}</span></div>
                <div class="flex items-center"><span class="w-32">②作成年月日</span><span class="flex-1 px-4 py-1 font-bold underline underline-offset-4">${data.creationDateJP}</span></div>
                <div class="flex items-center"><span class="w-32">③事業所整理記号</span><span class="border-b border-slate-900 flex-1 px-4 py-1 font-mono">${data.officeRegistry}</span></div>
                <div class="flex items-center"><span class="w-32">④事業所番号</span><span class="border-b border-slate-900 flex-1 px-4 py-1 font-mono">${data.officeNo}</span></div>
            </div>
        </div>
    `;
};

const renderNoticeSheet = (data: UniversalData) => {
    const isBonusDoc = data.docType === 'BONUS_NOTICE';
    
    return `
        <div class="bg-white w-full max-w-[1000px] min-h-[1414px] p-16 text-slate-900 shadow-2xl relative font-['Noto_Sans_JP'] border border-slate-200">
            <!-- Header section -->
            <div class="flex justify-between items-start mb-10">
                <div class="text-[14px] leading-relaxed space-y-1">
                    <p class="font-bold text-lg">${data.zipCode || ''}</p>
                    <p class="text-base">${data.address || ''}</p>
                    <p class="pt-4 text-2xl font-black tracking-tighter">${data.companyName || ''}</p>
                    <div class="flex items-end gap-16">
                        <p class="text-2xl font-black">${data.ownerName || ''}　　様</p>
                    </div>
                    <div class="pt-4 flex gap-8 text-[13px] font-mono text-slate-500">
                        <span>${data.noticeMgmtNo || ''}</span>
                        <span>${data.noticeMgmtBranch || ''}</span>
                    </div>
                </div>
                <div class="flex flex-col items-end">
                    <p class="text-sm font-bold mb-1">到達番号 ${data.arrivalNumber || ''}</p>
                    <div class="border border-slate-900 p-4 w-[380px] h-[260px] text-[13px] leading-relaxed overflow-hidden text-justify">
                        ${data.noticeBox || ''}
                    </div>
                </div>
            </div>

            <!-- Title -->
            <div class="text-center mb-16 mt-8">
                <h1 class="text-3xl font-black tracking-tight text-slate-900">
                    ${data.title}
                </h1>
            </div>

            <!-- Main Table -->
            <table class="w-full border-collapse border-[1.5px] border-slate-900 text-sm mb-12">
                <thead class="bg-slate-50">
                    <tr class="h-14">
                        <th class="border border-slate-900 px-1 py-1 font-bold w-20">整理番号</th>
                        <th class="border border-slate-900 px-4 py-1 font-bold">氏名</th>
                        <th class="border border-slate-900 px-1 py-1 font-bold w-32">${isBonusDoc ? '支払年月日' : '適用年月'}<br>(西暦)</th>
                        <th class="border border-slate-900 px-1 py-1 font-bold" colspan="2">${isBonusDoc ? '標準賞与額' : '標準報酬月額'}</th>
                        <th class="border border-slate-900 px-1 py-1 font-bold w-32">生年月日<br>(西暦)</th>
                        <th class="border border-slate-900 px-1 py-1 font-bold w-20">種別</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.rows.map(r => {
                        const datePrefix = isBonusDoc ? "賞与支払年月日" : "適用年月";
                        const payDate = getFormattedDates(r[`${datePrefix}_元号`], r[`${datePrefix}_年`], r[`${datePrefix}_月`], r[`${datePrefix}_日`] || "1");
                        const birthDate = getFormattedDates(r["生年月日_元号"], r["生年月日_年"], r["生年月日_月"], r["生年月日_日"]);
                        const val1 = normalize(r[isBonusDoc ? "決定後の標準賞与額_健保" : "決定後の標準報酬月額_健保"]);
                        const val2 = normalize(r[isBonusDoc ? "決定後の標準賞与額_厚年" : "決定後の標準報酬月額_厚年"]);

                        return `
                        <tr class="h-20 text-center border-b border-slate-900">
                            <td class="border-r border-slate-900 text-base">${normalize(r["被保険者整理番号"] || "")}</td>
                            <td class="border-r border-slate-900 text-left px-6 font-black text-xl">${normalize(r["被保険者氏名"] || "")}</td>
                            <td class="border-r border-slate-900">
                                <div class="font-bold text-sm">${payDate.jp}</div>
                                <div class="text-blue-600 text-[11px] font-bold">(${payDate.ad})</div>
                            </td>
                            <td class="border-r border-slate-900 px-2 font-black text-lg w-32">
                                <div class="text-[10px] font-normal text-slate-400 mb-1 text-center">(健保)</div>
                                ${val1}
                            </td>
                            <td class="border-r border-slate-900 px-2 font-black text-lg w-32">
                                <div class="text-[10px] font-normal text-slate-400 mb-1 text-center">(厚年)</div>
                                ${val2}
                            </td>
                            <td class="border-r border-slate-900">
                                <div class="font-bold text-sm">${birthDate.jp}</div>
                                <div class="text-emerald-600 text-[11px] font-bold">(${birthDate.ad})</div>
                            </td>
                            <td class="text-base font-medium">${normalize(r["種別"] || "")}</td>
                        </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>

            <!-- Footer date and signature -->
            <div class="mt-20 text-right space-y-4">
                <p class="text-lg font-bold underline underline-offset-4 decoration-slate-300">
                    ${data.creationDateJP || ''}
                </p>
                <div class="pt-6">
                    <p class="text-2xl font-black tracking-[0.3em] pr-2">日本年金機構理事長</p>
                    <p class="text-lg font-bold text-slate-600">(${data.pensionOffice || ''}年金事務所)</p>
                </div>
            </div>
        </div>
    `;
};

// --- App Control ---
const handleUpload = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (files.length === 0) return;
    state.isLoading = true;
    state.loadingMsg = "全種類のe-Gov XMLを解析中...";
    render();
    try {
        const caseMap = new Map<string, AppFile[]>();
        for (const f of files) {
            const proc = async (path: string, name: string, content: string) => {
                if (!name.toLowerCase().endsWith('.xml')) return;
                try {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(content, "text/xml");
                    const walk = (el: Element): XMLNode => {
                        const n = el.tagName.split(':').pop() || el.tagName;
                        const children: XMLNode[] = [];
                        Array.from(el.childNodes).forEach(c => { if (c.nodeType === Node.ELEMENT_NODE) children.push(walk(c as Element)); });
                        return { name: n, content: el.children.length === 0 ? el.textContent?.trim() : undefined, children };
                    };
                    const parsed = walk(doc.documentElement);
                    const analysis = extractDetailed(parsed);
                    const dir = path.split('/')[0] || "一括";
                    if (!caseMap.has(dir)) caseMap.set(dir, []);
                    caseMap.get(dir)!.push({ name, fullPath: path, content, parsed, analysis: analysis || undefined });
                } catch (err) { console.error(err); }
            };
            if (f.name.endsWith('.zip')) {
                const zip = await new JSZip().loadAsync(f);
                for (const p of Object.keys(zip.files)) {
                    if (zip.files[p].dir) continue;
                    await proc(p, p.split('/').pop()!, await zip.files[p].async('string'));
                }
            } else {
                await proc((f as any).webkitRelativePath || f.name, f.name, await f.text());
            }
        }
        state.cases = Array.from(caseMap.entries()).map(([folderName, files]) => ({ folderName, files, isOpen: true }));
        if (state.cases.length > 0) { state.selectedCaseIdx = 0; state.selectedFileIdx = 0; }
    } finally { state.isLoading = false; render(); }
};

const render = () => {
    const root = document.getElementById('root');
    if (!root) return;
    if (state.isLoading) { root.innerHTML = `<div class="h-screen flex flex-col items-center justify-center bg-[#0a192f] text-white"><div class="animate-spin w-12 h-12 border-4 border-white/20 border-t-white rounded-full mb-6"></div><p class="text-xl font-bold">${state.loadingMsg}</p></div>`; return; }
    
    if (state.cases.length === 0) {
        root.innerHTML = `
            <div class="h-screen flex items-center justify-center bg-[#f1f5f9]">
                <div class="bg-white p-24 rounded-[3rem] shadow-2xl text-center border-t-8 border-blue-600 max-w-2xl">
                    <div class="w-24 h-24 bg-blue-600 text-white rounded-3xl flex items-center justify-center mx-auto mb-10 shadow-2xl rotate-3 transition-transform hover:rotate-0"><i data-lucide="file-check" size="40"></i></div>
                    <h1 class="text-4xl font-black mb-6 tracking-tight text-slate-900">e-Gov Notice Explorer</h1>
                    <p class="text-lg text-slate-500 mb-12 font-medium leading-relaxed">標準報酬決定・賞与決定通知・受付通知を<br>実物通りのレイアウトで再現します</p>
                    <div class="flex gap-6 justify-center">
                        <label class="bg-blue-600 text-white px-12 py-5 rounded-2xl font-black cursor-pointer hover:bg-blue-700 transition-all shadow-xl active:scale-95 text-lg">フォルダ読込<input type="file" id="dirIn" class="hidden" webkitdirectory directory /></label>
                        <label class="bg-slate-900 text-white px-12 py-5 rounded-2xl font-black cursor-pointer hover:bg-black transition-all shadow-xl active:scale-95 text-lg">ZIP / XML選択<input type="file" id="zipIn" class="hidden" accept=".zip,.xml" /></label>
                    </div>
                </div>
            </div>`;
        document.getElementById('dirIn')?.addEventListener('change', handleUpload);
        document.getElementById('zipIn')?.addEventListener('change', handleUpload);
        if ((window as any).lucide) (window as any).lucide.createIcons();
        return;
    }

    const cur = state.cases[state.selectedCaseIdx]?.files[state.selectedFileIdx];
    const data = cur?.analysis;

    root.innerHTML = `
        <div class="h-screen flex flex-col bg-slate-100 overflow-hidden no-print">
            <header class="bg-white border-b px-10 py-5 flex justify-between items-center z-50 shadow-sm">
                <div class="flex items-center gap-6">
                    <button id="home" class="p-3 bg-slate-50 border rounded-xl hover:bg-slate-100 transition-colors"><i data-lucide="home"></i></button>
                    <h1 class="text-2xl font-black tracking-tighter">e-Gov Explorer <span class="text-blue-600">Pro</span></h1>
                </div>
            </header>
            <div class="flex-1 flex overflow-hidden">
                <aside class="w-96 bg-white border-r flex flex-col overflow-y-auto p-6 space-y-4">
                    ${state.cases.map((c, ci) => `
                        <div class="mb-6">
                            <button class="w-full text-left p-4 font-black text-sm text-slate-400 uppercase tracking-[0.2em] toggle-case flex justify-between items-center bg-slate-50 rounded-xl mb-2" data-idx="${ci}">${c.folderName} <i data-lucide="${c.isOpen ? 'chevron-up' : 'chevron-down'}" size="16"></i></button>
                            ${c.isOpen ? c.files.map((f, fi) => `
                                <button class="w-full text-left p-5 text-[13px] font-bold rounded-2xl mt-2 select-file transition-all border ${ci === state.selectedCaseIdx && fi === state.selectedFileIdx ? 'bg-blue-600 text-white border-blue-600 shadow-xl translate-x-2' : 'bg-white text-slate-600 hover:bg-slate-50 border-slate-100'}" data-ci="${ci}" data-fi="${fi}">${f.name}</button>
                            `).join('') : ''}
                        </div>
                    `).join('')}
                </aside>
                <main class="flex-1 bg-slate-200 overflow-y-auto p-12 flex flex-col items-center">
                    <div class="mb-12 flex bg-white p-1.5 rounded-2xl shadow-2xl no-print border border-slate-300">
                        <button id="sumV" class="px-16 py-4 rounded-2xl text-[14px] font-black transition-all ${state.viewMode === 'summary' ? 'bg-blue-600 text-white shadow-lg scale-105' : 'text-slate-500 hover:bg-slate-50'}">プレビュー表示</button>
                        <button id="treeV" class="px-16 py-4 rounded-2xl text-[14px] font-black transition-all ${state.viewMode === 'tree' ? 'bg-blue-600 text-white shadow-lg scale-105' : 'text-slate-500 hover:bg-slate-50'}">XML構造</button>
                    </div>
                    <div class="print-area drop-shadow-2xl">
                        ${state.viewMode === 'summary' && data ? 
                            (data.docType === 'SUMMARY' ? renderSummarySheet(data) : 
                             (data.docType === 'NOTICE' || data.docType === 'BONUS_NOTICE') ? renderNoticeSheet(data) : 
                             renderAnnouncementSheet(data)) : 
                        (state.viewMode === 'summary' ? '<div class="bg-white p-40 rounded-3xl shadow-xl text-slate-300 font-black italic text-2xl">解析可能なデータが見つかりません</div>' : `<pre class="bg-[#0f172a] text-blue-400 p-12 rounded-3xl w-full max-w-5xl text-[13px] overflow-auto shadow-2xl leading-relaxed font-mono border-t-[20px] border-blue-900">${JSON.stringify(cur?.parsed, null, 2)}</pre>`)}
                    </div>
                </main>
            </div>
        </div>
    `;
    attach();
    if ((window as any).lucide) (window as any).lucide.createIcons();
};

const attach = () => {
    document.getElementById('home')?.addEventListener('click', () => { state.cases = []; render(); });
    document.getElementById('sumV')?.addEventListener('click', () => { state.viewMode = 'summary'; render(); });
    document.getElementById('treeV')?.addEventListener('click', () => { state.viewMode = 'tree'; render(); });
    document.querySelectorAll('.toggle-case').forEach(b => b.addEventListener('click', (e) => { const i = parseInt((e.currentTarget as any).dataset.idx); state.cases[i].isOpen = !state.cases[i].isOpen; render(); }));
    document.querySelectorAll('.select-file').forEach(b => b.addEventListener('click', (e) => { const t = e.currentTarget as any; state.selectedCaseIdx = parseInt(t.dataset.ci); state.selectedFileIdx = parseInt(t.dataset.fi); render(); }));
};

render();
