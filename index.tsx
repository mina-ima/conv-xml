
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
    submissionDate?: string;
    officeName?: string;
    docNo?: string;
    authorAff?: string;
    authorName?: string;
    noticeBox?: string;
    phone?: string;
    isBonusNotice?: boolean;
    isStandardNotice?: boolean; 
    isSummarySheet?: boolean; 
    isDocNotice?: boolean; 
    summaryData?: Record<string, string>; 
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
    showCalcResults: false,
    isSimulating: false, 
    isLoading: false,
    loadingMsg: "",
    logs: [] as string[],
    rates: { health: 9.98, pension: 18.3, nursing: 1.60 }
};

// --- Utilities ---
const addLog = (msg: string) => {
    console.log(`[Viewer Log] ${msg}`);
    state.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (state.logs.length > 100) state.logs.shift();
};

const parseAmountValue = (str: string): number => {
    if (!str) return 0;
    const num = parseInt(str.replace(/[^0-9]/g, "")) || 0;
    if (str.includes("千")) {
        return num * 1000;
    }
    return num;
};

const calculateInsurance = (row: any, rates: typeof state.rates) => {
    const hSalaryStr = row["決定後の標準報酬月額_健保"] || row["決定後の標準賞与額_健保"] || "0";
    const pSalaryStr = row["決定後の標準報酬月額_厚年"] || row["決定後の標準賞与額_厚年"] || "0";
    
    const hSalary = parseAmountValue(hSalaryStr);
    const pSalary = parseAmountValue(pSalaryStr);

    const healthEmp = Math.floor((hSalary * (rates.health / 100)) / 2);
    const pensionEmp = Math.floor((pSalary * (rates.pension / 100)) / 2);
    
    // --- 介護保険料の判定 (40歳以上65歳未満) ---
    let isNursingSubject = false;
    let age = -1;
    const gengoRaw = row["生年月日_元号"];
    const y = parseInt(row["生年月日_年"]);
    const m = parseInt(row["生年月日_月"]) || 1;
    const d = parseInt(row["生年月日_日"]) || 1;

    if (gengoRaw && !isNaN(y)) {
        let birthYear = 0;
        const g = String(gengoRaw).trim();
        // 1:明治, 3:大正, 5:昭和, 7:平成, 9:令和
        if (g === "1") birthYear = 1867 + y;
        else if (g === "3") birthYear = 1911 + y;
        else if (g === "5") birthYear = 1925 + y;
        else if (g === "7") birthYear = 1988 + y;
        else if (g === "9") birthYear = 2018 + y;

        if (birthYear > 0) {
            const today = new Date();
            age = today.getFullYear() - birthYear;
            if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) {
                age--;
            }
            isNursingSubject = (age >= 40 && age < 65);
        }
    }

    const nursingEmp = isNursingSubject ? Math.floor((hSalary * (rates.nursing / 100)) / 2) : 0;
    const totalEmp = healthEmp + pensionEmp + nursingEmp;

    return { hSalary, pSalary, healthEmp, pensionEmp, nursingEmp, totalEmp, isNursingSubject, age };
};

const exportCalcToCSV = (data: UniversalData) => {
    const section = data.sections.find(s => s.isTable);
    if (!section) return;
    const rows = section.data;
    
    let csv = "\uFEFF"; // UTF-8 BOM
    csv += "整理番号,被保険者氏名,年齢,標準額(健康保険),標準額(厚生年金),健康保険料(従業員負担分),厚生年金保険料(従業員負担分),介護保険料(従業員負担分),合計(従業員負担分)\n";
    
    rows.forEach(row => {
        const res = calculateInsurance(row, state.rates);
        csv += [
            row["被保険者整理番号"] || "",
            row["被保険者氏名"] || "",
            res.age >= 0 ? res.age : "-",
            res.hSalary,
            res.pSalary,
            res.healthEmp,
            res.pensionEmp,
            res.nursingEmp,
            res.totalEmp
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",") + "\n";
    });
    
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `保険料シミュレーション_${data.companyName || 'export'}.csv`;
    link.click();
};

