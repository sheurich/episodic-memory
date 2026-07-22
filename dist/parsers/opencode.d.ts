/**
 * OpenCode conversation parser.
 *
 * Reads from the OpenCode SQLite database at
 *   ~/.local/share/opencode/opencode.db
 * (or $XDG_DATA_HOME/opencode/opencode.db, overridable via OPENCODE_DB).
 *
 * OpenCode stores conversations across three tables:
 *   session  → id, project_id, directory, title, version, time_created, parent_id
 *   message  → id, session_id, data (JSON with role, parentID, modelID, providerID, …)
 *   part     → id, message_id, session_id, data (JSON with type, text, tool, …)
 *
 * Timestamps are Unix milliseconds.
 *
 * Exchange reconstruction:
 *   1. For each session, query user messages ordered by time_created.
 *   2. For each user message, find all assistant messages where parentID = user.id.
 *   3. Collect text parts from those assistant messages, concatenate in time order.
 *   4. Collect tool parts for tool-call metadata.
 *   5. Skip assistant messages with error fields.
 *
 * One user message may produce many assistant messages (multi-step agentic loop).
 * Sub-sessions (parent_id on session) are included and tagged with the parent
 * session's context.
 */
import { ConversationExchange, ConversationSource } from '../types.js';
/**
 * Parse an exported OpenCode session JSON file into exchanges.
 *
 * The export format (produced by discoverConversations → archive step) is:
 * {
 *   session: SessionRow,
 *   project: ProjectRow,
 *   messages: MessageRow[],
 *   parts: PartRow[]
 * }
 */
export declare function parseOpenCodeConversation(filePath: string, projectName: string, archivePath: string): Promise<ConversationExchange[]>;
export declare class OpenCodeSource implements ConversationSource {
    readonly name: "opencode";
    readonly label = "OpenCode";
    /**
     * Discover conversations by reading the OpenCode SQLite DB.
     *
     * For each session, we export a JSON snapshot to the archive directory.
     * The returned filePath points to this export, which parseConversation
     * can read without touching the live DB again.
     */
    discoverConversations(): Promise<Array<{
        project: string;
        filePath: string;
    }>>;
    parseConversation(filePath: string, project: string, archivePath: string): Promise<ConversationExchange[]>;
}
