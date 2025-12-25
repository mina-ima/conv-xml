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
    creationDateJP?: string;
    docNo?: string;
    idInfoPrefix?: string;
    idInfoSuffix?: string;
    officeRegistry?: { pref: string, dist: string, code: string };
    officeNo?: string;
    counts?: Record<string, string>;
    zipCodePrefix?: string;
    zipCodeSuffix?: string;
    address?: string;
    companyName?: string;
    ownerName?: string;
    phone?: { area: string, city: string, num: string };
    submissionDateJP?: string;
    attachmentStatus?: { mail: boolean, elec: boolean, none: boolean };
    paperNoticeDesired?: boolean;
    proxyName?: string;
    remarks?: string;
    arrivalNumber?: string;
    noticeBox?: string;
    rows: any[];
    officeRegistryNotice?: string;
    officeNoNotice?: string;
    pensionOffice?: string;
    noticeMgmtNo?: string;
    noticeMgmtBranch?: string;
    senderAff?: string;
    senderName?: string;
    mainText?: string[];
    appendices?: { title: string, text?: string }[];
    recipient?: { aff?: string, name?: string, honorific?: string };
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
    viewMode: 'summary' as 'summary' | 'tree' | 'calculator',
    isLoading: false,
    loadingMsg: "",
    rates: { 
        health: 10.0,
        pension: 18.3,
        nursing: 1.6,
        isNursingTarget: true
    }
};

// --- Utilities ---
const normalize = (val: any): string => {
    if (val === undefined || val === null) return "";
    return String(val).replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).trim();
};

const parseStandardAmount = (val: string): number => {
    if (!val) return 0;
    const cleaned = normalize(val).replace(/[^0-9]/g, "");
    return parseInt(cleaned, 10) || 0;
};

const calculateAge = (birthDateAD: string): number => {
    if (!birthDateAD) return 0;
    const birth = new Date(birthDateAD);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
        age--;
    }
    return age;
};

const ERA_MAP: Record<string, string> = { "1": "明治", "3": "大正", "5": "昭和", "7": "平成", "9": "令和", "S": "昭和", "H": "平成", "R": "令和" };
const ERA_OFFSETS: Record<string, number> = { "1": 1867, "3": 1911, "5": 1925, "7": 1988, "9": 2018, "S": 1925, "H": 1988, "R": 2018 };

const getFormattedDates = (g: any, y: any, m: any, d: any = "1") => {
    const gn = normalize(g);
    const yn = parseInt(normalize(y).replace(/[^0-9]/g, ""), 10);
    const mn = parseInt(normalize(m).replace(/[^0-9]/g, ""), 10);
    const dn = parseInt(normalize(d).replace(/[^0-9]/g, ""), 10);
    if (isNaN(yn)) return { ad: "", jp: "", fullJp: "" };
    const offset = ERA_OFFSETS[gn] || 0;
    const yearAD = yn + offset;
    const eraName = ERA_MAP[gn] || "令和";
    const eraChar = gn.length === 1 && !isNaN(parseInt(gn)) ? (gn === "9" ? "R" : gn === "7" ? "H" : gn === "5" ? "S" : gn) : gn;
    
    return {
        ad: `${yearAD}/${String(mn).padStart(2, '0')}/${String(dn).padStart(2, '0')}`,
        jp: `${eraChar}${String(yn).padStart(2, '0')}.${String(mn).padStart(2, '0')}.${String(dn).padStart(2, '0')}`,
        fullJp: `${eraName} ${yn} 年 ${mn} 月 ${dn} 日`
    };
};