// --- XML Utilities ---
const parseXML = (xmlString: string): XMLNode => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "text/xml");
    if (xmlDoc.getElementsByTagName("parsererror").length > 0) {
        throw new Error(`XMLのパースに失敗しました。`);
    }
    const pis: string[] = [];
    let child = xmlDoc.firstChild;
    while (child) {
        if (child.nodeType === Node.PROCESSING_INSTRUCTION_NODE) pis.push((child as ProcessingInstruction).data);
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
    const root = traverse(xmlDoc.documentElement);
    root.processingInstructions = pis;
    return root;
};

const extractUniversalData = (node: XMLNode): UniversalData => {
    const officeInfo: Record<string, string> = {};
    const sections: UniversalData['sections'] = [];
    let arrivalNumber = "", postCode = "", address = "", companyName = "", recipientName = "", creationDate = "", officeName = "", docNo = "", noticeBox = "";
    let paragraphs: string[] = [];
    let authorAff = "", authorName = "", title = "";

    const isStandardNotice = node.name === "N7130001";
    const isBonusNotice = node.name === "N7150001" || (!isStandardNotice && node.children.some(c => c.name === "_被保険者" && c.children.some(gc => gc.name.includes("賞与"))));
    const isDocNotice = node.name === "DOC";

    if (isStandardNotice || isBonusNotice) {
        title = isStandardNotice ? "健康保険・厚生年金保険被保険者標準報酬決定通知書" : "健康保険・厚生年金保険標準賞与額決定通知書";
        const rows: any[] = [];
        node.children.forEach(c => {
            if (c.name === "_被保険者") {
                const row: Record<string, string> = {};
                c.children.forEach(gc => {
                    const val = gc.content || "";
                    if (gc.name === "事業所郵便番号_送付先") postCode = val;
                    if (gc.name === "事業所所在地_送付先") address = val;
                    if (gc.name === "事業所名称_送付先") companyName = val;
                    if (gc.name === "事業主氏名_送付先") recipientName = val;
                    if (gc.name === "到達番号_項目") arrivalNumber = val;
                    if (gc.name === "機構からのお知らせ") noticeBox = val;
                    if (gc.name === "通知年月日") creationDate = val;
                    if (gc.name === "年金事務所名") officeName = val;
                    if (gc.name === "事業所整理記号") officeInfo["事業所整理記号"] = val;
                    if (gc.name === "事業所番号") officeInfo["事業所番号"] = val;
                    if (gc.name === "通知管理番号") docNo = val;
                    row[gc.name] = val;
                });
                rows.push(row);
            }
        });
        sections.push({ name: "被保険者データ", isTable: true, data: rows });
        return { title, arrivalNumber, postCode, address, companyName, recipientName, creationDate, officeName, officeInfo, headers: {}, sections, docNo, authorAff: "", authorName: "", paragraphs: [], appendices: [], noticeBox, isStandardNotice, isBonusNotice };
    }

    if (isDocNotice) {
        const bodyNode = node.children.find(c => c.name === "BODY");
        if (bodyNode) {
            bodyNode.children.forEach(c => {
                if (c.name === "DOCNO") docNo = c.content || "";
                if (c.name === "DATE") creationDate = c.content || "";
                if (c.name === "TITLE") title = c.content || "";
                if (c.name === "TO") {
                    companyName = c.children.find(gc => gc.name === "AFF")?.content || "";
                    const name = c.children.find(gc => gc.name === "NAME")?.content || "";
                    const honorific = c.children.find(gc => gc.name === "HONORIFC")?.content || "";
                    recipientName = `${name} ${honorific}`.trim();
                }
                if (c.name === "AUTHOR") {
                    authorAff = c.children.find(gc => gc.name === "AFF")?.content || "";
                    authorName = c.children.find(gc => gc.name === "NAME")?.content || "";
                }
                if (c.name === "MAINTXT" || c.name === "MAINTXT3") {
                    c.children.forEach(gc => { if (gc.name === "P" && gc.content) paragraphs.push(gc.content.trim()); });
                }
            });
        }
        return { title: title || "お知らせ", arrivalNumber, postCode, address, companyName, recipientName, creationDate, officeName: "", officeInfo: {}, headers: {}, sections: [], docNo, authorAff, authorName, paragraphs, appendices: [], noticeBox: "", isDocNotice: true };
    }

    return { title: "不明な形式", arrivalNumber, postCode, address, companyName, recipientName, creationDate, officeName: "", officeInfo: {}, headers: {}, sections: [], docNo: "", authorAff: "", authorName: "", paragraphs: [], appendices: [], noticeBox: "" };
};

