export interface FormatConversationOptions {
    /**
     * Format already established by a trusted caller from structural file
     * metadata. 'omp' bypasses the Pi/Codex content heuristics so OMP thinking
     * blocks stay hidden even when the selected window looks Pi-shaped.
     */
    trustedFormat?: 'omp';
}
export declare function formatConversationAsMarkdown(jsonl: string, startLine?: number, endLine?: number, options?: FormatConversationOptions): string;
export declare function formatConversationAsHTML(jsonl: string): string;
