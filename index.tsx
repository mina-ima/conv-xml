
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
    docNo?: string;
    authorAff?: string;
    authorName?: string;
    noticeBox?: string;
    isBonusNotice?: boolean;
    isStandardNotice?: boolean; 
    isDocNotice?: boolean; 
    paragraphs: string[];
    officeInfo: Record<string, string>;
    sections: {
        name: string;
        isTable: boolean;
        data: any[]; 
    }[];
}

interface AppFile {
    name: string;
    fullPath: string;
    content: string;
    parsed?: XMLNode;
    analysis?: UniversalData;
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
    rates: { health: 9.98, pension: 18.3, nursing: 1.60 }
};

// --- Utilities ---
const robustParseInt = (val: any): number => {
    if (val === undefined || val === null) return NaN;
    const str = String(val)
        .replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
        .replace(/[^0-9]/g, "");
    return parseInt(str, 10);
};

/**
 * 元号と年月日を西暦（Dateオブジェクトまたは数値）に変換する
 */
const convertToWesternDate = (gengo: string, y: any, m: any, d: any = 1): { year: number, month: number, day: number, date: Date | null } => {
    const year = robustParseInt(y);
    const month = robustParseInt(m);
    const day = robustParseInt(d);
    
    if (isNaN(year)) return { year: NaN, month: NaN, day: NaN, date: null };
    
    let wYear = year;
    if (year <= 100) { // 和暦の可能性が高い場合のみ変換
        const g = String(gengo).trim();
        if (g === "1" || g === "明治") wYear = 1867 + year;
        else if (g === "3" || g === "大正") wYear = 1911 + year;
        else if (g === "5" || g === "昭和") wYear = 1925 + year;
        else if (g === "7" || g === "平成") wYear = 1988 + year;
        else if (g === "9" || g === "令和") wYear = 2018 + year;
    }

    if (isNaN(wYear)) return { year: NaN, month: month, day: day, date: null };

    // 月日が不正な場合のフォールバック
    const validMonth = isNaN(month) ? 1 : month;
    const validDay = isNaN(day) ? 1 : day;

    return { 
        year: wYear, 
        month: validMonth, 
        day: validDay, 
        date: new Date(wYear, validMonth - 1, validDay) 
    };
};

const parseAmountValue = (str: string): number => {
    if (!str) return 0;
    const num = robustParseInt(str);
    if (isNaN(num)) return 0;
    return str.includes("千") ? num * 1000 : num;
};

const calculateInsurance = (row: any, rates: typeof state.rates) => {
    const hSalaryStr = row["決定後の標準報酬月額_健保"] || row["決定後の標準賞与額_健保"] || "0";
    const pSalaryStr = row["決定後の標準報酬月額_厚年"] || row["決定後の標準賞与額_厚年"] || "0";
    
    const hSalary = parseAmountValue(hSalaryStr);
    const pSalary = parseAmountValue(pSalaryStr);

    const healthEmp = Math.floor((hSalary * (rates.health / 100)) / 2);
    const pensionEmp = Math.floor((pSalary * (rates.pension / 100)) / 2);
    
    // --- 基準日の算出 (適用年月 or 賞与支払日) ---
    let refDateInfo = convertToWesternDate(row["適用年月_元号"] || row["賞与支払年月日_元号"] || "", row["適用年月_年"] || row["賞与支払年月日_年"], row["適用年月_月"] || row["賞与支払年月日_月"], row["賞与支払年月日_日"] || 1);
    
    // --- 年齢計算 (基準日時点の満年齢) ---
    const birthInfo = convertToWesternDate(row["生年月日_元号"] || "", row["生年月日_年"], row["生年月日_月"], row["生年月日_日"]);
    
    let age = -1;
    let isNursingSubject = false;

    if (refDateInfo.date && birthInfo.date) {
        const rY = refDateInfo.year;
        const rM = refDateInfo.month;
        const rD = refDateInfo.day;
        const bY = birthInfo.year;
        const bM = birthInfo.month;
        const bD = birthInfo.day;

        age = rY - bY;
        // 基準日が誕生日前なら1歳引く
        if (rM < bM || (rM === bM && rD < bD)) {
            age--;
        }
        // 介護保険：基準日時点で40歳以上65歳未満
        isNursingSubject = (age >= 40 && age < 65);
    }

    const nursingEmp = isNursingSubject ? Math.floor((hSalary * (rates.nursing / 100)) / 2) : 0;
    const totalEmp = healthEmp + pensionEmp + nursingEmp;

    return { 
        hSalary, pSalary, healthEmp, pensionEmp, nursingEmp, totalEmp, 
        isNursingSubject, age, 
        birthWestern: birthInfo,
        refWestern: refDateInfo
    };
};