const renderDocument = (data: UniversalData) => {
    if (data.isStandardNotice) return renderStandardRemunerationNotice(data); 
    if (data.isBonusNotice) return renderBonusNotice(data); 
    if (data.isDocNotice) return renderDocNotice(data);
    return `<div class="p-10 bg-white">対応していない形式の通知書です。</div>`;
};

const renderDocNotice = (data: UniversalData) => {
    return `
        <div class="bg-white shadow-2xl w-full max-w-[1000px] min-h-[1200px] p-10 md:p-16 text-slate-900 rounded-sm mb-20 leading-relaxed font-['Noto_Sans_JP']">
            <div class="text-right text-[15px] font-medium mb-12 space-y-2"><p>${data.docNo || ''}</p><p>${data.creationDate || ''}</p></div>
            <div class="text-left text-[16px] font-bold mb-10 space-y-2"><p class="text-[18px]">${data.companyName || ''}</p><p class="text-[18px]">${data.recipientName || ''}</p></div>
            <div class="text-right text-[15px] font-bold mb-20 space-y-1"><p>${data.authorAff || '日本年金機構'}</p><p>${data.authorName || '日本年金機構理事長'}</p></div>
            <div class="text-center mb-16"><h1 class="text-[20px] font-black tracking-widest border-b-2 border-slate-900 inline-block px-4 pb-1">${data.title}</h1></div>
            <div class="space-y-6 text-[15px] text-justify leading-loose">${data.paragraphs.map(p => `<p class="whitespace-pre-wrap">${p}</p>`).join('')}</div>
        </div>
    `;
};

