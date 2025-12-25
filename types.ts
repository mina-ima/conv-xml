
/**
 * Shared types for XML parsing and Gemini analysis.
 */

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
        officeSortCode: string;
        officeNumber: string;
    };
    keyPoints?: string[];
    tableData?: {
        headers: string[];
        rows: string[][];
    };
    mainDetails?: {
        label: string;
        value: string;
    }[];
}
