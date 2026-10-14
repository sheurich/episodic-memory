export type ConversationReadErrorCode = 'path_outside_archive' | 'file_not_found' | 'symlink_not_allowed' | 'not_regular_jsonl' | 'invalid_line_window' | 'line_window_too_large' | 'selected_input_too_large' | 'formatted_output_too_large' | 'scan_limit_exceeded' | 'read_deadline_exceeded' | 'invalid_jsonl' | 'read_failed';
export declare class ConversationReadError extends Error {
    readonly code: ConversationReadErrorCode;
    constructor(code: ConversationReadErrorCode, message: string);
}
export interface ConversationReadRequest {
    path: string;
    startLine: number;
    endLine: number;
}
export interface ConversationReadResult {
    path: string;
    startLine: number;
    endLine: number;
    linesRead: number;
    markdown: string;
}
export interface ConversationReader {
    readConversation(request: ConversationReadRequest, signal?: AbortSignal): Promise<ConversationReadResult>;
}
/**
 * Create a reader whose trust boundary is fixed once, at extension startup.
 * Limits are intentionally constants rather than caller-controlled options.
 */
export declare function createConversationReader(archiveRoot: string): ConversationReader;
