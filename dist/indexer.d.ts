import { AgentSource } from './types.js';
export declare function indexConversations(limitToProject?: string, maxConversations?: number, concurrency?: number, noSummaries?: boolean): Promise<void>;
/**
 * Index conversations from all non-Claude sources (Gemini, Pi, OpenCode).
 *
 * Claude Code and Codex are covered by indexConversations() / indexUnprocessed()
 * which use the upstream-maintained getConversationSourceDirs() pipeline with
 * high-water-mark incremental indexing and summary-sentinel retry.
 * This function extends coverage to the remaining sources via the
 * ConversationSource registry.
 */
export declare function indexAllSources(options?: {
    sources?: AgentSource[];
    concurrency?: number;
    noSummaries?: boolean;
    maxConversations?: number;
}): Promise<void>;
export declare function indexSession(sessionId: string, concurrency?: number, noSummaries?: boolean): Promise<void>;
export declare function indexUnprocessed(concurrency?: number, noSummaries?: boolean): Promise<void>;
