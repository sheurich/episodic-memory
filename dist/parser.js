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
export async function parseConversationFile(filePath) {
    const pathParts = filePath.split('/');
    let project = 'unknown';
    if (pathParts.length >= 2) {
        project = pathParts[pathParts.length - 2];
    }
    const exchanges = await parseClaudeConversation(filePath, project, filePath);
    return {
        project,
        exchanges
    };
}
