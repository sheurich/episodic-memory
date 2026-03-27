/**
 * Backward-compatibility shim.
 *
 * The actual parsers now live in src/parsers/. This re-exports the
 * Claude parser under the original names so existing callers
 * (sync.ts, show.ts, tests) continue to work unchanged.
 */
export { parseClaudeConversation as parseConversation } from './parsers/claude.js';
import { parseClaudeConversation } from './parsers/claude.js';
/**
 * Convenience function to parse a conversation file
 * Extracts project name from the file path and returns exchanges with metadata
 */
export declare function parseConversationFile(filePath: string): Promise<{
    project: string;
    exchanges: Awaited<ReturnType<typeof parseClaudeConversation>>;
}>;
