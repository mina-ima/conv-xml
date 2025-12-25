
import React, { useState, useMemo } from 'react';
import { Upload, FileText, LayoutGrid, ListTree, Loader2, AlertCircle, ChevronLeft, Download, Printer, Settings2, Calculator, Info } from 'lucide-react';
import { analyzeXMLContent } from './services/geminiService.ts';
import { XMLNode, AnalysisResult } from './types.ts';
import XMLTreeView from './components/XMLTreeView.tsx';

const DEFAULT_RATES = {
  health: 9.98,
  pension: 18.3,
  nursing: 1.60,
};

const App: React.FC = () => {
  const [xmlContent, setXmlContent] = useState<string | null>(null);
  const [parsedNode, setParsedNode] = useState<XMLNode | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'summary' | 'tree'>('summary');
  const [rates, setRates] = useState(DEFAULT_RATES);
  const [showSettings, setShowSettings] = useState(false);

  const parseXML = (xmlString: string): XMLNode => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "text/xml");
    const parseError = xmlDoc.getElementsByTagName("parsererror");
    if (parseError.length > 0) throw new Error("XMLの解析に失敗しました。ファイル形式を確認してください。");

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

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    setError(null);
    setAnalysis(null);

    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target?.result as string;
      try {
        const node = parseXML(text);
        setXmlContent(text);
        setParsedNode(node);
        
        // 解析を開始（完了を待たずにUIは更新される）
        analyzeXMLContent(text)
          .then(result => {
            setAnalysis(result);
            setIsLoading(false);
          })
          .catch(err => {
            console.error(err);
            setError("AI解析中にエラーが発生しました。構造表示(ツリー)から内容を確認してください。");
            setIsLoading(false);
          });
          
      } catch (err: any) {
        setError(err.message);
        setIsLoading(false);
      }
    };
    reader.readAsText(file);
  };

  const calculateAge = (birthStr: string) => {
    if (!birthStr) return 0;
    const match = birthStr.match(/([SHTR])?(\d+)/);
    if (!match) return 0;
    const era = match[1];
    const num = parseInt(match[2]);
    let year = 0;
    if (era === 'R') year = num + 2018;
    else if (era === 'H') year = num + 1988;
    else if (era === 'S') year = num + 1925;
    else year = num > 1900 ? num : num + 2000;
    return new Date().getFullYear() - year;
  };

  const calculatedRows = useMemo(() => {
    if (!analysis?.tableData) return [];
    const { headers, rows } = analysis.tableData;
    const hIdx = headers.findIndex(h => h.includes("健保"));
    const pIdx = headers.findIndex(h => h.includes("厚年"));
    const bIdx = headers.findIndex(h => h.includes("生年月日"));

    return rows.map(row => {
      const healthAmount = parseInt(row[hIdx]?.replace(/[^0-9]/g, '') || '0') * (row[hIdx]?.includes('千円') ? 1000 : 1);
      const pensionAmount = parseInt(row[pIdx]?.replace(/[^0-9]/g, '') || '0') * (row[pIdx]?.includes('千円') ? 1000 : 1);
      const age = calculateAge(row[bIdx] || "");
      const isNursingTarget = age >= 40 && age < 65;

      const healthPremium = Math.floor((healthAmount * (rates.health / 100)) / 2);
      const pensionPremium = Math.floor((pensionAmount * (rates.pension / 100)) / 2);
      const nursingPremium = isNursingTarget ? Math.floor((healthAmount * (rates.nursing / 100)) / 2) : 0;
      
      return {
        original: row,
        healthPremium,
        pensionPremium,
        nursingPremium,
        totalPremium: healthPremium + pensionPremium + nursingPremium
      };
    });
  }, [analysis, rates]);

  const downloadCSV = () => {
    if (!analysis?.tableData) return;
    const headers = [...analysis.tableData.headers, "健康保険料", "厚生年金保険料", "介護保険料", "合計"];
    const csvContent = [
      headers.join(','),
      ...calculatedRows.map(c => [...c.original, c.healthPremium, c.pensionPremium, c.nursingPremium, c.totalPremium].join(','))
    ].join('\n');
    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "保険料計算結果.csv";
    link.click();
  };

  const reset = () => {
    setXmlContent(null);
    setParsedNode(null);
    setAnalysis(null);
    setError(null);
    setIsLoading(false);
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#f8fafc] text-slate-900">
      <header className="bg-white border-b border-slate-200 px-6 py-3 sticky top-0 z-50 shadow-sm print:hidden">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={reset}>
            <div className="bg-blue-600 p-2 rounded text-white"><FileText size={20} /></div>
            <h1 className="text-lg font-bold">e-Gov XML Assistant</h1>
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
                <button onClick={() => setViewMode('summary')} className={`px-4 py-1.5 rounded-md text-sm font-semibold ${viewMode === 'summary' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'}`}>帳票</button>
                <button onClick={() => setViewMode('tree')} className={`px-4 py-1.5 rounded-md text-sm font-semibold ${viewMode === 'tree' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'}`}>構造</button>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-[1600px] w-full mx-auto p-4 sm:p-6">
        {!xmlContent && (
          <div className="mt-20 flex flex-col items-center">
            <div className="bg-white p-12 rounded-3xl shadow-sm border border-slate-200 w-full max-w-2xl text-center">
              <Upload className="text-blue-600 mx-auto mb-6" size={48} />
              <h2 className="text-2xl font-bold mb-4">公文書XMLの読み込み</h2>
              <label className="block w-full py-4 px-6 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl cursor-pointer transition-all shadow-lg">
                ファイルを選択
                <input type="file" className="hidden" accept=".xml" onChange={handleFileUpload} />
              </label>
            </div>
          </div>
        )}

        {xmlContent && (
          <div className="space-y-6">
            {showSettings && (
              <div className="p-6 bg-white rounded-2xl border border-blue-100 shadow-sm animate-in slide-in-from-top-4 print:hidden">
                <div className="flex items-center gap-2 text-blue-700 mb-4 font-bold"><Calculator size={20} />保険料率設定</div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                  {Object.entries(rates).map(([key, val]) => (
                    <div key={key}>
                      <label className="block text-xs font-bold text-slate-400 mb-1 uppercase">{key === 'health' ? '健康保険' : key === 'pension' ? '厚生年金' : '介護保険'}(%)</label>
                      <input type="number" step="0.01" value={val} onChange={e => setRates({...rates, [key]: parseFloat(e.target.value)})} className="w-full p-2 border border-slate-200 rounded-lg font-mono" />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {viewMode === 'summary' ? (
              <>
                {isLoading && (
                  <div className="flex items-center justify-center p-12 bg-blue-50/50 rounded-2xl border border-dashed border-blue-200">
                    <Loader2 className="animate-spin text-blue-600 mr-3" size={24} />
                    <span className="font-bold text-blue-800">AIが内容を解析して帳票を作成しています...</span>
                  </div>
                )}
                {error && (
                  <div className="p-4 bg-red-50 text-red-700 rounded-xl border border-red-100 flex items-start gap-3">
                    <AlertCircle size={20} className="shrink-0" />
                    <p className="text-sm font-medium">{error}</p>
                  </div>
                )}
                {analysis && (
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                    <div className="p-6 border-b border-slate-100 flex justify-between items-center">
                      <h2 className="text-xl font-bold">{analysis.title}</h2>
                      <div className="flex gap-2 print:hidden">
                        <button onClick={downloadCSV} className="flex items-center gap-2 px-3 py-1.5 border border-slate-200 rounded-lg text-sm font-bold hover:bg-slate-50"><Download size={16} />CSV</button>
                        <button onClick={() => window.print()} className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-bold"><Printer size={16} />印刷</button>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse">
                        <thead className="bg-slate-50 sticky top-0">
                          <tr>
                            {analysis.tableData?.headers.map((h, i) => (
                              <th key={i} className="border border-slate-200 p-3 text-left text-[10px] text-slate-500 uppercase font-bold whitespace-nowrap">{h}</th>
                            ))}
                            <th className="border border-slate-200 p-3 text-right text-[10px] text-blue-600 bg-blue-50/30 font-bold">本人負担:計</th>
                          </tr>
                        </thead>
                        <tbody>
                          {calculatedRows.map((calc, ri) => (
                            <tr key={ri} className="hover:bg-slate-50 odd:bg-white even:bg-slate-50/20">
                              {calc.original.map((cell, ci) => <td key={ci} className="border border-slate-100 p-3 text-[13px] whitespace-nowrap">{cell}</td>)}
                              <td className="border border-slate-100 p-3 text-[13px] font-bold text-right bg-blue-50/20">{calc.totalPremium.toLocaleString()}円</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {!isLoading && !analysis && !error && (
                  <div className="p-20 text-center text-slate-400">
                    <Info className="mx-auto mb-4 opacity-20" size={48} />
                    <p>解析結果を待機中、または解析がスキップされました。</p>
                  </div>
                )}
              </>
            ) : (
              <div className="bg-white p-6 rounded-xl border border-slate-200 overflow-auto max-h-[70vh]">
                <XMLTreeView node={parsedNode!} />
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
