
import { GoogleGenAI, Type } from "@google/genai";
import { AnalysisResult } from "../types.ts";

export const analyzeXMLContent = async (xmlString: string): Promise<AnalysisResult> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
  
  // 読み込み上限を最大化
  const MAX_CHAR_LIMIT = 500000;
  const contentSnippet = xmlString.length > MAX_CHAR_LIMIT 
    ? xmlString.substring(0, MAX_CHAR_LIMIT) + "\n...(データが非常に長いため一部省略。末尾までスキャンして全件抽出してください)" 
    : xmlString;

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `
      あなたは日本の社会保険制度に精通したエキスパートです。
      提供されたe-GovのXML公文書（決定通知書）から、「すべての被保険者」の情報を漏れなく抽出してください。
      
      【最重要事項】
      - このファイルには非常に多くの被保険者が含まれています（例：100名以上）。
      - 前回46件で止まってしまったという報告があります。今回は絶対に途中で止めず、XMLの末尾まで全て読み取って抽出してください。
      - 複数ページ（Page1, Page2...）の構成になっている場合、それらを全て連結して一つの大きなリストにしてください。

      【抽出項目】
      - officeInfo: 事業所整理記号、事業所番号
      - tableData: 
        headers: ["整理番号", "被保険者氏名", "賞与支払年月日", "標準賞与額(健保)", "標準賞与額(厚年)", "生年月日", "種別"]
        rows: 全被保険者分のデータを、上記ヘッダー順の配列として作成してください。
      - mainDetails: 通知書全体の合計額や決定事項。

      【解析対象XML】
      ${contentSnippet}
    `,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          summary: { type: Type.STRING },
          officeInfo: {
            type: Type.OBJECT,
            properties: {
              officeSortCode: { type: Type.STRING },
              officeNumber: { type: Type.STRING }
            }
          },
          keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
          tableData: {
            type: Type.OBJECT,
            properties: {
              headers: { type: Type.ARRAY, items: { type: Type.STRING } },
              rows: { 
                type: Type.ARRAY, 
                items: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING }
                } 
              }
            },
            required: ["headers", "rows"]
          },
          mainDetails: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                value: { type: Type.STRING }
              },
              required: ["label", "value"]
            }
          },
          nextSteps: { type: Type.STRING }
        },
        required: ["title", "summary", "keyPoints", "mainDetails"]
      }
    }
  });

  try {
    const text = response.text.trim();
    return JSON.parse(text);
  } catch (error) {
    console.error("Analysis parsing error:", error);
    throw new Error("データ量が非常に多いため、解析に時間がかかっているか、制限に達しました。もう一度お試しいただくか、ファイルを分割して読み込んでください。");
  }
};
