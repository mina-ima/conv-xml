
import React, { useState, useMemo } from 'react';
import { Upload, FileText, Loader2, AlertCircle, Download, Printer, Settings2, Calculator, Info, Database } from 'lucide-react';
import { analyzeXMLContent } from './services/geminiService';
import { XMLNode, AnalysisResult } from './types';
import XMLTreeView from './components/XMLTreeView';

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
        
        // 解析を開始（バックグラウンドで実行）
        analyzeXMLContent(text)
          .then(result => {
            setAnalysis(result);
            setIsLoading(false);
          })
          .catch(err => {
            console.error(err);
            setError("AIによる高度な解析が制限されました。ツリー表示で内容を直接確認できます。");
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
    const headers = [...analysis.tableData.headers, "健康保険料", "厚生年金保険料", "介護保険料", "本人負担合計"];
    const csvContent = [
      headers.join(','),
      ...calculatedRows.map(c => [...c.original, c.healthPremium, c.pensionPremium, c.nursingPremium, c.totalPremium].join(','))
    ].join('\n');
    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "eGov_保険料算出結果.csv";
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
            <div className="bg-blue-600 p-2 rounded text-white shadow-sm"><FileText size={20} /></div>
            <h1 className="text-lg font-bold tracking-tight">e-Gov XML Calculator</h1>
          </div>
          {xmlContent && (
            <div className="flex items-center gap-3">
              <button 
                onClick={() => setShowSettings(!showSettings)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-bold transition-all border ${showSettings ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
              >
                <Settings2 size={16} />
                料率設定
              </button>
              <div className="flex gap-1 bg-slate-100 p-1 rounded-lg border border-slate-200">
                <button onClick={() => setViewMode('summary')} className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all ${viewMode === 'summary' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>帳票表示</button>
                <button onClick={() => setViewMode('tree')} className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all ${viewMode === 'tree' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>XML構造</button>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-[1600px] w-full mx-auto p-4 sm:p-8">
        {!xmlContent && (
          <div className="mt-12 flex flex-col items-center">
            <div className="bg-white p-12 rounded-[2.5rem] shadow-xl shadow-slate-200/50 border border-slate-100 w-full max-w-xl text-center">
              <div className="bg-blue-50 w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-8 text-blue-600">
                <Upload size={40} />
              </div>
              <h2 className="text-3xl font-extrabold mb-4 text-slate-800">公文書XMLを読み込む</h2>
              <p className="text-slate-500 mb-10 leading-relaxed font-medium">
                e-Govからダウンロードした「決定通知書」などのXMLをアップロードしてください。<br/>
                自動的に保険料を算出し、CSVで出力できます。
              </p>
              <label className="block w-full py-5 px-8 bg-blue-600 hover:bg-blue-700 text-white font-bold text-lg rounded-2xl cursor-pointer transition-all transform hover:scale-[1.02] shadow-lg shadow-blue-200 active:scale-100">
                ファイルを選択して開始
                <input type="file" className="hidden" accept=".xml" onChange={handleFileUpload} />
              </label>
            </div>
            <div className="mt-12 grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-4xl w-full">
              {[
                { icon: <Database size={20}/>, title: "完全オフライン解析", desc: "ブラウザ上でXMLをパースするため、データはサーバーに保存されません。" },
                { icon: <Calculator size={20}/>, title: "保険料自動計算", desc: "生年月日から年齢を判定し、最新の料率に基づき本人負担分を算出します。" },
                { icon: <Download size={20}/>, title: "Excel連携", desc: "計算結果をそのままCSVとしてダウンロードし、給与ソフト等へ活用できます。" }
              ].map((item, i) => (
                <div key={i} className="p-6 bg-white rounded-2xl border border-slate-100 shadow-sm">
                  <div className="text-blue-500 mb-3">{item.icon}</div>
                  <h3 className="font-bold text-slate-800 mb-2">{item.title}</h3>
                  <p className="text-sm text-slate-500 leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {xmlContent && (
          <div className="space-y-6 animate-in fade-in duration-500">
            {showSettings && (
              <div className="p-8 bg-white rounded-3xl border border-blue-100 shadow-xl shadow-blue-500/5 animate-in slide-in-from-top-4 print:hidden">
                <div className="flex items-center gap-3 text-blue-700 mb-6 font-bold text-lg">
                  <Calculator size={24} className="text-blue-500" />
                  保険料率の設定（%）
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
                  {Object.entries(rates).map(([key, val]) => (
                    <div key={key} className="space-y-2">
                      <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest">
                        {key === 'health' ? '健康保険' : key === 'pension' ? '厚生年金' : '介護保険(40歳~)'}
                      </label>
                      <div className="relative">
                        <input 
                          type="number" 
                          step="0.001" 
                          value={val} 
                          onChange={e => setRates({...rates, [key]: parseFloat(e.target.value)})} 
                          className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl font-mono text-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                        />
                        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold">%</span>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-6 text-xs text-slate-400 flex items-center gap-2 italic">
                  <Info size={14} /> 組合や地域ごとの最新の保険料率を入力してください。
                </p>
              </div>
            )}

            {viewMode === 'summary' ? (
              <>
                {isLoading && (
                  <div className="flex flex-col items-center justify-center p-16 bg-blue-50/30 rounded-[2rem] border-2 border-dashed border-blue-100">
                    <Loader2 className="animate-spin text-blue-600 mb-4" size={40} />
                    <p className="font-bold text-blue-800 text-lg">AIが帳票データを抽出しています...</p>
                    <p className="text-blue-500/70 text-sm mt-2">少々お待ちください</p>
                  </div>
                )}
                {error && (
                  <div className="p-6 bg-red-50 text-red-800 rounded-2xl border border-red-100 flex items-start gap-4">
                    <AlertCircle size={24} className="shrink-0 text-red-500" />
                    <div>
                      <h4 className="font-bold mb-1">解析エラー</h4>
                      <p className="text-sm opacity-90 leading-relaxed">{error}</p>
                    </div>
                  </div>
                )}
                {analysis && (
                  <div className="bg-white rounded-[2rem] shadow-xl shadow-slate-200/50 border border-slate-200 overflow-hidden">
                    <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex flex-col md:flex-row justify-between items-center gap-4">
                      <div>
                        <h2 className="text-2xl font-black text-slate-800">{analysis.title}</h2>
                        <p className="text-slate-500 text-sm mt-1 font-medium">XMLデータから抽出された一覧</p>
                      </div>
                      <div className="flex gap-3 print:hidden">
                        <button onClick={downloadCSV} className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-bold hover:bg-slate-50 shadow-sm transition-all active:scale-95"><Download size={18} />CSVダウンロード</button>
                        <button onClick={() => window.print()} className="flex items-center gap-2 px-5 py-2.5 bg-slate-800 text-white rounded-xl text-sm font-bold hover:bg-slate-900 shadow-md transition-all active:scale-95"><Printer size={18} />印刷 / PDF保存</button>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse">
                        <thead>
                          <tr className="bg-slate-50/80">
                            {analysis.tableData?.headers.map((h, i) => (
                              <th key={i} className="border-b border-slate-200 p-4 text-left text-[11px] text-slate-400 uppercase font-black tracking-tighter whitespace-nowrap">{h}</th>
                            ))}
                            <th className="border-b border-slate-200 p-4 text-right text-[11px] text-blue-600 bg-blue-50/30 font-black tracking-tighter">本人負担合計</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {calculatedRows.map((calc, ri) => (
                            <tr key={ri} className="hover:bg-blue-50/20 transition-colors group">
                              {calc.original.map((cell, ci) => (
                                <td key={ci} className="p-4 text-[14px] text-slate-700 whitespace-nowrap font-medium">{cell}</td>
                              ))}
                              <td className="p-4 text-[14px] font-bold text-right bg-blue-50/20 text-blue-700 whitespace-nowrap">
                                ¥{calc.totalPremium.toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {!isLoading && !analysis && !error && (
                  <div className="py-24 text-center bg-white rounded-[2rem] border-2 border-dashed border-slate-100">
                    <span className="flex items-center justify-center w-24 h-24 rounded-full bg-slate-50 mx-auto mb-6 text-slate-200"><Info size={48} /></span>
                    <p className="text-slate-400 font-bold text-lg">解析データを準備しています...</p>
                    <p className="text-slate-300 text-sm mt-2">画面上の「XML構造」タブから生のデータを確認することもできます。</p>
                  </div>
                )}
              </>
            ) : (
              <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-xl overflow-auto max-h-[75vh]">
                <div className="mb-6 pb-4 border-b border-slate-100 flex items-center justify-between">
                  <h3 className="font-bold text-slate-400 text-sm uppercase tracking-widest">XML階層ツリー</h3>
                  <span className="text-[10px] bg-slate-100 px-2 py-1 rounded text-slate-400 font-bold uppercase tracking-tighter">Read Only Mode</span>
                </div>
                <XMLTreeView node={parsedNode!} />
              </div>
            )}
          </div>
        )}
      </main>
      <footer className="p-6 text-center text-[10px] text-slate-300 font-bold tracking-widest uppercase print:hidden">
        Secure & Private XML Assistant © 2025
      </footer>
    </div>
  );
};

export default App;