const renderStandardRemunerationNotice = (data: UniversalData) => {
    const rows = data.sections[0]?.data || [];
    return `
        <div class="bg-white shadow-2xl w-full max-w-[1000px] min-h-[1200px] p-10 md:p-14 text-slate-900 rounded-sm mb-20 leading-relaxed font-['Noto_Sans_JP']">
            <div class="flex justify-between items-start mb-8 text-[12px] font-bold">
                <div class="space-y-1"><p>${data.postCode || ''}</p><p>${data.address || ''}</p><p class="text-[15px] mt-4">${data.companyName || ''}</p><div class="flex items-end gap-2"><p class="text-[15px]">${data.recipientName || ''}</p><p class="text-[13px] ml-4 font-normal">様</p></div><div class="flex gap-10 mt-2 text-[13px] font-mono"><span>${rows[0]?.["通知管理番号"] || ''}</span><span>${rows[0]?.["通知管理番号枝番"] || ''}</span></div></div>
                <div class="text-right space-y-1"><p class="text-[11px] font-normal">到達番号 ${data.arrivalNumber || ''}</p><div class="border border-slate-900 p-3 mt-4 w-[280px] h-[200px] text-left text-[10px] font-normal whitespace-pre-wrap overflow-hidden">${data.noticeBox || ''}</div></div>
            </div>
            <div class="text-center mb-12"><h1 class="text-[18px] font-bold tracking-widest">${data.title}</h1></div>
            <div class="mb-4 space-y-1 text-[13px] font-bold"><div class="flex"><span class="w-32">事業所整理記号</span><span>${data.officeInfo["事業所整理記号"] || ''}</span></div><div class="flex"><span class="w-32">事業所番号</span><span>${data.officeInfo["事業所番号"] || ''}</span></div></div>
            <table class="w-full border-collapse border border-slate-900 text-[10px] font-bold mb-10 text-center">
                <thead><tr class="bg-white"><th class="border border-slate-900 p-1 w-16">整理番号</th><th class="border border-slate-900 p-1">被保険者氏名</th><th class="border border-slate-900 p-1 w-24">※1 適用年月</th><th class="border border-slate-900 p-1" colspan="2">標準報酬月額</th><th class="border border-slate-900 p-1 w-24">※1 生年月日</th><th class="border border-slate-900 p-1 w-16">※2 種別</th></tr></thead>
                <tbody>${rows.map(row => `<tr><td class="border border-slate-900 p-2 font-mono">${row["被保険者整理番号"] || ''}</td><td class="border border-slate-900 p-2 pl-4 text-[13px] text-left">${row["被保険者氏名"] || ''}</td><td class="border border-slate-900 p-2 font-mono">${row["適用年月_元号"] || ''} ${parseInt(row["適用年月_年"]) || ''}.${parseInt(row["適用年月_月"]) || ''}</td><td class="border border-slate-900 p-2 text-right pr-4 font-mono">${row["決定後の標準報酬月額_健保"] || ''}</td><td class="border border-slate-900 p-2 text-right pr-4 font-mono">${row["決定後の標準報酬月額_厚年"] || ''}</td><td class="border border-slate-900 p-2 font-mono">${row["生年月日_元号"] || ''} ${parseInt(row["生年月日_年"]) || ''}.${parseInt(row["生年月日_月"]) || ''}.${parseInt(row["生年月日_日"]) || ''}</td><td class="border border-slate-900 p-2 text-[11px]">${row["種別"] || ''}</td></tr>`).join('')}</tbody>
            </table>
            <div class="flex flex-col items-end mt-16 space-y-2"><p class="text-[14px] font-bold">${data.creationDate || ''}</p><div><p class="text-[16px] font-bold tracking-tighter">日　本　年　金　機　構　理　事　長</p><p class="text-[13px] text-slate-600 text-right">（ ${data.officeName || ''}年金事務所 ）</p></div></div>
        </div>
    `;
};

const renderBonusNotice = (data: UniversalData) => {
    const rows = data.sections[0]?.data || [];
    return `
        <div class="bg-white shadow-2xl w-full max-w-[1000px] min-h-[1200px] p-10 md:p-16 text-slate-900 rounded-sm mb-20 leading-relaxed font-['Noto_Sans_JP']">
            <div class="flex justify-between items-start mb-8 text-[12px] font-bold"><div class="space-y-1"><p>${data.postCode || ''}</p><p>${data.address || ''}</p><p class="text-[16px] mt-4">${data.companyName || ''}</p><p class="text-[16px]">${data.recipientName || ''} 様</p></div><div class="text-right space-y-1"><p>到達番号　${data.arrivalNumber || ''}</p><div class="border border-slate-900 p-4 mt-4 w-[280px] h-[220px] text-left text-[11px] whitespace-pre-wrap overflow-hidden">${data.noticeBox || ''}</div></div></div>
            <div class="text-center mb-10"><h1 class="text-[19px] font-bold tracking-widest">${data.title}</h1></div>
            <table class="w-full border-collapse border border-slate-900 text-[10px] font-bold mb-10 text-center">
                <thead><tr class="bg-slate-50"><th class="border border-slate-900 p-1 w-16">整理番号</th><th class="border border-slate-900 p-1">被保険者氏名</th><th class="border border-slate-900 p-1 w-24">※1 支払日</th><th class="border border-slate-900 p-1" colspan="2">標準賞与額</th><th class="border border-slate-900 p-1 w-24">※1 生年月日</th><th class="border border-slate-900 p-1 w-16">※2 種別</th></tr></thead>
                <tbody>${rows.map(row => `<tr><td class="border border-slate-900 p-2 font-mono">${row["被保険者整理番号"] || ''}</td><td class="border border-slate-900 p-2 text-left pl-4 text-[13px]">${row["被保険者氏名"] || ''}</td><td class="border border-slate-900 p-2 font-mono">${row["賞与支払年月日_元号"] || ''}${parseInt(row["賞与支払年月日_年"]) || ''}.${parseInt(row["賞与支払年月日_月"]) || ''}.${parseInt(row["賞与支払年月日_日"]) || ''}</td><td class="border border-slate-900 p-2 text-right pr-4 font-mono">${row["決定後の標準賞与額_健保"] || ''}</td><td class="border border-slate-900 p-2 text-right pr-4 font-mono">${row["決定後の標準賞与額_厚年"] || ''}</td><td class="border border-slate-900 p-2 font-mono">${row["生年月日_元号"] || ''}${parseInt(row["生年月日_年"]) || ''}.${parseInt(row["生年月日_月"]) || ''}.${parseInt(row["生年月日_日"]) || ''}</td><td class="border border-slate-900 p-2">${row["種別"] || ''}</td></tr>`).join('')}</tbody>
            </table>
            <div class="text-right text-[14px] font-bold mt-10"><p>${data.creationDate || ''}</p></div>
        </div>
    `;
};

