
import React, { useState, useMemo } from 'react';
import { Upload, FileText, LayoutGrid, ListTree, Loader2, AlertCircle, ChevronLeft, Download, Printer, Users, Settings2, Calculator } from 'lucide-react';
import { analyzeXMLContent } from './services/geminiService.ts';
import { XMLNode, AnalysisResult } from './types.ts';
import XMLTreeView from './components/XMLTreeView.tsx';

// デフォルトの保険料率（令和6年度 協会けんぽ 東京 参照例）
const DEFAULT_RATES = {
  health: 9.98,      // 健康保険率 (%)
  pension: 18.3,     // 厚生年金率 (%)
  nursing: 1.60,     // 介護保険率 (%)
};

const App: React.FC = () => {
  const [xmlContent, setXmlContent] = useState<string | null>(null);
  const [parsedNode, setParsedNode] = useState<XMLNode | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'summary' | 'tree'>('summary');
  
  // 保険料率設定
  const [rates, setRates] = useState(DEFAULT_RATES);
  const [showSettings, setShowSettings] = useState(false);

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
      const childNodes = Array.from(element.childNodes);
      let textContent = "";
      childNodes.forEach(child => {
        if (child.nodeType === Node.ELEMENT_NODE) {
          children.push(traverse(child as Element));
        } else if (child.nodeType === Node.TEXT_NODE) {
          textContent += child.textContent?.trim() || "";
        }
      });
      return { name: element.tagName, attributes, content: textContent || undefined, children };
    };

    return traverse(xmlDoc.documentElement);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsLoading(true);
    setError(null);
    setAnalysis(null);
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const text = e.target?.result as string;
        setXmlContent(text);
        setParsedNode(parseXML(text));
        const result = await analyzeXMLContent(text);
        setAnalysis(result);
        setViewMode('summary');
      } catch (err: any) {
        setError(err.message || "予期せぬエラーが発生しました。");
      } finally {
        setIsLoading(false);
      }
    };
    reader.readAsText(file);
  };

  const calculateAge = (birthStr: string) => {
    let year = 0;
    const match = birthStr.match(/([SHTR])?\s?(\d+)/);
    if (!match) return 0;
    
    const era = match[1];
    const num = parseInt(match[2]);
    if (era === 'R') year = num + 2018;
    else if (era === 'H') year = num + 1988;
    else if (era === 'S') year = num + 1925;
    else year = num > 1900 ? num : num + 2000;

    return new Date().getFullYear() - year;
  };

  const calculatedRows = useMemo(() => {
    if (!analysis?.tableData) return [];
    const { headers, rows } = analysis.tableData;
    
    const hIdx = headers.indexOf("標準賞与額(健保)");
    const pIdx = headers.indexOf("標準賞与額(厚年)");
    const bIdx = headers.indexOf("生年月日");

    return rows.map(row => {
      const healthAmount = parseInt(row[hIdx]?.replace(/[^0-9]/g, '') || '0') * (row[hIdx]?.includes('千円') ? 1000 : 1);
      const pensionAmount = parseInt(row[pIdx]?.replace(/[^0-9]/g, '') || '0') * (row[pIdx]?.includes('千円') ? 1000 : 1);
      const birth = row[bIdx] || "";
      const age = calculateAge(birth);
      const isNursingTarget = age >= 40 && age < 65;

      const healthPremium = Math.floor((healthAmount * (rates.health / 100)) / 2);
      const pensionPremium = Math.floor((pensionAmount * (rates.pension / 100)) / 2);
      const nursingPremium = isNursingTarget ? Math.floor((healthAmount * (rates.nursing / 100)) / 2) : 0;
      
      return {
        original: row,
        age,
        isNursingTarget,
        healthPremium,
        pensionPremium,
        nursingPremium,
        totalPremium: healthPremium + pensionPremium + nursingPremium
      };
    });
  }, [analysis, rates]);

  const downloadCSV = () => {
    if (!analysis?.tableData) return;
    const headers = [...analysis.tableData.headers, "本人負担:健康保険", "本人負担:厚生年金", "本人負担:介護保険", "本人負担合計"];
    const csvRows = calculatedRows.map(calc => [
      ...calc.original,
      calc.healthPremium,
      calc.pensionPremium,
      calc.nursingPremium,
      calc.totalPremium
    ]);
    
    const csvContent = [
      headers.join(','),
      ...csvRows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${analysis.title || '保険料計算結果'}.csv`;
    link.click();
  };

  const reset = () => {
    setXmlContent(null);
    setParsedNode(null);
    setAnalysis(null);
    setError(null);
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#f8fafc] print:bg-white text-slate-900">
      <header className="bg-white border-b border-slate-200 px-6 py-3 sticky top-0 z-50 shadow-sm print:hidden">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={reset}>
            <div className="bg-blue-600 p-2 rounded text-white"><FileText size={20} /></div>
            <h1 className="text-lg font-bold text-slate-800">e-Gov XML & 保険料計算</h1>
          </div>
          {xmlContent && (
            <div className="flex items-center gap-4">
              <button 
                onClick={() => setShowSettings(!showSettings)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${showSettings ? 'bg-blue-50 text-blue-600' : 'text-slate-500 hover:bg-slate-100'}`}
              >
                <Settings2 size={18} />
                料率設定
              </button>
              <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
                <button onClick={() => setViewMode('summary')} className={`px-4 py-1.5 rounded-md text-sm font-semibold ${viewMode === 'summary' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'}`}>帳票表示</button>
                <button onClick={() => setViewMode('tree')} className={`px-4 py-1.5 rounded-md text-sm font-semibold ${viewMode === 'tree' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'}`}>構造</button>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-[1600px] w-full mx-auto p-4 sm:p-6">
        {!xmlContent && !isLoading && (
          <div className="mt-20 flex flex-col items-center">
            <div className="bg-white p-12 rounded-3xl shadow-sm border border-slate-200 w-full max-w-2xl text-center">
              <div className="bg-blue-50 text-blue-600 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6"><Upload size={32} /></div>
              <h2 className="text-2xl font-bold mb-4">決定通知書XMLの読み込み</h2>
              <p className="text-slate-500 mb-8 leading-relaxed">賞与決定通知書のXMLからデータを抽出し、本人の保険料負担額を自動計算します。</p>
              <label className="block w-full py-4 px-6 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl cursor-pointer transition-all shadow-lg">
                ファイルを選択して開始
                <input type="file" className="hidden" accept=".xml" onChange={handleFileUpload} />
              </label>
            </div>
          </div>
        )}

        {isLoading && (
          <div className="flex flex-col items-center justify-center h-96">
            <Loader2 className="animate-spin text-blue-600 mb-6" size={56} />
            <h3 className="text-xl font-bold">データを抽出・計算中...</h3>
          </div>
        )}

        {analysis && viewMode === 'summary' && (
          <div className="animate-in fade-in duration-500">
            {showSettings && (
              <div className="mb-6 p-6 bg-white rounded-2xl border border-blue-100 shadow-sm animate-in slide-in-from-top-4 print:hidden">
                <div className="flex items-center gap-2 text-blue-700 mb-4">
                  <Calculator size={20} />
                  <h3 className="font-bold">保険料率設定</h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-1">健康保険料率 (%)</label>
                    <input type="number" step="0.01" value={rates.health} onChange={e => setRates({...rates, health: parseFloat(e.target.value)})} className="w-full p-2 border border-slate-200 rounded-lg font-mono" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-1">厚生年金保険料率 (%)</label>
                    <input type="number" step="0.01" value={rates.pension} onChange={e => setRates({...rates, pension: parseFloat(e.target.value)})} className="w-full p-2 border border-slate-200 rounded-lg font-mono" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-1">介護保険料率 (%) ※40歳以上</label>
                    <input type="number" step="0.01" value={rates.nursing} onChange={e => setRates({...rates, nursing: parseFloat(e.target.value)})} className="w-full p-2 border border-slate-200 rounded-lg font-mono" />
                  </div>
                </div>
              </div>
            )}

            <div className="mb-4 flex justify-end gap-2 print:hidden">
              <button onClick={downloadCSV} className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm font-bold hover:bg-slate-50 shadow-sm"><Download size={16} />CSV保存</button>
              <button onClick={() => window.print()} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 shadow-sm"><Printer size={16} />印刷 / PDF</button>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden print:border-none">
              <div className="p-8 border-b border-slate-100">
                <h2 className="text-center text-2xl font-bold text-slate-900 mb-6">{analysis.title}</h2>
                <div className="flex gap-10 text-sm font-mono text-slate-600">
                  {analysis.officeInfo?.officeSortCode && <div>整理記号: <span className="font-bold text-slate-900">{analysis.officeInfo.officeSortCode}</span></div>}
                  {analysis.officeInfo?.officeNumber && <div>事業所番号: <span className="font-bold text-slate-900">{analysis.officeInfo.officeNumber}</span></div>}
                </div>
              </div>

              <div className="overflow-x-auto relative">
                <table className="w-full border-collapse">
                  <thead className="bg-slate-50 sticky top-0 z-10">
                    <tr>
                      {analysis.tableData?.headers.map((h, i) => (
                        <th key={i} className="border border-slate-200 py-3 px-4 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                      <th className="border border-slate-200 py-3 px-4 text-left text-[10px] font-bold text-blue-600 bg-blue-50/50">本人負担:健保</th>
                      <th className="border border-slate-200 py-3 px-4 text-left text-[10px] font-bold text-blue-600 bg-blue-50/50">本人負担:厚年</th>
                      <th className="border border-slate-200 py-3 px-4 text-left text-[10px] font-bold text-blue-600 bg-blue-50/50">本人負担:介護</th>
                      <th className="border border-slate-200 py-3 px-4 text-left text-[10px] font-bold text-indigo-600 bg-indigo-50/50">控除合計額</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {calculatedRows.map((calc, ri) => (
                      <tr key={ri} className="hover:bg-slate-50 transition-colors odd:bg-white even:bg-slate-50/20">
                        {calc.original.map((cell, ci) => (
                          <td key={ci} className="border border-slate-100 py-2.5 px-4 text-[13px] text-slate-700 whitespace-nowrap">{cell}</td>
                        ))}
                        <td className="border border-slate-100 py-2.5 px-4 text-[13px] font-bold text-blue-700 text-right bg-blue-50/20">{calc.healthPremium.toLocaleString()}円</td>
                        <td className="border border-slate-100 py-2.5 px-4 text-[13px] font-bold text-blue-700 text-right bg-blue-50/20">{calc.pensionPremium.toLocaleString()}円</td>
                        <td className={`border border-slate-100 py-2.5 px-4 text-[13px] font-bold text-right bg-blue-50/20 ${calc.nursingPremium > 0 ? 'text-amber-600' : 'text-slate-300'}`}>
                          {calc.nursingPremium > 0 ? `${calc.nursingPremium.toLocaleString()}円` : '0円'}
                        </td>
                        <td className="border border-slate-100 py-2.5 px-4 text-[13px] font-extrabold text-indigo-700 text-right bg-indigo-50/20">{calc.totalPremium.toLocaleString()}円</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
      
      <style>{`
        @media print {
          body { background: white !important; }
          .max-w-[1600px] { max-width: 100% !important; margin: 0 !important; }
          table { font-size: 8px !important; border-collapse: collapse !important; }
          th, td { border: 1px solid #ccc !important; padding: 2px 4px !important; }
          @page { size: landscape; margin: 10mm; }
        }
      `}</style>
    </div>
  );
};

export default App;
