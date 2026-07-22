/**
 * Pi coding agent conversation parser.
 *
 * Reads JSONL session files from ~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<uuid>.jsonl
 *
 * Pi session format (one JSON object per line):
 *   line 0: { type: 'session', version, id, timestamp, cwd }
 *   line 1: { type: 'model_change', provider, modelId }
 *   line 2: { type: 'thinking_level_change', thinkingLevel }
 *   line N: { type: 'message', message: { role: 'user'|'assistant'|'toolResult',
 *             content: [ { type: 'text'|'thinking'|'toolCall'|... } ] } }
 *
 * Directory slug encodes the working directory: /Users/sheurich → --Users-sheurich--
 */
import { ConversationExchange, ConversationSource } from '../types.js';
export declare function parsePiConversation(filePath: string, projectName: string, archivePath: string): Promise<ConversationExchange[]>;
export declare class PiSource implements ConversationSource {
    readonly name: "pi";
    readonly label = "Pi";
    discoverConversations(): Promise<Array<{
        project: string;
        filePath: string;
    }>>;
    parseConversation(filePath: string, project: string, archivePath: string): Promise<ConversationExchange[]>;
}
