/**
 * Gemini CLI conversation parser.
 *
 * Reads JSON session files from ~/.gemini/tmp/<projectHash>/chats/session-*.json
 * and produces ConversationExchange records.
 *
 * Gemini session format:
 *   {
 *     sessionId, projectHash, startTime, lastUpdated, summary?,
 *     messages: [
 *       { id, timestamp, type: 'user'|'gemini'|'error'|'info',
 *         content?, toolCalls?: [...] }
 *     ]
 *   }
 *
 * Project name resolution uses ~/.gemini/projects.json which maps
 * filesystem paths to human-readable names.  The directory hash is
 * sha256(path).
 */
import { ConversationExchange, ConversationSource } from '../types.js';
export declare function parseGeminiConversation(filePath: string, projectName: string, archivePath: string): Promise<ConversationExchange[]>;
export declare class GeminiSource implements ConversationSource {
    readonly name: "gemini";
    readonly label = "Gemini CLI";
    discoverConversations(): Promise<Array<{
        project: string;
        filePath: string;
    }>>;
    parseConversation(filePath: string, project: string, archivePath: string): Promise<ConversationExchange[]>;
}
