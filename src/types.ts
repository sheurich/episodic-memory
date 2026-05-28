/** Agent source that produced the conversation */
export type AgentSource = 'claude' | 'gemini' | 'pi' | 'opencode';

export interface ToolCall {
  id: string;
  exchangeId: string;
  toolName: string;
  toolInput?: any;
  toolResult?: string;
  isError: boolean;
  timestamp: string;
}

export type ConversationHarness = 'claude' | 'codex';

export interface ConversationExchange {
  id: string;
  project: string;
  timestamp: string;
  userMessage: string;
  assistantMessage: string;
  archivePath: string;
  lineStart: number;
  lineEnd: number;

  /** Indexed source bucket; Codex transcripts are stored under Claude and distinguished by harness. */
  source: AgentSource;

  // Conversation structure
  parentUuid?: string;
  isSidechain?: boolean;

  // Session context
  harness?: ConversationHarness;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  /** Agent version string (Claude, Gemini CLI, Pi) */
  agentVersion?: string;
  /** @deprecated Use agentVersion instead */
  claudeVersion?: string;

  // Model metadata (available from Gemini, Pi, OpenCode, and Codex sessions)
  model?: string;
  modelProvider?: string;
  /** @deprecated Use modelProvider instead */
  provider?: string;

  // Thinking metadata
  thinkingLevel?: string;
  thinkingDisabled?: boolean;
  thinkingTriggers?: string; // JSON array

  // Tool calls (populated separately)
  toolCalls?: ToolCall[];
}

/**
 * Interface that all source parsers must implement.
 * Each parser discovers conversation files and parses them into exchanges.
 */
export interface ConversationSource {
  /** Unique name for this source (matches AgentSource) */
  readonly name: AgentSource;

  /** Human-readable label for display */
  readonly label: string;

  /**
   * Discover all conversation files from this source.
   * Returns an array of { project, filePath } tuples.
   */
  discoverConversations(): Promise<Array<{
    project: string;
    filePath: string;
  }>>;

  /**
   * Parse a conversation file into exchanges.
   */
  parseConversation(
    filePath: string,
    project: string,
    archivePath: string
  ): Promise<ConversationExchange[]>;
}

export interface SearchResult {
  exchange: ConversationExchange;
  similarity: number;
  snippet: string;
}

export interface MultiConceptResult {
  exchange: ConversationExchange;
  snippet: string;
  conceptSimilarities: number[];
  averageSimilarity: number;
}