const renderTree = (node: XMLNode): string => {
    const traverse = (n: XMLNode): string => `<div class="ml-5 border-l border-white/10 pl-3 py-0.5"><span class="text-blue-400">&lt;${n.name}&gt;</span>${n.content ? `<span class="text-emerald-400 font-bold ml-2">${n.content}</span>` : ''}<div>${n.children.map(c => traverse(c)).join('')}</div><span class="text-blue-400">&lt;/${n.name}&gt;</span></div>`;
    return `<div class="bg-slate-900 p-10 rounded-3xl w-full max-w-4xl font-mono text-xs text-blue-100 overflow-auto">${traverse(node)}</div>`;
};

const renderCalculationOverlay = (data: UniversalData) => {
    const mainSection = data.sections.find(s => s.isTable);
    const rows = mainSection?.data || [];
    return `
        <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
            <div class="bg-white rounded-[2.5rem] w-full max-w-7xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
                <div class="p-8 border-b flex justify-between items-center bg-slate-50">
                    <div><h2 class="text-2xl font-black tracking-tighter">保険料シミュレーション（従業員負担分）</h2><p class="text-xs text-slate-500 font-bold mt-1">以下の料率で計算: 健保 ${state.rates.health}% / 厚年 ${state.rates.pension}% / 介護 ${state.rates.nursing}%</p></div>
                    <button id="closeCalcBtn" class="w-10 h-10 bg-slate-200 rounded-full flex items-center justify-center hover:bg-slate-300 transition-all"><i data-lucide="x" size="20"></i></button>
                </div>
                <div class="flex-1 overflow-y-auto p-8">
                    <table class="w-full border-collapse">
                        <thead><tr class="text-[10px] font-black text-slate-400 uppercase tracking-widest border-b text-center"><th class="py-4 px-2 text-left">整理番号</th><th class="py-4 px-2 text-left">被保険者氏名</th><th class="py-4 px-2 text-right">標準額(健保)</th><th class="py-4 px-2 text-right">標準額(厚年)</th><th class="py-4 px-2 text-right text-blue-600 bg-blue-50/50">健康保険料</th><th class="py-4 px-2 text-right text-indigo-600 bg-indigo-50/50">厚生年金保険料</th><th class="py-4 px-2 text-right text-emerald-600 bg-emerald-50/50">介護保険料</th><th class="py-4 px-2 text-right bg-slate-900 text-white rounded-t-xl">合計負担分</th></tr></thead>
                        <tbody class="divide-y text-[13px]">${rows.map(row => { 
                            const res = calculateInsurance(row, state.rates); 
                            return `<tr class="hover:bg-slate-50">
                                <td class="py-4 px-2 font-mono">${row["被保険者整理番号"] || "-"}</td>
                                <td class="py-4 px-2 font-black">${row["被保険者氏名"] || "-"}</td>
                                <td class="py-4 px-2 text-right font-mono">${res.hSalary.toLocaleString()} 円</td>
                                <td class="py-4 px-2 text-right font-mono">${res.pSalary.toLocaleString()} 円</td>
                                <td class="py-4 px-2 text-right font-mono font-bold text-blue-600 bg-blue-50/20">${res.healthEmp.toLocaleString()} 円</td>
                                <td class="py-4 px-2 text-right font-mono font-bold text-indigo-600 bg-indigo-50/20">${res.pensionEmp.toLocaleString()} 円</td>
                                <td class="py-4 px-2 text-right font-mono font-bold ${res.isNursingSubject ? 'text-emerald-600 bg-emerald-50/20' : 'text-slate-300 bg-slate-100/50'}">
                                    ${res.isNursingSubject ? `${res.nursingEmp.toLocaleString()} 円` : `<span class="text-[10px]">対象外(${res.age}歳)</span>`}
                                </td>
                                <td class="py-4 px-2 text-right font-mono font-black text-white bg-slate-800">${res.totalEmp.toLocaleString()} 円</td>
                            </tr>`; 
                        }).join('')}</tbody>
                    </table>
                </div>
                <div class="p-8 bg-slate-50 border-t flex justify-between items-center">
                    <p class="text-[11px] text-slate-400 font-bold leading-relaxed">※介護保険料は40歳〜64歳の被保険者のみ計算しています。<br>※金額表示は 1,000円 単位の読み替えを反映した合計額です。</p>
                    <div class="flex gap-4">
                        <button id="calcToCsvBtn" class="bg-white border border-slate-300 text-slate-900 px-8 py-4 rounded-2xl font-black text-xs shadow-sm flex items-center gap-2 hover:bg-slate-100 transition-all"><i data-lucide="download" size="16"></i> CSV出力</button>
                        <button id="closeCalcBtnBottom" class="bg-blue-600 text-white px-8 py-4 rounded-2xl font-black text-xs">確認終了</button>
                    </div>
                </div>
            </div>
        </div>
    `;
};