// --- Data Extraction ---
const extractDetailed = (node: XMLNode): UniversalData | null => {
    const dataMap: Record<string, any> = {};
    const mainText: string[] = [];
    const appendices: { title: string, text?: string }[] = [];
    let recipient: any = {};
    let author: any = {};

    const traverse = (n: XMLNode) => {
        if (n.content !== undefined && n.content !== "") {
            dataMap[n.name] = n.content;
        }
        if (n.name === "P") {
            if (n.content) mainText.push(n.content);
        }
        if (n.name === "APPENDIX") {
            const titleNode = n.children.find(c => c.name === "APPTITLE");
            if (titleNode && titleNode.content) {
                appendices.push({ 
                    title: titleNode.content,
                    text: n.children.find(c => c.name === "APPTEXT")?.content
                });
            }
        }
        if (n.name === "TO") {
            recipient.aff = n.children.find(c => c.name === "AFF")?.content;
            recipient.name = n.children.find(c => c.name === "NAME")?.content;
            recipient.honorific = n.children.find(c => c.name === "HONORIFC")?.content;
        }
        if (n.name === "AUTHOR") {
            author.aff = n.children.find(c => c.name === "AFF")?.content;
            author.name = n.children.find(c => c.name === "NAME")?.content;
        }
        n.children.forEach(traverse);
    };
    traverse(node);

    if (node.name === "DOC" || dataMap["TITLE"] === "日本年金機構からのお知らせ") {
        return {
            docType: 'ANNOUNCEMENT',
            title: dataMap["TITLE"] || "日本年金機構からのお知らせ",
            docNo: dataMap["DOCNO"] || "",
            creationDateJP: dataMap["DATE"] || "",
            recipient: recipient,
            senderAff: author.aff || "",
            senderName: author.name || "",
            mainText: mainText,
            appendices: appendices,
            rows: []
        };
    }

    if (dataMap["識別情報x提出元ID"] || dataMap["届書総件数x届書合計"] || node.name === "DataRoot") {
        const targetNode = node.children.find(c => c.name.includes("-001_1")) || node;
        const creationNode = targetNode.children.find(c => c.name === "作成年月日");
        const cY = creationNode?.children.find(c => c.name === "年")?.content;
        const cM = creationNode?.children.find(c => c.name === "月")?.content;
        const cD = creationNode?.children.find(c => c.name === "日")?.content;
        const createDate = getFormattedDates("9", cY, cM, cD);
        const submissionNode = targetNode.children.find(c => c.name === "提出年月日");
        const sY = submissionNode?.children.find(c => c.name === "年")?.content;
        const sM = submissionNode?.children.find(c => c.name === "月")?.content;
        const sD = submissionNode?.children.find(c => c.name === "日")?.content;
        const submissionDate = getFormattedDates("9", sY, sM, sD);
        const phoneNode = targetNode.children.find(c => c.name === "電話番号");
        const attachNode = targetNode.children.find(c => c.name === "添付書類");

        return {
            docType: 'SUMMARY',
            title: "CSV形式届書総括票",
            idInfoPrefix: dataMap["識別情報x提出元ID"] || "",
            idInfoSuffix: dataMap["識別情報x通番"] || "",
            creationDateJP: createDate.fullJp,
            officeRegistry: {
                pref: dataMap["事業所整理記号x都道府県コード"] || "",
                dist: dataMap["事業所整理記号x郡市区記号"] || "",
                code: dataMap["事業所整理記号x事業所記号"] || ""
            },
            officeNo: dataMap["事業所番号"] || "",
            zipCodePrefix: dataMap["事業所所在地x郵便番号x親番号"] || "",
            zipCodeSuffix: dataMap["事業所所在地x郵便番号x子番号"] || "",
            address: dataMap["事業所所在地"] || "",
            companyName: dataMap["事業所名称"] || "",
            ownerName: dataMap["事業主氏名"] || "",
            phone: {
                area: phoneNode?.children.find(c => c.name === "市外局番")?.content || "",
                city: phoneNode?.children.find(c => c.name === "局番")?.content || "",
                num: phoneNode?.children.find(c => c.name === "番号")?.content || ""
            },
            submissionDateJP: submissionDate.fullJp,
            attachmentStatus: {
                mail: (attachNode?.children.find(c => c.name === "郵送")?.content === "1") || (dataMap["郵送"] === "1"),
                elec: (attachNode?.children.find(c => c.name === "電子")?.content === "1") || (dataMap["電子"] === "1"),
                none: (attachNode?.children.find(c => c.name === "なし")?.content === "1") || (dataMap["なし"] === "1")
            },
            paperNoticeDesired: dataMap["通知書希望形式"] === "1",
            proxyName: dataMap["社会保険労務士の提出代行者名"] || "",
            remarks: dataMap["備考"] || "",
            counts: {
                "資格取得": dataMap["届書総件数x資格取得届70歳以上被用者該当届"] || "",
                "被扶養者": dataMap["届書数x被扶養者異動届国年3号被保険者関係届"] || "",
                "資格喪失": dataMap["届書数x資格喪失届70歳以上被用者不該当届"] || "",
                "月額変更": dataMap["届書数x月額変更届70歳以上被用者月額変更届"] || "",
                "算定基礎": dataMap["届書数x算定基礎届70歳以上被用者算定基礎届"] || "",
                "賞与支払": dataMap["届書数x賞与支払届70歳以上被用者賞与支払届"] || "",
                "育児休業": dataMap["届書数x育児休業等取得者申出書終了届"] || dataMap["届書数x育児休業等取得者申出書(新規・延長)／終了届"] || "",
                "産前産後": dataMap["届書数x産前産後休業取得者申出書変更届"] || dataMap["届書数x産前産後休業取得者申出書／変更(終了)届"] || "",
                "合計": dataMap["届書総件数x届書合計"] || "",
                "国年3号": dataMap["届書総件数x国年x国民年金第3号被保険者関係届"] || "",
                "国年合計": dataMap["届書総件数x国年x届書合計"] || ""
            },
            rows: []
        };
    }

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
            rows,
            arrivalNumber: h["到達番号_項目"] || "",
            noticeBox: h["機構からのお知らせ"] || "",
            zipCodeSuffix: h["事業所郵便番号_送付先"] || "",
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

// --- Export Functions ---
const downloadCSV = () => {
    const data = state.cases[state.selectedCaseIdx]?.files[state.selectedFileIdx]?.analysis;
    if (!data) return;
    const isBonus = data.docType === 'BONUS_NOTICE';

    let csv = "";
    if (state.viewMode === 'calculator') {
        const headers = ["氏名", "年齢", "健保標準額", "厚年標準額", "健保控除", "厚年控除", "介護控除", "控除額合計"];
        csv = [headers.join(","), ...data.rows.map(r => {
            const birthData = getFormattedDates(r["生年月日_元号"], r["生年月日_年"], r["生年月日_月"], r["生年月日_日"]);
            const age = calculateAge(birthData.ad);
            const rawAmtH = parseStandardAmount(r[isBonus ? "決定後の標準賞与額_健保" : "決定後の標準報酬月額_健保"]);
            const rawAmtP = parseStandardAmount(r[isBonus ? "決定後の標準賞与額_厚年" : "決定後の標準報酬月額_厚年"]);
            const amtH = rawAmtH * 1000;
            const amtP = rawAmtP * 1000;
            const isNursingTargetAge = age >= 40 && age <= 64;
            const isNursingActive = state.rates.isNursingTarget ? isNursingTargetAge : false;
            const hDeduct = Math.floor(amtH * (state.rates.health / 100) / 2);
            const pDeduct = Math.floor(amtP * (state.rates.pension / 100) / 2);
            const nDeduct = isNursingActive ? Math.floor(amtH * (state.rates.nursing / 100) / 2) : 0;
            const total = hDeduct + pDeduct + nDeduct;
            return [`"${normalize(r["被保険者氏名"])}"`, age, amtH, amtP, hDeduct, pDeduct, nDeduct, total].join(",");
        })].join("\n");
    } else {
        const h = ["整理番号", "氏名", "支払日/適用月", "標準額(健保)", "標準額(厚年)", "生年月日", "種別"];
        csv = [h.join(","), ...data.rows.map(r => {
            const datePrefix = isBonus ? "賞与支払年月日" : "適用年月";
            const payDate = getFormattedDates(r[`${datePrefix}_元号`], r[`${datePrefix}_年`], r[`${datePrefix}_月`], r[`${datePrefix}_日`] || "1").ad;
            const birthDate = getFormattedDates(r["生年月日_元号"], r["生年月日_年"], r["生年月日_月"], r["生年月日_日"]).ad;
            let amtH = parseStandardAmount(r[isBonus ? "決定後の標準賞与額_健保" : "決定後の標準報酬月額_健保"]);
            let amtP = parseStandardAmount(r[isBonus ? "決定後の標準賞与額_厚年" : "決定後の標準報酬月額_厚年"]);
            amtH *= 1000;
            amtP *= 1000;
            return [normalize(r["被保険者整理番号"]), `"${normalize(r["被保険者氏名"])}"`, payDate, amtH, amtP, birthDate, normalize(r["種別"])].join(",");
        })].join("\n");
    }
    
    const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${data.title}_${state.viewMode === 'calculator' ? '控除シミュレーション' : 'データ一覧'}.csv`;
    link.click();
};

const renderAnnouncementSheet = (data: UniversalData) => {
    return `
        <div class="bg-white w-[1000px] min-h-[1414px] p-24 text-black shadow-2xl relative font-['Noto_Sans_JP'] border border-slate-200 mx-auto print:shadow-none print:border-none">
            <div class="flex flex-col items-end text-lg font-bold mb-8">
                <p>${data.docNo || ''}</p>
                <p>${data.creationDateJP || ''}</p>
            </div>
            <div class="mb-16"><p class="text-xl font-bold">${data.recipient?.aff || ''}</p><p class="text-xl font-bold">${data.recipient?.name || ''}　${data.recipient?.honorific || ''}</p></div>
            <div class="flex flex-col items-end mb-24"><p class="text-lg font-bold">${data.senderAff || ''}</p><p class="text-lg font-bold">${data.senderName || ''}</p></div>
            <div class="text-center mb-16"><h1 class="text-3xl font-black tracking-tight">${data.title}</h1></div>
            <div class="text-lg leading-relaxed space-y-6 mb-16 text-justify">${(data.mainText || []).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')}</div>
            <div class="space-y-4 no-print">${(data.appendices || []).map(app => `<div class="text-blue-600 font-black text-xl underline cursor-pointer hover:text-blue-800">${app.title}</div>`).join('')}</div>
        </div>
    `;
};

const renderSummarySheet = (data: UniversalData) => {
    const labelClass = "px-2 py-1 flex items-center h-full border-r border-black text-[11px] leading-tight font-bold";
    const countValClass = "flex-1 px-4 py-1 text-right text-[14px] font-mono tracking-wider";
    return `
        <div class="bg-white w-[1120px] min-h-[1580px] p-[50px] text-black shadow-2xl relative font-['MS_PMincho', 'serif'] border border-gray-400 mx-auto print:shadow-none print:border-none">
            <div class="flex justify-between items-start mb-8">
                <div class="text-[13px] font-bold leading-tight">健康保険<br>厚生年金保険<br>国民年金</div>
                <div class="absolute left-1/2 -translate-x-1/2 text-[28px] font-bold tracking-[0.5em] pt-2">ＣＳＶ形式届書総括票</div>
                <div class="border-2 border-black px-5 py-2 font-bold text-[18px]">電子申請用</div>
            </div>
            <div class="grid grid-cols-2 gap-x-20 gap-y-4 mb-8 text-[14px]">
                <div class="flex items-center"><span class="w-[100px] font-bold">①識別情報</span><div class="flex-1 flex items-center border-b border-black font-mono py-1"><span class="px-4">${data.idInfoPrefix}</span><span class="mx-auto">－</span><span class="px-4">${data.idInfoSuffix}</span></div></div>
                <div class="flex items-center"><span class="w-[100px] font-bold">②作成年月日</span><span class="flex-1 px-4 font-bold border-b border-black text-center py-1">${data.creationDateJP}</span></div>
                <div class="flex items-center"><span class="w-[120px] font-bold">③事業所整理記号</span><div class="flex-1 flex items-center border-b border-black font-mono py-1"><span class="px-4">${data.officeRegistry?.pref}</span><span class="px-4">${data.officeRegistry?.dist}</span><span class="mx-auto">－</span><span class="px-4">${data.officeRegistry?.code}</span></div></div>
                <div class="flex items-center"><span class="w-[100px] font-bold">④事業所番号</span><span class="flex-1 px-4 font-mono border-b border-black text-center py-1">${data.officeNo}</span></div>
            </div>
            <div class="flex gap-4">
                <div class="w-[40px] flex flex-col items-center text-[10px] leading-tight space-y-8 pt-4 font-bold select-none opacity-80" style="writing-mode: vertical-rl;"><p>◎必ず電子署名を付して申請してください。</p><p>◎入力方法については、記載要領をご覧ください。</p></div>
                <div class="flex-1 flex gap-4">
                    <div class="flex-1">
                        <p class="text-[12px] font-bold mb-1 text-center">届書総件数（健康保険・厚生年金保険）</p>
                        <div class="border-2 border-black text-[12px]">
                            <div class="flex h-11 border-b border-black"><span class="w-[320px] ${labelClass}">⑤資格取得届／70歳以上被用者該当届</span><span class="${countValClass}">${data.counts?.["資格取得"] || ""} 件</span></div>
                            <div class="flex h-11 border-b border-black"><span class="w-[320px] ${labelClass}">⑥被扶養者異動届／国民年金第３号被保険者関係届</span><span class="${countValClass}">${data.counts?.["被扶養者"] || ""} 件</span></div>
                            <div class="flex h-11 border-b border-black"><span class="w-[320px] ${labelClass}">⑦資格喪失届／70歳以上被用者不該当届</span><span class="${countValClass}">${data.counts?.["資格喪失"] || ""} 件</span></div>
                            <div class="flex h-11 border-b border-black"><span class="w-[320px] ${labelClass}">⑧月額変更届／70歳以上被用者月額変更届</span><span class="${countValClass}">${data.counts?.["月額変更"] || ""} 件</span></div>
                            <div class="flex h-11 border-b border-black"><span class="w-[320px] ${labelClass}">⑨算定基礎届／70歳以上被用者算定基礎届</span><span class="${countValClass}">${data.counts?.["算定基礎"] || ""} 件</span></div>
                            <div class="flex h-11 border-b border-black"><span class="w-[320px] ${labelClass}">⑩賞与支払届／70歳以上被用者賞与支払届</span><span class="${countValClass}">${data.counts?.["賞与支払"] || ""} 件</span></div>
                            <div class="flex h-11 border-b border-black"><span class="w-[320px] ${labelClass}">⑪育児休業等取得者申出書(新規・延長)／終了届</span><span class="${countValClass}">${data.counts?.["育児休業"] || ""} 件</span></div>
                            <div class="flex h-11 border-b border-black"><span class="w-[320px] ${labelClass}">⑫産前産後休業取得者申出書／変更(終了)届</span><span class="${countValClass}">${data.counts?.["産前産後"] || ""} 件</span></div>
                            <div class="flex h-12 bg-gray-50 font-bold"><span class="w-[180px] mx-auto text-center border-l border-r border-black flex items-center justify-center">⑬届書合計</span><span class="${countValClass} border-l border-black flex items-center justify-end">${data.counts?.["合計"] || ""} 件</span></div>
                        </div>
                    </div>
                    <div class="w-[450px] flex gap-4">
                        <div class="flex-1 flex flex-col">
                            <p class="text-[12px] font-bold mb-1 text-center">届書総件数（国民年金）</p>
                            <div class="border-2 border-black h-[400px]">
                                <div class="flex h-11 border-b border-black"><span class="w-[280px] ${labelClass}">⑭国民年金第３号被保険者関係届</span><span class="${countValClass}">${data.counts?.["国年3号"] || ""} 件</span></div>
                                <div class="mt-auto flex h-12 bg-gray-50 font-bold border-t border-black"><span class="w-[140px] mx-auto text-center border-l border-r border-black flex items-center justify-center">⑮届書合計</span><span class="${countValClass} border-l border-black flex items-center justify-end">${data.counts?.["国年合計"] || ""} 件</span></div>
                            </div>
                            <div class="mt-8 text-center text-[15px] font-bold">${data.submissionDateJP} 提出</div>
                        </div>
                        <div class="w-[140px] flex flex-col"><p class="text-[12px] font-bold mb-1 text-center">⑯ 備考</p><div class="flex-1 border-2 border-black p-4 text-[11px] leading-relaxed break-all">${data.remarks || ""}</div></div>
                    </div>
                </div>
            </div>
            <div class="mt-12 flex gap-10">
                <div class="flex-1 border-2 border-black p-8 text-[15px] font-bold space-y-6">
                    <div class="flex items-center"><span class="w-[120px]">⑰ 郵便番号</span><div class="flex items-baseline font-mono text-[18px]"><span class="mr-4">〒</span><span class="px-2">${data.zipCodePrefix}</span><span class="mx-4">－</span><span class="px-2">${data.zipCodeSuffix}</span></div></div>
                    <div class="flex items-start"><span class="w-[120px]">所在地</span><span class="flex-1 leading-relaxed pl-4">${data.address}</span></div>
                    <div class="flex items-center"><span class="w-[120px]">名称</span><span class="flex-1 pl-4">${data.companyName}</span></div>
                    <div class="flex items-center"><span class="w-[120px]">氏名</span><span class="flex-1 pl-4">${data.ownerName}</span></div>
                    <div class="flex items-baseline"><span class="w-[120px]">電話番号</span><div class="flex items-baseline font-mono text-[18px] pl-4"><span class="px-2">${data.phone?.area}</span><span class="mx-2">（</span><span class="px-2">${data.phone?.city} 局</span><span class="mx-2">）</span><span class="px-2">${data.phone?.num} 番</span></div></div>
                </div>
                <div class="w-[500px] space-y-6">
                    <div class="border-2 border-black"><div class="bg-gray-50 border-b-2 border-black p-2 text-center font-bold text-[13px]">⑱ 代行者名記載欄</div><div class="h-[100px] p-6 text-[16px] leading-relaxed">${data.proxyName || ""}</div></div>
                    <div class="border-2 border-black p-6 space-y-6">
                        <div class="flex justify-between items-start text-[12px]"><div class="flex flex-col gap-1"><span class="font-bold">⑲ （通知書）</span><span>紙の通知書を希望しますか</span></div><div class="flex items-center gap-4 pt-2"><span class="font-bold">希望します</span><div class="w-6 h-6 border-2 border-black flex items-center justify-center font-bold bg-white text-lg">${data.paperNoticeDesired ? '✓' : ''}</div></div></div>
                        <div class="flex justify-between items-center text-[12px] pt-6 border-t-2 border-dotted border-gray-300">
                            <span class="font-bold">⑳ （添付書類）</span>
                            <div class="flex gap-8 items-center font-bold">${["郵送", "電子", "なし"].map(l => `<div class="flex items-center gap-3"><span>${l}</span><div class="w-5 h-5 border-2 border-black flex items-center justify-center">${(l === "なし" && data.attachmentStatus?.none) || (l === "郵送" && data.attachmentStatus?.mail) || (l === "電子" && data.attachmentStatus?.elec) ? '✓' : ''}</div></div>`).join('')}</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
};

const renderNoticeSheet = (data: UniversalData) => {
    const isBonusDoc = data.docType === 'BONUS_NOTICE';
    return `
        <div class="bg-white w-[1000px] min-h-[1414px] p-16 text-black shadow-2xl relative font-['Noto_Sans_JP'] border border-slate-200 mx-auto print:shadow-none print:border-none">
            <div class="flex justify-between items-start mb-10">
                <div class="text-[14px] leading-relaxed space-y-1"><p class="font-bold text-lg">${data.zipCodeSuffix || ''}</p><p class="text-base">${data.address || ''}</p><p class="pt-4 text-2xl font-black tracking-tighter">${data.companyName || ''}</p><p class="text-2xl font-black">${data.ownerName || ''}　　様</p></div>
                <div class="flex flex-col items-end"><p class="text-sm font-bold mb-1">到達番号 ${data.arrivalNumber || ''}</p><div class="border border-black p-4 w-[380px] h-[260px] text-[13px] leading-relaxed overflow-hidden text-justify">${data.noticeBox || ''}</div></div>
            </div>
            <div class="text-center mb-16 mt-8"><h1 class="text-3xl font-black tracking-tight">${data.title}</h1></div>
            <table class="w-full border-collapse border-[1.5px] border-black text-sm mb-12">
                <thead class="bg-gray-50"><tr class="h-14"><th class="border border-black px-1 py-1 font-bold w-20">整理番号</th><th class="border border-black px-4 py-1 font-bold">氏名</th><th class="border border-black px-1 py-1 font-bold w-32">${isBonusDoc ? '支払年月日' : '適用年月'}<br>(西暦)</th><th class="border border-black px-1 py-1 font-bold" colspan="2">${isBonusDoc ? '標準賞与額' : '標準報酬月額'}</th><th class="border border-black px-1 py-1 font-bold w-32">生年月日<br>(西暦)</th><th class="border border-black px-1 py-1 font-bold w-20">種別</th></tr></thead>
                <tbody>${data.rows.map(r => {
                    const datePrefix = isBonusDoc ? "賞与支払年月日" : "適用年月";
                    const payDate = getFormattedDates(r[`${datePrefix}_元号`], r[`${datePrefix}_年`], r[`${datePrefix}_月`], r[`${datePrefix}_日`] || "1");
                    const birthDate = getFormattedDates(r["生年月日_元号"], r["生年月日_年"], r["生年月日_月"], r["生年月日_日"]);
                    const val1 = parseStandardAmount(r[isBonusDoc ? "決定後の標準賞与額_健保" : "決定後の標準報酬月額_健保"]).toLocaleString();
                    const val2 = parseStandardAmount(r[isBonusDoc ? "決定後の標準賞与額_厚年" : "決定後の標準報酬月額_厚年"]).toLocaleString();
                    return `<tr class="h-20 text-center border-b border-black"><td class="border-r border-black">${normalize(r["被保険者整理番号"] || "")}</td><td class="border-r border-black text-left px-6 font-black text-xl">${normalize(r["被保険者氏名"] || "")}</td><td class="border-r border-black"><div>${payDate.jp}</div><div class="text-blue-600 text-[11px] font-bold">(${payDate.ad})</div></td><td class="border-r border-black px-2 font-black text-lg w-32"><div class="text-[10px] font-normal text-slate-400 mb-1">(健保)</div>${val1}千円</td><td class="border-r border-black px-2 font-black text-lg w-32"><div class="text-[10px] font-normal text-slate-400 mb-1">(厚年)</div>${val2}千円</td><td class="border-r border-black"><div>${birthDate.jp}</div><div class="text-emerald-600 text-[11px] font-bold">(${birthDate.ad})</div></td><td>${normalize(r["種別"] || "")}</td></tr>`;
                }).join('')}</tbody>
            </table>
            <div class="mt-20 text-right space-y-4"><p class="text-lg font-bold underline underline-offset-4 decoration-slate-300">${data.creationDateJP || ''}</p><div class="pt-6"><p class="text-2xl font-black tracking-[0.3em]">日本年金機構理事長</p><p class="text-lg font-bold text-slate-600">(${data.pensionOffice || ''}年金事務所)</p></div></div>
        </div>
    `;
};

const renderCalculatorView = (data: UniversalData) => {
    const isBonus = data.docType === 'BONUS_NOTICE';
    return `
        <div class="bg-white w-[1150px] min-h-[800px] p-10 text-black shadow-2xl font-['Noto_Sans_JP'] border border-gray-300 mx-auto rounded-3xl print:shadow-none print:border-none">
            <div class="flex justify-between items-center mb-8 border-b pb-6">
                <div>
                    <h2 class="text-3xl font-black text-slate-900">${data.title} - 社会保険料算出</h2>
                    <p class="text-slate-500 mt-2 font-bold">被保険者負担分シミュレーション (個人負担=事業主折半後)</p>
                </div>
                <div class="bg-blue-50 p-6 rounded-2xl border border-blue-100 grid grid-cols-2 gap-x-6 gap-y-3 shadow-inner no-print">
                    <div class="flex flex-col"><label class="text-[11px] font-bold text-blue-600 mb-1">健康保険料率 (%)</label><input type="number" step="0.001" value="${state.rates.health}" class="border rounded-lg px-3 py-1 font-bold" id="rate-health"></div>
                    <div class="flex flex-col"><label class="text-[11px] font-bold text-blue-600 mb-1">厚生年金料率 (%)</label><input type="number" step="0.001" value="${state.rates.pension}" class="border rounded-lg px-3 py-1 font-bold" id="rate-pension"></div>
                    <div class="flex flex-col"><label class="text-[11px] font-bold text-blue-600 mb-1">介護保険料率 (%)</label><input type="number" step="0.001" value="${state.rates.nursing}" class="border rounded-lg px-3 py-1 font-bold" id="rate-nursing"></div>
                    <div class="flex items-end pb-1"><div class="flex items-center gap-2 bg-white px-3 py-1 rounded-lg border border-blue-100 w-full shadow-sm"><input type="checkbox" id="calc-nursing" ${state.rates.isNursingTarget ? 'checked' : ''} class="w-4 h-4"><label class="text-[12px] font-bold text-slate-700" for="calc-nursing">自動判定(40-64歳)を優先</label></div></div>
                </div>
            </div>
            <table class="w-full border-collapse border border-slate-200">
                <thead class="bg-slate-800 text-white text-[12px] print:bg-slate-200 print:text-black">
                    <tr class="h-14">
                        <th class="px-3 border border-slate-600">氏名</th>
                        <th class="px-2 border border-slate-600 w-16 text-center">年齢</th>
                        <th class="px-3 border border-slate-600 text-right">健保標準額</th>
                        <th class="px-3 border border-slate-600 text-right">厚年標準額</th>
                        <th class="px-3 border border-slate-600 text-right bg-blue-900/40 print:bg-blue-100">健保控除</th>
                        <th class="px-3 border border-slate-600 text-right bg-indigo-900/40 print:bg-indigo-100">厚年控除</th>
                        <th class="px-3 border border-slate-600 text-right bg-teal-900/40 print:bg-teal-100">介護控除</th>
                        <th class="px-4 border border-slate-600 text-right bg-slate-900 text-[14px] print:bg-slate-300">控除額合計</th>
                    </tr>
                </thead>
                <tbody class="text-[14px]">
                    ${data.rows.map(r => {
                        const birthData = getFormattedDates(r["生年月日_元号"], r["生年月日_年"], r["生年月日_月"], r["生年月日_日"]);
                        const age = calculateAge(birthData.ad);
                        const rawAmtH = parseStandardAmount(r[isBonus ? "決定後の標準賞与額_健保" : "決定後の標準報酬月額_健保"]);
                        const rawAmtP = parseStandardAmount(r[isBonus ? "決定後の標準賞与額_厚年" : "決定後の標準報酬月額_厚年"]);
                        const amtH = rawAmtH * 1000;
                        const amtP = rawAmtP * 1000;
                        const isNursingTargetAge = age >= 40 && age <= 64;
                        const isNursingActive = state.rates.isNursingTarget ? isNursingTargetAge : false;
                        const hDeduct = Math.floor(amtH * (state.rates.health / 100) / 2);
                        const pDeduct = Math.floor(amtP * (state.rates.pension / 100) / 2);
                        const nDeduct = isNursingActive ? Math.floor(amtH * (state.rates.nursing / 100) / 2) : 0;
                        const total = hDeduct + pDeduct + nDeduct;
                        return `
                        <tr class="h-14 border-b border-slate-100 hover:bg-slate-50 transition-colors">
                            <td class="px-3 font-bold text-slate-900 text-lg">${normalize(r["被保険者氏名"])}</td>
                            <td class="px-2 text-center font-bold ${isNursingTargetAge ? 'text-teal-600' : 'text-slate-400'}">${age}歳</td>
                            <td class="px-3 text-right font-mono text-slate-600">${amtH.toLocaleString()}円</td>
                            <td class="px-3 text-right font-mono text-slate-600">${amtP.toLocaleString()}円</td>
                            <td class="px-3 text-right font-mono text-blue-800 font-bold">${hDeduct.toLocaleString()}円</td>
                            <td class="px-3 text-right font-mono text-indigo-800 font-bold">${pDeduct.toLocaleString()}円</td>
                            <td class="px-3 text-right font-mono ${nDeduct > 0 ? 'text-teal-800 font-bold' : 'text-slate-300'}">${nDeduct > 0 ? nDeduct.toLocaleString() + '円' : '-'}</td>
                            <td class="px-4 text-right font-mono text-2xl font-black bg-slate-50 text-slate-900 print:bg-slate-100">${total.toLocaleString()}円</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
            <div class="mt-6 p-4 bg-gray-50 rounded-xl border border-gray-100 text-[11px] text-gray-500 space-y-1">
                <p class="font-bold text-slate-700">【計算根拠について】</p>
                <p>※1. <b>単位換算:</b> XML内の標準額（千円単位）を1,000倍して円単位として算出しています。</p>
                <p>※2. <b>介護保険料:</b> 年齢が40歳以上64歳以下の被保険者を自動判定して個別に算出しています。</p>
                <p>※3. <b>端数処理:</b> 各項目ごとに端数は切捨て処理を行っています。端数処理設定（50銭等）により数円の誤差が出る場合があります。</p>
            </div>
        </div>
    `;
};

const render = () => {
    const root = document.getElementById('root');
    if (!root) return;
    if (state.isLoading) { root.innerHTML = `<div class="h-screen flex items-center justify-center bg-slate-900 text-white animate-pulse text-xl">解析中...</div>`; return; }
    if (state.cases.length === 0) {
        root.innerHTML = `<div class="h-screen flex items-center justify-center bg-slate-50"><label class="bg-blue-600 text-white px-10 py-5 rounded-2xl font-bold cursor-pointer shadow-xl hover:bg-blue-700 transition-all">ファイル読込 (XML/ZIP)<input type="file" id="zipIn" class="hidden" accept=".zip,.xml" /></label></div>`;
        document.getElementById('zipIn')?.addEventListener('change', handleUpload); return;
    }
    const cur = state.cases[state.selectedCaseIdx]?.files[state.selectedFileIdx];
    const data = cur?.analysis;
    const isNotice = data?.docType === 'NOTICE' || data?.docType === 'BONUS_NOTICE';

    root.innerHTML = `
        <div class="h-screen flex flex-col bg-slate-100 overflow-hidden print:h-auto print:overflow-visible print:bg-white">
            <header class="bg-white border-b px-8 py-4 flex justify-between items-center z-50 no-print">
                <div class="flex items-center gap-4">
                    <button id="home" class="p-2 border rounded-xl hover:bg-slate-50 transition-colors"><i data-lucide="home"></i></button>
                    <h1 class="font-black text-xl">e-Gov Explorer <span class="text-blue-600">Hidelity</span></h1>
                </div>
                <div class="flex gap-2">
                    ${isNotice ? `
                    <button id="btn-calc" class="flex items-center gap-2 px-6 py-2 rounded-xl font-bold ${state.viewMode === 'calculator' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-white'} transition-all shadow-md">
                        <i data-lucide="${state.viewMode === 'calculator' ? 'file-text' : 'calculator'}" size="18"></i> ${state.viewMode === 'calculator' ? '帳票表示に戻る' : '控除額計算シミュレータ'}
                    </button>
                    <button id="btn-csv" class="flex items-center gap-2 px-6 py-2 rounded-xl font-bold bg-emerald-600 text-white hover:bg-emerald-700 transition-all shadow-md">
                        <i data-lucide="download" size="18"></i> CSV保存
                    </button>` : ''}
                    <button id="btn-pdf" class="flex items-center gap-2 px-6 py-2 rounded-xl font-bold bg-rose-600 text-white hover:bg-rose-700 transition-all shadow-md">
                        <i data-lucide="printer" size="18"></i> PDF保存(印刷)
                    </button>
                </div>
            </header>
            <div class="flex-1 flex overflow-hidden print:block print:overflow-visible">
                <aside class="w-80 bg-white border-r overflow-y-auto p-4 no-print">
                    ${state.cases.map((c, ci) => `
                        <button class="w-full text-left p-3 bg-slate-50 font-bold mb-2 rounded-xl toggle-case flex justify-between items-center" data-idx="${ci}">${c.folderName} <i data-lucide="${c.isOpen ? 'chevron-up' : 'chevron-down'}" size="14"></i></button>
                        ${c.isOpen ? c.files.map((f, fi) => `
                            <button class="w-full text-left p-4 text-[11px] font-bold mb-1 rounded-xl border transition-all ${ci === state.selectedCaseIdx && fi === state.selectedFileIdx ? 'bg-blue-600 text-white border-blue-600 shadow-lg translate-x-1' : 'bg-white hover:bg-slate-50 border-slate-100'}" data-ci="${ci}" data-fi="${fi}">${f.name}</button>
                        `).join('') : ''}
                    `).join('')}
                </aside>
                <main class="flex-1 bg-slate-200 overflow-y-auto p-12 print:p-0 print:bg-white print:overflow-visible print:h-auto">
                    <div class="mb-8 flex justify-center bg-white p-2 rounded-2xl w-fit mx-auto shadow-sm no-print border border-slate-300">
                        <button id="sumV" class="px-10 py-3 rounded-xl font-black ${state.viewMode !== 'tree' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}">帳票プレビュー</button>
                        <button id="treeV" class="px-10 py-3 rounded-xl font-black ${state.viewMode === 'tree' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}">XML構造解析</button>
                    </div>
                    <div class="print-area print:m-0 print:w-full">
                        ${state.viewMode === 'calculator' && data ? renderCalculatorView(data) :
                          (state.viewMode !== 'tree' && data ? 
                            (data.docType === 'SUMMARY' ? renderSummarySheet(data) : 
                             data.docType === 'ANNOUNCEMENT' ? renderAnnouncementSheet(data) :
                             renderNoticeSheet(data)) : 
                          (state.viewMode === 'tree' ? `<pre class="bg-slate-900 text-blue-400 p-10 rounded-3xl font-mono text-xs overflow-auto shadow-2xl">${JSON.stringify(cur?.parsed, null, 2)}</pre>` : '<div class="text-center p-20 bg-white rounded-3xl shadow no-print">プレビュー対象外のファイルです</div>'))}
                    </div>
                </main>
            </div>
            <style>
                @media print {
                    html, body, #root, .flex-col, .flex-1 { 
                        height: auto !important; 
                        overflow: visible !important; 
                        display: block !important; 
                        background: white !important;
                    }
                    .no-print, header, aside, .mb-8 { display: none !important; }
                    main { 
                        padding: 0 !important; 
                        margin: 0 !important;
                        overflow: visible !important; 
                    }
                    .print-area { 
                        width: 100% !important; 
                        margin: 0 !important; 
                        padding: 0 !important;
                    }
                    * { 
                        -webkit-print-color-adjust: exact !important; 
                        print-color-adjust: exact !important; 
                    }
                }
            </style>
        </div>
    `;
    attach();
    if ((window as any).lucide) (window as any).lucide.createIcons();
};

const handleUpload = async (e: Event) => {
    const files = Array.from((e.target as HTMLInputElement).files || []);
    if (files.length === 0) return;
    state.isLoading = true; render();
    const caseMap = new Map<string, AppFile[]>();
    for (const f of files) {
        const proc = async (path: string, name: string, content: string) => {
            if (!name.toLowerCase().endsWith('.xml')) return;
            const doc = new DOMParser().parseFromString(content, "text/xml");
            const walk = (el: Element): XMLNode => {
                const n = el.tagName.split(':').pop() || el.tagName;
                const children: XMLNode[] = [];
                Array.from(el.childNodes).forEach(c => { if (c.nodeType === Node.ELEMENT_NODE) children.push(walk(c as Element)); });
                return { name: n, content: el.children.length === 0 ? el.textContent?.trim() : undefined, children };
            };
            const parsed = walk(doc.documentElement);
            const dir = path.split('/')[0] || "一括";
            if (!caseMap.has(dir)) caseMap.set(dir, []);
            caseMap.get(dir)!.push({ name, fullPath: path, content, parsed, analysis: extractDetailed(parsed) || undefined });
        };
        if (f.name.endsWith('.zip')) {
            const zip = await new JSZip().loadAsync(f);
            for (const p of Object.keys(zip.files)) if (!zip.files[p].dir) await proc(p, p.split('/').pop()!, await zip.files[p].async('string'));
        } else await proc(f.name, f.name, await f.text());
    }
    state.cases = Array.from(caseMap.entries()).map(([folderName, files]) => ({ folderName, files, isOpen: true }));
    if (state.cases.length > 0) { state.selectedCaseIdx = 0; state.selectedFileIdx = 0; }
    state.isLoading = false; render();
};

const attach = () => {
    document.getElementById('home')?.addEventListener('click', () => { state.cases = []; render(); });
    document.getElementById('sumV')?.addEventListener('click', () => { state.viewMode = 'summary'; render(); });
    document.getElementById('treeV')?.addEventListener('click', () => { state.viewMode = 'tree'; render(); });
    document.getElementById('btn-calc')?.addEventListener('click', () => { state.viewMode = state.viewMode === 'calculator' ? 'summary' : 'calculator'; render(); });
    document.getElementById('btn-csv')?.addEventListener('click', downloadCSV);
    document.getElementById('btn-pdf')?.addEventListener('click', () => window.print());
    document.querySelectorAll('.toggle-case').forEach(b => b.addEventListener('click', (e) => { const i = parseInt((e.currentTarget as any).dataset.idx); state.cases[i].isOpen = !state.cases[i].isOpen; render(); }));
    document.querySelectorAll('[data-ci]').forEach(b => b.addEventListener('click', (e) => { const t = e.currentTarget as any; state.selectedCaseIdx = parseInt(t.dataset.ci); state.selectedFileIdx = parseInt(t.dataset.fi); state.viewMode = 'summary'; render(); }));
    if (state.viewMode === 'calculator') {
        ['rate-health', 'rate-pension', 'rate-nursing', 'calc-nursing'].forEach(id => document.getElementById(id)?.addEventListener('change', (e: any) => {
            if (id === 'calc-nursing') state.rates.isNursingTarget = e.target.checked;
            else (state.rates as any)[id.split('-')[1]] = parseFloat(e.target.value) || 0;
            render();
        }));
    }
};

render();
