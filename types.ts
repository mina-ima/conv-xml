
export interface XMLNode {
  name: string;
  attributes: Record<string, string>;
  content?: string;
  children: XMLNode[];
}

export interface AnalysisResult {
  title: string;
  summary: string;
  officeInfo?: {
    officeSortCode?: string; // 事業所整理記号
    officeNumber?: string;   // 事業所番号
  };
  keyPoints: string[];
  mainDetails: Array<{ label: string; value: string }>;
  tableData?: {
    headers: string[];
    rows: string[][];
  };
  nextSteps?: string;
}
