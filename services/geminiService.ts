
import { GoogleGenAI, Type } from "@google/genai";
import { AnalysisResult } from "../types";

export const analyzeXMLContent = async (xmlString: string): Promise<AnalysisResult> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
  
  const MAX_CHAR_LIMIT = 500000;
  const contentSnippet = xmlString.length > MAX_CHAR_LIMIT 
    ? xmlString.substring(0, MAX_CHAR_LIMIT) + "\n...(省略)" 
    : xmlString;

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `
      e-GovのXML公文書から被保険者情報を抽出してください。
      【抽出項目】
      - officeInfo: 事業所整理記号、事業所番号
      - tableData: 
        headers: ["整理番号", "被保険者氏名", "賞与支払年月日", "標準賞与額(健保)", "標準賞与額(厚年)", "生年月日", "種別"]
        rows: 全員分のデータ
      
      XML内容:
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
                items: { type: Type.ARRAY, items: { type: Type.STRING } } 
              }
            }
          },
          mainDetails: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                value: { type: Type.STRING }
              }
            }
          }
        }
      }
    }
  });

  try {
    const text = response.text || '';
    return JSON.parse(text.trim());
  } catch (error) {
    throw new Error("解析データのパースに失敗しました。");
  }
};
