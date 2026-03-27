/** Agent source that produced the conversation */
export type AgentSource = 'claude' | 'gemini' | 'pi';

export interface ToolCall {
  id: string;
  exchangeId: string;
  toolName: string;
  toolInput?: any;
  toolResult?: string;
  isError: boolean;
  timestamp: string;
}

export interface ConversationExchange {
  id: string;
  project: string;
  timestamp: string;
  userMessage: string;
  assistantMessage: string;
  archivePath: string;
  lineStart: number;
  lineEnd: number;

  /** Which agent produced this exchange */
  source: AgentSource;

  // Conversation structure
  parentUuid?: string;
  isSidechain?: boolean;

  // Session context
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  /** Agent version string (Claude, Gemini CLI, Pi) */
  agentVersion?: string;
  /** @deprecated Use agentVersion instead */
  claudeVersion?: string;

  // Model metadata (available from Gemini and Pi sessions)
  model?: string;
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
