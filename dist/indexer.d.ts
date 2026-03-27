/**
 * Multi-source conversation indexer.
 *
 * Discovers conversations from all registered sources (Claude, Gemini, Pi),
 * parses them, generates embeddings, and stores them in the unified
 * sqlite-vec database.
 */
import { AgentSource } from './types.js';
export { parseClaudeConversation as parseConversation } from './parsers/claude.js';
export declare function indexConversations(limitToProject?: string, maxConversations?: number, concurrency?: number, noSummaries?: boolean): Promise<void>;
/**
 * Index conversations from all registered sources (Claude, Gemini, Pi).
 * This is the primary entry point for the unified indexer.
 */
export declare function indexAllSources(options?: {
    sources?: AgentSource[];
    concurrency?: number;
    noSummaries?: boolean;
    maxConversations?: number;
}): Promise<void>;
export declare function indexUnprocessed(concurrency?: number, noSummaries?: boolean): Promise<void>;
export declare function indexSession(sessionId: string, concurrency?: number, noSummaries?: boolean): Promise<void>;