const handleUpload = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const rawFiles = Array.from(input.files || []);
    if (rawFiles.length === 0) return;
    state.isLoading = true;
    state.loadingMsg = "読み込み中...";
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
        state.cases = Array.from(caseMap.entries()).map(([name, files]) => ({ folderName: name, folderPath: name, files, isOpen: true }));
        if (state.cases.length > 0) { state.selectedCaseIdx = 0; state.selectedFileIdx = 0; }
    } catch (err) { addLog(`エラー: ${err}`); } finally { state.isLoading = false; render(); }
};

const render = () => {
    const root = document.getElementById('root');
    if (!root) return;
    if (state.isLoading) { root.innerHTML = `<div class="h-screen flex items-center justify-center bg-slate-900 text-white font-black text-2xl animate-pulse">${state.loadingMsg}</div>`; return; }
    if (state.cases.length === 0) {
        root.innerHTML = `<div class="h-screen flex flex-col items-center justify-center bg-slate-50 p-10"><div class="bg-white p-20 rounded-[4rem] shadow-2xl border text-center max-w-2xl w-full"><div class="w-24 h-24 bg-blue-600 rounded-3xl flex items-center justify-center mx-auto mb-10 text-white shadow-xl rotate-3"><i data-lucide="upload-cloud" size="48"></i></div><h1 class="text-4xl font-black mb-6 tracking-tighter">e-Gov Pro Explorer</h1><p class="text-slate-500 mb-12 font-medium">通知書XML（ZIP可）をアップロードしてください</p><div class="grid grid-cols-2 gap-6"><label class="p-8 bg-blue-600 text-white rounded-[2rem] font-black cursor-pointer hover:bg-blue-700 shadow-lg">フォルダを選択<input type="file" id="folderInput" class="hidden" webkitdirectory directory /></label><label class="p-8 bg-slate-900 text-white rounded-[2rem] font-black cursor-pointer hover:bg-black shadow-lg">ZIPを選択<input type="file" id="zipInput" class="hidden" accept=".zip" /></label></div></div></div>`;
        document.getElementById('folderInput')?.addEventListener('change', handleUpload);
        document.getElementById('zipInput')?.addEventListener('change', handleUpload);
        if ((window as any).lucide) (window as any).lucide.createIcons();
        return;
    }
    const currentFile = state.cases[state.selectedCaseIdx]?.files[state.selectedFileIdx];
    const data = currentFile?.analysis;

    root.innerHTML = `
        <div class="h-screen flex flex-col bg-slate-100 overflow-hidden no-print">
            <header class="bg-white border-b px-10 py-5 flex items-center justify-between shadow-sm z-50"><div class="flex items-center gap-5"><button id="resetBtn" class="bg-slate-100 p-3 rounded-xl"><i data-lucide="home" size="20"></i></button><h1 class="text-xl font-black tracking-tight">e-Gov Pro Explorer</h1></div><button id="toggleSettingsTop" class="bg-slate-100 text-slate-600 px-6 py-3 rounded-xl text-xs font-black">料率設定</button></header>
            <div class="flex-1 flex overflow-hidden">
                <aside class="w-80 bg-white border-r flex flex-col overflow-hidden"><div class="p-5 border-b bg-slate-50 text-[10px] font-black text-slate-400 uppercase tracking-widest">Case Files</div><div class="flex-1 overflow-y-auto p-3 space-y-2">${state.cases.map((c, cIdx) => `<div><button class="w-full flex items-center gap-2 p-3 font-bold text-slate-700 text-sm hover:bg-slate-50 rounded-lg toggle-case-btn" data-index="${cIdx}"><i data-lucide="${c.isOpen ? 'chevron-down' : 'chevron-right'}" size="14"></i><span class="truncate">${c.folderName}</span></button>${c.isOpen ? c.files.map((f, fIdx) => `<button class="w-full text-left ml-5 p-3 text-xs font-bold rounded-lg mt-1 select-file-btn ${cIdx === state.selectedCaseIdx && fIdx === state.selectedFileIdx ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:bg-blue-50'}" data-case="${cIdx}" data-file="${fIdx}">${f.name}</button>`).join('') : ''}</div>`).join('')}</div></aside>
                <main class="flex-1 bg-slate-200 overflow-y-auto p-4 md:p-10 flex flex-col items-center relative">
                    <div class="mb-6 flex bg-white p-1.5 rounded-2xl shadow-lg sticky top-0 z-10 no-print"><button id="viewSummaryBtn" class="px-8 py-3 rounded-xl text-xs font-black transition-all ${state.viewMode === 'summary' ? 'bg-blue-600 text-white' : 'text-slate-500'}">通知書表示</button><button id="viewTreeBtn" class="px-8 py-3 rounded-xl text-xs font-black transition-all ${state.viewMode === 'tree' ? 'bg-blue-600 text-white' : 'text-slate-500'}">データ構造</button></div>
                    ${state.viewMode === 'summary' && data && (data.isStandardNotice || data.isBonusNotice) ? `<div class="w-full max-w-[1000px] mb-6 flex justify-between items-center bg-blue-50 border border-blue-200 p-4 rounded-2xl shadow-sm no-print"><div class="flex items-center gap-3"><div class="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center text-white"><i data-lucide="zap" size="20"></i></div><div><p class="text-xs font-black text-blue-900">業務支援ツール</p><p class="text-[10px] text-blue-600">CSV出力や保険料計算が可能です</p></div></div><div class="flex gap-2"><button id="printBtn" class="bg-white border border-blue-200 text-blue-600 px-4 py-2 rounded-xl text-[11px] font-black hover:bg-blue-100 transition-all">PDF印刷</button><button id="calcMenuBtn" class="bg-blue-600 text-white px-4 py-2 rounded-xl text-[11px] font-black hover:bg-blue-700 shadow-md transition-all">保険料シミュレーション</button></div></div>` : ''}
                    <div class="print-container">${state.viewMode === 'summary' && data ? renderDocument(data) : (currentFile ? renderTree(currentFile.parsed!) : '')}</div>
                </main>
            </div>
            ${state.showSettings ? renderSettings() : ''}
            ${state.showCalcResults && data ? renderCalculationOverlay(data) : ''}
        </div>
    `;
    attachEvents();
    if ((window as any).lucide) (window as any).lucide.createIcons();
};