const exportToCSV = (data: UniversalData) => {
    const section = data.sections.find(s => s.isTable);
    if (!section) {
        alert("出力可能なテーブルデータが見つかりませんでした。");
        return;
    }
    const rows = section.data;
    let csv = "\uFEFF"; // UTF-8 BOM
    csv += "整理番号,被保険者氏名,生年月日(西暦),基準日(西暦),年齢,介護判定,標準額(健保),標準額(厚年),健保料(従業員),厚年料(従業員),介護料(従業員),合計(従業員)\n";
    
    rows.forEach(row => {
        const res = calculateInsurance(row, state.rates);
        csv += [
            row["被保険者整理番号"] || "",
            row["被保険者氏名"] || "",
            `${res.birthWestern.year}/${res.birthWestern.month}/${res.birthWestern.day}`,
            `${res.refWestern.year}/${res.refWestern.month}/${res.refWestern.day}`,
            res.age >= 0 ? res.age : "-",
            res.isNursingSubject ? "対象" : "対象外",
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
    link.download = `通知書データ_${data.companyName || 'export'}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

// --- XML Utilities ---
const parseXML = (xmlString: string): XMLNode => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "text/xml");
    if (xmlDoc.getElementsByTagName("parsererror").length > 0) throw new Error(`XMLのパースに失敗しました。`);
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
    return traverse(xmlDoc.documentElement);
};

const extractUniversalData = (node: XMLNode): UniversalData => {
    const officeInfo: Record<string, string> = {};
    const sections: UniversalData['sections'] = [];
    let arrivalNumber = "", postCode = "", address = "", companyName = "", recipientName = "", creationDate = "", docNo = "", noticeBox = "";
    let paragraphs: string[] = [];
    let title = "";

    // _被保険者タグがあるものを通知書として扱う
    const findDeep = (n: XMLNode, targetName: string): XMLNode | undefined => {
        if (n.name === targetName) return n;
        for (const c of n.children) {
            const found = findDeep(c, targetName);
            if (found) return found;
        }
        return undefined;
    };

    const isPensionNotice = findDeep(node, "_被保険者") !== undefined;
    const isDocNotice = node.name === "DOC";

    if (isPensionNotice) {
        const hasBonus = JSON.stringify(node).includes("賞与");
        const isStandard = !hasBonus;

        title = isStandard ? "健康保険・厚生年金保険被保険者標準報酬決定通知書" : "健康保険・厚生年金保険標準賞与額決定通知書";
        const rows: any[] = [];
        
        const collectRows = (n: XMLNode) => {
            if (n.name === "_被保険者") {
                const row: Record<string, string> = {};
                n.children.forEach(gc => {
                    const val = gc.content || "";
                    if (gc.name === "事業所郵便番号_送付先") postCode = val;
                    if (gc.name === "事業所所在地_送付先") address = val;
                    if (gc.name === "事業所名称_送付先") companyName = val;
                    if (gc.name === "事業主氏名_送付先") recipientName = val;
                    if (gc.name === "到達番号_項目") arrivalNumber = val;
                    if (gc.name === "機構からのお知らせ") noticeBox = val;
                    if (gc.name === "通知年月日") creationDate = val;
                    if (gc.name === "事業所整理記号") officeInfo["事業所整理記号"] = val;
                    if (gc.name === "事業所番号") officeInfo["事業所番号"] = val;
                    if (gc.name === "通知管理番号") docNo = val;
                    row[gc.name] = val;
                });
                rows.push(row);
            }
            n.children.forEach(collectRows);
        };
        collectRows(node);

        sections.push({ name: "データ", isTable: true, data: rows });
        return { title, arrivalNumber, postCode, address, companyName, recipientName, creationDate, officeInfo, sections, docNo, paragraphs: [], noticeBox, isStandardNotice: isStandard, isBonusNotice: hasBonus };
    }

    if (isDocNotice) {
        const bodyNode = findDeep(node, "BODY");
        if (bodyNode) {
            bodyNode.children.forEach(c => {
                if (c.name === "DOCNO") docNo = c.content || "";
                if (c.name === "DATE") creationDate = c.content || "";
                if (c.name === "TITLE") title = c.content || "";
                if (c.name === "TO") {
                    companyName = findDeep(c, "AFF")?.content || "";
                    recipientName = (findDeep(c, "NAME")?.content || "") + (findDeep(c, "HONORIFC")?.content || "");
                }
                if (c.name === "MAINTXT" || c.name === "MAINTXT3") {
                    c.children.forEach(gc => { if (gc.name === "P" && gc.content) paragraphs.push(gc.content.trim()); });
                }
            });
        }
        return { title: title || "お知らせ", arrivalNumber, postCode, address, companyName, recipientName, creationDate, officeInfo: {}, sections: [], docNo, paragraphs, isDocNotice: true };
    }

    return { title: "不明な形式", arrivalNumber, postCode, address, companyName, recipientName, creationDate, officeInfo: {}, sections: [], docNo: "", paragraphs: [] };
};

// --- Rendering Functions ---

// Fix: Added missing renderDocNotice function to handle general notices (DOC format)
const renderDocNotice = (data: UniversalData) => {
    return `
        <div class="bg-white shadow-2xl w-full max-w-[800px] min-h-[1000px] p-16 text-slate-900 rounded-sm mb-20 font-['Noto_Sans_JP'] leading-relaxed">
            <div class="flex justify-between mb-12 text-sm font-bold">
                <div>
                    <p class="mb-1">文書番号：${data.docNo || ''}</p>
                    <p>${data.creationDate || ''}</p>
                </div>
            </div>
            <div class="mb-12">
                <p class="text-lg font-bold border-b-2 border-slate-900 inline-block pb-1">${data.companyName || ''}</p>
                <p class="text-lg font-bold mt-1">${data.recipientName || ''}</p>
            </div>
            <div class="text-center mb-16">
                <h1 class="text-2xl font-black tracking-widest underline underline-offset-8 decoration-1">${data.title}</h1>
            </div>
            <div class="space-y-6 text-sm">
                ${data.paragraphs.map(p => `<p>${p}</p>`).join('')}
            </div>
            <div class="mt-20 text-right">
                <p class="text-lg font-bold">日本年金機構</p>
            </div>
        </div>
    `;
};

const renderStandardNotice = (data: UniversalData) => {
    const rows = data.sections[0]?.data || [];
    return `
        <div class="bg-white shadow-2xl w-full max-w-[1000px] min-h-[1200px] p-12 text-slate-900 rounded-sm mb-20 font-['Noto_Sans_JP']">
            <div class="flex justify-between mb-8 text-xs font-bold">
                <div class="space-y-1"><p>${data.postCode || ''}</p><p>${data.address || ''}</p><p class="text-base mt-2">${data.companyName || ''}</p><p class="text-base">${data.recipientName || ''} 様</p></div>
                <div class="text-right"><p>到達番号 ${data.arrivalNumber || ''}</p><div class="border border-slate-900 p-3 mt-2 w-64 h-48 text-left whitespace-pre-wrap overflow-hidden font-normal text-[9px]">${data.noticeBox || ''}</div></div>
            </div>
            <div class="text-center mb-8"><h1 class="text-lg font-bold tracking-widest">${data.title}</h1></div>
            <div class="mb-4 text-sm font-bold flex gap-8"><div>事業所整理記号: ${data.officeInfo["事業所整理記号"] || ''}</div><div>事業所番号: ${data.officeInfo["事業所番号"] || ''}</div></div>
            <table class="w-full border-collapse border border-slate-900 text-[9px] text-center">
                <thead><tr class="bg-slate-50"><th class="border border-slate-900 p-1">整理番号</th><th class="border border-slate-900 p-1">氏名</th><th class="border border-slate-900 p-1">適用年月 (西暦)</th><th class="border border-slate-900 p-1" colspan="2">標準報酬月額</th><th class="border border-slate-900 p-1">生年月日 (西暦)</th><th class="border border-slate-900 p-1">種別</th></tr></thead>
                <tbody>${rows.map(row => {
                    const res = calculateInsurance(row, state.rates);
                    return `<tr>
                        <td class="border border-slate-900 p-2 font-mono">${row["被保険者整理番号"] || ''}</td>
                        <td class="border border-slate-900 p-2 text-left pl-4 font-bold text-xs">${row["被保険者氏名"] || ''}</td>
                        <td class="border border-slate-900 p-2">
                            ${row["適用年月_元号"] || ''}${row["適用年月_年"] || ''}.${row["適用年月_月"] || ''}
                            <div class="text-[8px] text-blue-500 font-mono">(${res.refWestern.year}.${res.refWestern.month})</div>
                        </td>
                        <td class="border border-slate-900 p-2 text-right pr-4 font-mono">${row["決定後の標準報酬月額_健保"] || ''}</td>
                        <td class="border border-slate-900 p-2 text-right pr-4 font-mono">${row["決定後の標準報酬月額_厚年"] || ''}</td>
                        <td class="border border-slate-900 p-2">
                            ${row["生年月日_元号"] || ''}${row["生年月日_年"] || ''}.${row["生年月日_月"] || ''}.${row["生年月日_日"] || ''}
                            <div class="text-[8px] text-emerald-500 font-mono">(${res.birthWestern.year}.${res.birthWestern.month}.${res.birthWestern.day})</div>
                        </td>
                        <td class="border border-slate-900 p-2">${row["種別"] || ''}</td>
                    </tr>`;
                }).join('')}</tbody>
            </table>
            <div class="text-right mt-16 font-bold"><p>${data.creationDate || ''}</p><p class="text-lg mt-2">日本年金機構理事長</p></div>
        </div>
    `;
};

const renderBonusNotice = (data: UniversalData) => {
    const rows = data.sections[0]?.data || [];
    return `
        <div class="bg-white shadow-2xl w-full max-w-[1000px] min-h-[1200px] p-12 text-slate-900 rounded-sm mb-20 font-['Noto_Sans_JP']">
            <div class="flex justify-between mb-8 text-xs font-bold">
                <div class="space-y-1"><p>${data.postCode || ''}</p><p>${data.address || ''}</p><p class="text-base mt-2">${data.companyName || ''}</p><p class="text-base">${data.recipientName || ''} 様</p></div>
                <div class="text-right"><p>到達番号 ${data.arrivalNumber || ''}</p><div class="border border-slate-900 p-3 mt-2 w-64 h-48 text-left whitespace-pre-wrap overflow-hidden font-normal text-[9px]">${data.noticeBox || ''}</div></div>
            </div>
            <div class="text-center mb-8"><h1 class="text-lg font-bold tracking-widest">${data.title}</h1></div>
            <table class="w-full border-collapse border border-slate-900 text-[9px] text-center">
                <thead><tr class="bg-slate-50"><th class="border border-slate-900 p-1">整理番号</th><th class="border border-slate-900 p-1">氏名</th><th class="border border-slate-900 p-1">支払年月日 (西暦)</th><th class="border border-slate-900 p-1" colspan="2">標準賞与額</th><th class="border border-slate-900 p-1">生年月日 (西暦)</th><th class="border border-slate-900 p-1">種別</th></tr></thead>
                <tbody>${rows.map(row => {
                    const res = calculateInsurance(row, state.rates);
                    return `<tr>
                        <td class="border border-slate-900 p-2 font-mono">${row["被保険者整理番号"] || ''}</td>
                        <td class="border border-slate-900 p-2 text-left pl-4 font-bold text-xs">${row["被保険者氏名"] || ''}</td>
                        <td class="border border-slate-900 p-2">
                            ${row["賞与支払年月日_元号"] || ''}${row["賞与支払年月日_年"] || ''}.${row["賞与支払年月日_月"] || ''}.${row["賞与支払年月日_日"] || ''}
                            <div class="text-[8px] text-blue-500 font-mono">(${res.refWestern.year}.${res.refWestern.month}.${res.refWestern.day})</div>
                        </td>
                        <td class="border border-slate-900 p-2 text-right pr-4 font-mono">${row["決定後の標準賞与額_健保"] || ''}</td>
                        <td class="border border-slate-900 p-2 text-right pr-4 font-mono">${row["決定後の標準賞与額_厚年"] || ''}</td>
                        <td class="border border-slate-900 p-2">
                            ${row["生年月日_元号"] || ''}${row["生年月日_年"] || ''}.${row["生年月日_月"] || ''}.${row["生年月日_日"] || ''}
                            <div class="text-[8px] text-emerald-500 font-mono">(${res.birthWestern.year}.${res.birthWestern.month}.${res.birthWestern.day})</div>
                        </td>
                        <td class="border border-slate-900 p-2">${row["種別"] || ''}</td>
                    </tr>`;
                }).join('')}</tbody>
            </table>
            <div class="text-right mt-16 font-bold"><p>${data.creationDate || ''}</p><p class="text-lg mt-2">日本年金機構理事長</p></div>
        </div>
    `;
};

const renderDocument = (data: UniversalData) => {
    if (data.isStandardNotice) return renderStandardNotice(data); 
    if (data.isBonusNotice) return renderBonusNotice(data); 
    if (data.isDocNotice) return renderDocNotice(data);
    return `<div class="p-10 bg-white rounded-xl shadow-sm text-center"><p class="text-slate-500 font-bold mb-4">データの解析に失敗しました。</p><p class="text-xs text-slate-400">XMLの構造が想定と異なっています。</p></div>`;
};

const renderCalculationOverlay = (data: UniversalData) => {
    const rows = data.sections.find(s => s.isTable)?.data || [];
    return `
        <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
            <div class="bg-white rounded-[2.5rem] w-full max-w-7xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
                <div class="p-8 border-b flex justify-between items-center bg-slate-50">
                    <div><h2 class="text-2xl font-black">保険料シミュレーション</h2><p class="text-xs text-slate-500 font-bold mt-1">基準日時点の年齢で計算 | 健保 ${state.rates.health}% / 厚年 ${state.rates.pension}% / 介護 ${state.rates.nursing}%</p></div>
                    <button id="closeCalcBtn" class="w-10 h-10 bg-slate-200 rounded-full flex items-center justify-center cursor-pointer hover:bg-slate-300"><i data-lucide="x"></i></button>
                </div>
                <div class="flex-1 overflow-y-auto p-8">
                    <table class="w-full border-collapse">
                        <thead><tr class="text-[10px] font-black text-slate-400 uppercase tracking-widest border-b"><th class="py-4 text-left">整理番号</th><th class="py-4 text-left">氏名</th><th class="py-4 text-center">年齢 (基準日時点)</th><th class="py-4 text-right">標準額(健保)</th><th class="py-4 text-right">標準額(厚年)</th><th class="py-4 text-right text-blue-600">健康保険料</th><th class="py-4 text-right text-indigo-600">厚生年金料</th><th class="py-4 text-right text-emerald-600">介護保険料</th><th class="py-4 text-right bg-slate-900 text-white rounded-t-xl px-4">合計負担</th></tr></thead>
                        <tbody class="divide-y text-[13px]">${rows.map(row => { 
                            const res = calculateInsurance(row, state.rates); 
                            return `<tr class="hover:bg-slate-50">
                                <td class="py-4 font-mono">${row["被保険者整理番号"] || "-"}</td>
                                <td class="py-4 font-black">${row["被保険者氏名"] || "-"}</td>
                                <td class="py-4 text-center font-bold">
                                    ${res.age >= 0 ? `${res.age}歳` : "-"}
                                    ${res.isNursingSubject ? '<div class="text-[8px] text-emerald-500 font-black">介護対象</div>' : '<div class="text-[8px] text-slate-300">対象外</div>'}
                                </td>
                                <td class="py-4 text-right font-mono">${res.hSalary.toLocaleString()}円</td>
                                <td class="py-4 text-right font-mono">${res.pSalary.toLocaleString()}円</td>
                                <td class="py-4 text-right font-mono font-bold text-blue-600">${res.healthEmp.toLocaleString()}円</td>
                                <td class="py-4 text-right font-mono font-bold text-indigo-600">${res.pensionEmp.toLocaleString()}円</td>
                                <td class="py-4 text-right font-mono font-bold ${res.isNursingSubject ? 'text-emerald-600' : 'text-slate-300'}">
                                    ${res.isNursingSubject ? `${res.nursingEmp.toLocaleString()}円` : `<span class="text-[10px]">対象外</span>`}
                                </td>
                                <td class="py-4 text-right font-mono font-black text-white bg-slate-800 px-4">${res.totalEmp.toLocaleString()}円</td>
                            </tr>`; 
                        }).join('')}</tbody>
                    </table>
                </div>
                <div class="p-8 bg-slate-50 border-t flex justify-between items-center">
                    <p class="text-[11px] text-slate-400 font-bold leading-relaxed">※介護保険料は基準日（適用年月または賞与支払日）において40歳〜64歳の方のみ計算しています。</p>
                    <div class="flex gap-4">
                        <button id="calcToCsvBtn" class="bg-white border border-slate-300 px-8 py-4 rounded-2xl font-black text-xs cursor-pointer hover:bg-slate-100 flex items-center gap-2"><i data-lucide="download" size="16"></i> CSV出力</button>
                        <button id="closeCalcBtnBottom" class="bg-blue-600 text-white px-8 py-4 rounded-2xl font-black text-xs cursor-pointer">確認終了</button>
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
    state.loadingMsg = "高度解析中...";
    render();
    const caseMap = new Map<string, AppFile[]>();
    try {
        for (const f of rawFiles) {
            const processFile = async (path: string, name: string, content: string) => {
                if (!name.toLowerCase().endsWith('.xml')) return;
                try {
                    const parsed = parseXML(content);
                    const analysis = extractUniversalData(parsed);
                    const dirName = path.split('/')[0] || "読み取りファイル";
                    if (!caseMap.has(dirName)) caseMap.set(dirName, []);
                    caseMap.get(dirName)!.push({ name, fullPath: path, content, parsed, analysis });
                } catch (err) { console.error(`解析失敗: ${name}`, err); }
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
    } catch (err) { console.error(err); } finally { state.isLoading = false; render(); }
};

const render = () => {
    const root = document.getElementById('root');
    if (!root) return;
    if (state.isLoading) { root.innerHTML = `<div class="h-screen flex items-center justify-center bg-slate-900 text-white font-black text-2xl animate-pulse">${state.loadingMsg}</div>`; return; }
    if (state.cases.length === 0) {
        root.innerHTML = `<div class="h-screen flex flex-col items-center justify-center bg-slate-50"><div class="bg-white p-20 rounded-[4rem] shadow-2xl border text-center max-w-2xl w-full"><div class="w-20 h-20 bg-blue-600 rounded-3xl flex items-center justify-center mx-auto mb-10 text-white shadow-xl rotate-3"><i data-lucide="upload-cloud" size="40"></i></div><h1 class="text-4xl font-black mb-6 tracking-tighter">e-Gov Pro Assistant</h1><p class="text-slate-500 mb-12">通知書XML（ZIP可）をアップロードしてください</p><div class="grid grid-cols-2 gap-6"><label class="p-8 bg-blue-600 text-white rounded-[2rem] font-black cursor-pointer shadow-lg hover:bg-blue-700">フォルダを選択<input type="file" id="folderInput" class="hidden" webkitdirectory directory /></label><label class="p-8 bg-slate-900 text-white rounded-[2rem] font-black cursor-pointer shadow-lg hover:bg-black">ZIPを選択<input type="file" id="zipInput" class="hidden" accept=".zip" /></label></div></div></div>`;
        document.getElementById('folderInput')?.addEventListener('change', handleUpload);
        document.getElementById('zipInput')?.addEventListener('change', handleUpload);
        if ((window as any).lucide) (window as any).lucide.createIcons();
        return;
    }
    const currentFile = state.cases[state.selectedCaseIdx]?.files[state.selectedFileIdx];
    const data = currentFile?.analysis;

    root.innerHTML = `
        <div class="h-screen flex flex-col bg-slate-100 overflow-hidden no-print">
            <header class="bg-white border-b px-10 py-5 flex items-center justify-between shadow-sm z-50"><div class="flex items-center gap-5"><button id="resetBtn" class="bg-slate-100 p-3 rounded-xl cursor-pointer hover:bg-slate-200"><i data-lucide="home"></i></button><h1 class="text-xl font-black tracking-tight">e-Gov Pro Explorer</h1></div><button id="toggleSettingsTop" class="bg-slate-100 text-slate-600 px-6 py-3 rounded-xl text-xs font-black cursor-pointer hover:bg-slate-200">料率設定</button></header>
            <div class="flex-1 flex overflow-hidden">
                <aside class="w-80 bg-white border-r flex flex-col overflow-hidden"><div class="p-5 border-b bg-slate-50 text-[10px] font-black text-slate-400 uppercase tracking-widest">Case Files</div><div class="flex-1 overflow-y-auto p-3 space-y-2">${state.cases.map((c, cIdx) => `<div><button class="w-full flex items-center gap-2 p-3 font-bold text-slate-700 text-sm hover:bg-slate-50 rounded-lg toggle-case-btn cursor-pointer" data-index="${cIdx}"><i data-lucide="${c.isOpen ? 'chevron-down' : 'chevron-right'}" size="14"></i><span class="truncate font-black text-xs uppercase text-slate-400">${c.folderName}</span></button>${c.isOpen ? c.files.map((f, fIdx) => `<button class="w-full text-left ml-5 p-3 text-xs font-bold rounded-lg mt-1 select-file-btn cursor-pointer ${cIdx === state.selectedCaseIdx && fIdx === state.selectedFileIdx ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:bg-blue-50'}" data-case="${cIdx}" data-file="${fIdx}">${f.name}</button>`).join('') : ''}</div>`).join('')}</div></aside>
                <main class="flex-1 bg-slate-200 overflow-y-auto p-4 md:p-10 flex flex-col items-center relative">
                    <div class="mb-6 flex bg-white p-1.5 rounded-2xl shadow-lg sticky top-0 z-10 no-print"><button id="viewSummaryBtn" class="px-8 py-3 rounded-xl text-xs font-black transition-all cursor-pointer ${state.viewMode === 'summary' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-50'}">通知書表示</button><button id="viewTreeBtn" class="px-8 py-3 rounded-xl text-xs font-black transition-all cursor-pointer ${state.viewMode === 'tree' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-50'}">データ構造</button></div>
                    ${state.viewMode === 'summary' && data && (data.isStandardNotice || data.isBonusNotice) ? `<div class="w-full max-w-[1000px] mb-6 flex justify-between items-center bg-blue-50 border border-blue-200 p-4 rounded-2xl shadow-sm no-print"><div class="flex items-center gap-3 text-blue-900"><div class="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center text-white"><i data-lucide="zap"></i></div><div><p class="text-xs font-black">業務支援メニュー</p><p class="text-[10px] opacity-70">CSV書き出し・計算シミュレーション</p></div></div><div class="flex gap-2"><button id="printBtn" class="bg-white border border-blue-200 text-blue-600 px-4 py-2 rounded-xl text-[11px] font-black hover:bg-blue-100 flex items-center gap-2 cursor-pointer"><i data-lucide="printer" size="14"></i>PDF印刷</button><button id="mainToCsvBtn" class="bg-white border border-blue-200 text-blue-600 px-4 py-2 rounded-xl text-[11px] font-black hover:bg-blue-100 flex items-center gap-2 cursor-pointer"><i data-lucide="file-down" size="14"></i>CSV出力</button><button id="calcMenuBtn" class="bg-blue-600 text-white px-4 py-2 rounded-xl text-[11px] font-black hover:bg-blue-700 shadow-md cursor-pointer">保険料計算</button></div></div>` : ''}
                    <div class="print-container">${state.viewMode === 'summary' && data ? renderDocument(data) : (currentFile ? `<div class="bg-slate-900 p-10 rounded-3xl w-full max-w-4xl text-xs text-blue-100 overflow-auto font-mono">データ構造を表示中...</div>` : '')}</div>
                </main>
            </div>
            ${state.showSettings ? `<div class="fixed inset-0 bg-black/80 backdrop-blur-md z-[300] flex items-center justify-center p-5"><div class="bg-white p-12 rounded-[3rem] max-w-md w-full"><h2 class="text-3xl font-black mb-4">料率設定</h2><div class="space-y-6">${Object.entries(state.rates).map(([k, v]) => `<div><label class="block text-[10px] font-black text-slate-400 mb-2 uppercase">${k} (%)</label><input type="number" step="0.001" value="${v}" data-key="${k}" class="rate-input w-full p-4 bg-slate-100 rounded-2xl font-black text-2xl" /></div>`).join('')}</div><button id="closeSettings" class="w-full mt-10 py-5 bg-blue-600 text-white font-black rounded-2xl shadow-xl hover:scale-105 transition-all cursor-pointer">保存して適用</button></div></div>` : ''}
            ${state.showCalcResults && data ? renderCalculationOverlay(data) : ''}
        </div>
    `;
    attachEvents();
    if ((window as any).lucide) (window as any).lucide.createIcons();
};

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
    
    document.getElementById('mainToCsvBtn')?.addEventListener('click', () => { 
        const currentFile = state.cases[state.selectedCaseIdx]?.files[state.selectedFileIdx];
        if (currentFile?.analysis) exportToCSV(currentFile.analysis);
    });
    document.getElementById('calcToCsvBtn')?.addEventListener('click', () => { 
        const currentFile = state.cases[state.selectedCaseIdx]?.files[state.selectedFileIdx];
        if (currentFile?.analysis) exportToCSV(currentFile.analysis);
    });

    document.querySelectorAll('.toggle-case-btn').forEach(btn => btn.addEventListener('click', (e) => { const idx = parseInt((e.currentTarget as HTMLElement).dataset.index!); state.cases[idx].isOpen = !state.cases[idx].isOpen; render(); }));
    document.querySelectorAll('.select-file-btn').forEach(btn => btn.addEventListener('click', (e) => { const target = e.currentTarget as HTMLElement; state.selectedCaseIdx = parseInt(target.dataset.case!); state.selectedFileIdx = parseInt(target.dataset.file!); render(); }));
    document.querySelectorAll('.rate-input').forEach(input => input.addEventListener('change', (e) => { const el = e.target as HTMLInputElement; (state.rates as any)[el.dataset.key!] = parseFloat(el.value); }));
};

render();
