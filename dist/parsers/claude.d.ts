/**
 * Claude Code conversation parser.
 *
 * Reads JSONL files from ~/.claude/projects/<project>/<session>.jsonl
 * and produces ConversationExchange records.
 */
import { ConversationExchange, ConversationSource } from '../types.js';
export declare function parseClaudeConversation(filePath: string, projectName: string, archivePath: string): Promise<ConversationExchange[]>;
export declare class ClaudeSource implements ConversationSource {
    readonly name: "claude";
    readonly label = "Claude Code";
    discoverConversations(): Promise<Array<{
        project: string;
        filePath: string;
    }>>;
    parseConversation(filePath: string, project: string, archivePath: string): Promise<ConversationExchange[]>;
}