const renderSettings = () => `<div class="fixed inset-0 bg-black/80 backdrop-blur-md z-[300] flex items-center justify-center p-5"><div class="bg-white p-12 rounded-[3rem] max-w-md w-full shadow-2xl"><h2 class="text-3xl font-black mb-4 tracking-tighter">保険料率設定</h2><div class="space-y-6">${Object.entries(state.rates).map(([k, v]) => `<div><label class="block text-[10px] font-black text-slate-400 mb-2 uppercase">${k} (%)</label><input type="number" step="0.001" value="${v}" data-key="${k}" class="rate-input w-full p-4 bg-slate-100 rounded-2xl font-black text-2xl" /></div>`).join('')}</div><button id="closeSettings" class="w-full mt-10 py-5 bg-blue-600 text-white font-black rounded-2xl shadow-xl hover:scale-105 transition-all">保存して次へ</button></div></div>`;

const attachEvents = () => {
    document.getElementById('resetBtn')?.addEventListener('click', () => { state.cases = []; render(); });
    document.getElementById('toggleSettingsTop')?.addEventListener('click', () => { state.showSettings = true; state.isSimulating = false; render(); });
    document.getElementById('closeSettings')?.addEventListener('click', () => { state.showSettings = false; if (state.isSimulating) { state.showCalcResults = true; state.isSimulating = false; } render(); });
    document.getElementById('viewSummaryBtn')?.addEventListener('click', () => { state.viewMode = 'summary'; render(); });
    document.getElementById('viewTreeBtn')?.addEventListener('click', () => { state.viewMode = 'tree'; render(); });
    document.getElementById('printBtn')?.addEventListener('click', () => { window.print(); });
    document.getElementById('calcMenuBtn')?.addEventListener('click', () => { state.showSettings = true; state.isSimulating = true; render(); });
    document.getElementById('closeCalcBtn')?.addEventListener('click', () => { state.showCalcResults = false; render(); });
    document.getElementById('closeCalcBtnBottom')?.addEventListener('click', () => { state.showCalcResults = false; render(); });
    document.getElementById('calcToCsvBtn')?.addEventListener('click', () => { 
        const currentFile = state.cases[state.selectedCaseIdx]?.files[state.selectedFileIdx];
        if (currentFile?.analysis) exportCalcToCSV(currentFile.analysis);
    });
    document.querySelectorAll('.toggle-case-btn').forEach(btn => btn.addEventListener('click', (e) => { const idx = parseInt((e.currentTarget as HTMLElement).dataset.index!); state.cases[idx].isOpen = !state.cases[idx].isOpen; render(); }));
    document.querySelectorAll('.select-file-btn').forEach(btn => btn.addEventListener('click', (e) => { const target = e.currentTarget as HTMLElement; state.selectedCaseIdx = parseInt(target.dataset.case!); state.selectedFileIdx = parseInt(target.dataset.file!); render(); }));
    document.querySelectorAll('.rate-input').forEach(input => input.addEventListener('change', (e) => { const el = e.target as HTMLInputElement; (state.rates as any)[el.dataset.key!] = parseFloat(el.value); }));
};

render();
