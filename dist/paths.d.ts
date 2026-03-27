/**
 * Get the personal superpowers directory
 *
 * Precedence:
 * 1. EPISODIC_MEMORY_CONFIG_DIR env var (if set, for testing)
 * 2. PERSONAL_SUPERPOWERS_DIR env var (if set)
 * 3. XDG_CONFIG_HOME/superpowers (if XDG_CONFIG_HOME is set)
 * 4. ~/.config/superpowers (default)
 */
export declare function getSuperpowersDir(): string;
/**
 * Get conversation archive directory
 */
export declare function getArchiveDir(): string;
/**
 * Get conversation index directory
 */
export declare function getIndexDir(): string;
/**
 * Get database path
 */
export declare function getDbPath(): string;
/**
 * Get exclude config path
 */
export declare function getExcludeConfigPath(): string;
/**
 * Get list of projects to exclude from indexing
 * Configurable via env var or config file
 */
export declare function getExcludedProjects(): string[];
/**
 * Get Gemini CLI base directory.
 * Override with GEMINI_HOME for testing.
 */
export declare function getGeminiDir(): string;
/**
 * Get the directory containing Gemini CLI chat sessions.
 * Sessions live under ~/.gemini/tmp/<projectHash>/chats/
 */
export declare function getGeminiChatsBaseDir(): string;
/**
 * Get Pi base directory.
 * Override with PI_HOME for testing.
 */
export declare function getPiDir(): string;
/**
 * Get the directory containing Pi session JSONL files.
 * Sessions live under ~/.pi/agent/sessions/<cwd-hash>/
 */
export declare function getPiSessionsDir(): string;
/**
 * Get the OpenCode data directory.
 * Override with OPENCODE_DATA_DIR for testing.
 */
export declare function getOpenCodeDataDir(): string;
/**
 * Get the path to the OpenCode SQLite database.
 * Override with OPENCODE_DB for testing.
 * Follows the same resolution as the OpenCode binary:
 *   OPENCODE_DB (absolute) or <dataDir>/OPENCODE_DB (relative),
 *   defaulting to <dataDir>/opencode.db.
 */
export declare function getOpenCodeDbPath(): string;
