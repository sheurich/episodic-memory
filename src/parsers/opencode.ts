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

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ConversationExchange, ConversationSource, ToolCall } from '../types.js';
import { getOpenCodeDbPath, getOpenCodeDataDir, getExcludedProjects } from '../paths.js';

// ── Internal types for DB rows and JSON payloads ──

interface SessionRow {
  id: string;
  project_id: string;
  directory: string;
  title: string;
  version: string;
  time_created: number;
  parent_id: string | null;
}

interface ProjectRow {
  id: string;
  worktree: string;
  name: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string; // JSON
}

interface PartRow {
  id: string;
  message_id: string;
  time_created: number;
  data: string; // JSON
}

interface MessageData {
  role: 'user' | 'assistant';
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  agent?: string;
  time?: { created?: number; completed?: number };
  path?: { cwd?: string; root?: string };
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number };
  finish?: string;
  error?: { name: string; data?: { message?: string } } | null;
  model?: { providerID?: string; modelID?: string };
}

interface PartData {
  type: 'text' | 'tool' | 'reasoning' | 'step-start' | 'step-finish';
  text?: string;
  callID?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: any;
    output?: string;
  };
  time?: { start?: number; end?: number };
}

// ── Helpers ──

function msToISO(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Derive a human-readable project name from the session directory or project worktree.
 */
function projectNameFromPath(dirPath: string): string {
  const parts = dirPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'unknown';
}

// ── Parser ──

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
export async function parseOpenCodeConversation(
  filePath: string,
  projectName: string,
  archivePath: string
): Promise<ConversationExchange[]> {
  let data: {
    session: SessionRow;
    project: ProjectRow;
    messages: MessageRow[];
    parts: PartRow[];
  };

  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }

  if (!data.messages || data.messages.length === 0) return [];

  return buildExchanges(data.session, data.messages, data.parts, projectName, archivePath);
}

/**
 * Core exchange builder, shared between parseOpenCodeConversation and direct DB reading.
 */
function buildExchanges(
  session: SessionRow,
  messages: MessageRow[],
  parts: PartRow[],
  projectName: string,
  archivePath: string
): ConversationExchange[] {
  const exchanges: ConversationExchange[] = [];

  // Index parts by message ID
  const partsByMessage = new Map<string, PartRow[]>();
  for (const part of parts) {
    const arr = partsByMessage.get(part.message_id) || [];
    arr.push(part);
    partsByMessage.set(part.message_id, arr);
  }

  // Sort messages by time
  const sorted = [...messages].sort((a, b) => a.time_created - b.time_created);

  // Parse message data
  const parsed = sorted.map(m => {
    let md: MessageData;
    try {
      md = JSON.parse(m.data);
    } catch {
      md = { role: 'user' };
    }
    return { row: m, data: md };
  });

  // Identify user messages and group assistant messages by parentID
  const userMessages = parsed.filter(m => m.data.role === 'user');
  const assistantByParent = new Map<string, typeof parsed>();
  for (const m of parsed) {
    if (m.data.role === 'assistant' && m.data.parentID) {
      const arr = assistantByParent.get(m.data.parentID) || [];
      arr.push(m);
      assistantByParent.set(m.data.parentID, arr);
    }
  }

  for (let i = 0; i < userMessages.length; i++) {
    const userMsg = userMessages[i];
    const userParts = partsByMessage.get(userMsg.row.id) || [];

    // Extract user text from parts
    const userTextParts: string[] = [];
    for (const p of userParts) {
      let pd: PartData;
      try { pd = JSON.parse(p.data); } catch { continue; }
      if (pd.type === 'text' && pd.text?.trim()) {
        userTextParts.push(pd.text);
      }
    }
    const userText = userTextParts.join('\n') || '(no text)';

    // Collect assistant messages for this user message
    const assistantMsgs = assistantByParent.get(userMsg.row.id) || [];

    // Gather text and tool calls from assistant messages + their parts
    const assistantTexts: string[] = [];
    const toolCalls: ToolCall[] = [];
    let lastModel: string | undefined;
    let lastProvider: string | undefined;
    let latestTimestamp = userMsg.row.time_created;

    for (const aMsg of assistantMsgs) {
      // Skip errored messages
      if (aMsg.data.error) continue;

      // Track model/provider from the assistant message that actually ran
      if (aMsg.data.modelID) lastModel = aMsg.data.modelID;
      if (aMsg.data.providerID) lastProvider = aMsg.data.providerID;

      if (aMsg.row.time_created > latestTimestamp) {
        latestTimestamp = aMsg.row.time_created;
      }

      const aParts = partsByMessage.get(aMsg.row.id) || [];
      // Sort parts by time_created for consistent ordering
      aParts.sort((a, b) => a.time_created - b.time_created);

      for (const p of aParts) {
        let pd: PartData;
        try { pd = JSON.parse(p.data); } catch { continue; }

        if (pd.type === 'text' && pd.text?.trim()) {
          assistantTexts.push(pd.text);
        } else if (pd.type === 'tool' && pd.tool) {
          toolCalls.push({
            id: pd.callID || crypto.randomUUID(),
            exchangeId: '', // filled below
            toolName: pd.tool,
            toolInput: pd.state?.input,
            toolResult: pd.state?.output,
            isError: pd.state?.status === 'error',
            timestamp: pd.time?.start ? msToISO(pd.time.start) : msToISO(userMsg.row.time_created),
          });
        }
      }
    }

    const assistantMessage = assistantTexts.join('\n\n');
    if (!assistantMessage.trim() && toolCalls.length === 0) continue;

    // Resolve model from user message selection if assistant didn't override
    if (!lastModel && userMsg.data.model?.modelID) {
      lastModel = userMsg.data.model.modelID;
    }
    if (!lastProvider && userMsg.data.model?.providerID) {
      lastProvider = userMsg.data.model.providerID;
    }

    // Exchange ID: md5(archivePath:userMsgId) — stable and unique
    const exchangeId = crypto
      .createHash('md5')
      .update(`${archivePath}:${userMsg.row.id}`)
      .digest('hex');

    const finalToolCalls = toolCalls.map(tc => ({ ...tc, exchangeId }));

    // Use index as lineStart/lineEnd substitute (no line numbers in SQLite)
    exchanges.push({
      id: exchangeId,
      project: projectName,
      timestamp: msToISO(latestTimestamp),
      userMessage: userText,
      assistantMessage,
      archivePath,
      lineStart: i + 1,
      lineEnd: i + 1 + assistantMsgs.length,
      source: 'opencode',
      sessionId: session.id,
      cwd: session.directory,
      agentVersion: session.version,
      model: lastModel,
      modelProvider: lastProvider,
      provider: lastProvider,
      toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
    });
  }

  return exchanges;
}

// ── Source class ──

export class OpenCodeSource implements ConversationSource {
  readonly name = 'opencode' as const;
  readonly label = 'OpenCode';

  /**
   * Discover conversations by reading the OpenCode SQLite DB.
   *
   * For each session, we export a JSON snapshot to the archive directory.
   * The returned filePath points to this export, which parseConversation
   * can read without touching the live DB again.
   */
  async discoverConversations(): Promise<Array<{ project: string; filePath: string }>> {
    const dbPath = getOpenCodeDbPath();
    if (!fs.existsSync(dbPath)) return [];

    let db: Database.Database;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      return [];
    }

    const excluded = new Set(getExcludedProjects());
    const results: Array<{ project: string; filePath: string }> = [];

    try {
      // Verify expected tables exist (schema may differ across versions)
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session','message','part','project')"
      ).all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map(t => t.name));
      if (!tableNames.has('session') || !tableNames.has('message') || !tableNames.has('part')) {
        db.close();
        return [];
      }

      const sessions = db.prepare(`
        SELECT s.id, s.project_id, s.directory, s.title, s.version,
               s.time_created, s.parent_id
        FROM session s
        ORDER BY s.time_created
      `).all() as SessionRow[];

      // Load project data
      const projects = tableNames.has('project')
        ? db.prepare('SELECT id, worktree, name FROM project').all() as ProjectRow[]
        : [];
      const projectMap = new Map(projects.map(p => [p.id, p]));

      for (const session of sessions) {
        // Derive project name from project table worktree or session directory.
        // The "global" project has worktree "/", so fall back to session.directory.
        const proj = projectMap.get(session.project_id);
        const worktree = proj?.worktree;
        const dirPath = (worktree && worktree !== '/') ? worktree : session.directory;
        const projectName = proj?.name || projectNameFromPath(dirPath);

        if (excluded.has(projectName)) continue;

        // Check this session has at least one user message
        const hasUser = db.prepare(
          "SELECT 1 FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' LIMIT 1"
        ).get(session.id);
        if (!hasUser) continue;

        // Export session data to a JSON file
        const messages = db.prepare(
          'SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created'
        ).all(session.id) as MessageRow[];

        const messageIds = messages.map(m => m.id);
        let parts: PartRow[] = [];
        if (messageIds.length > 0) {
          // Query parts in batches to avoid SQLite variable limit
          const batchSize = 500;
          for (let i = 0; i < messageIds.length; i += batchSize) {
            const batch = messageIds.slice(i, i + batchSize);
            const placeholders = batch.map(() => '?').join(',');
            const batchParts = db.prepare(
              `SELECT id, message_id, time_created, data FROM part WHERE message_id IN (${placeholders}) ORDER BY time_created`
            ).all(...batch) as PartRow[];
            parts.push(...batchParts);
          }
        }

        const exportData = {
          session: {
            id: session.id,
            project_id: session.project_id,
            directory: session.directory,
            title: session.title,
            version: session.version,
            time_created: session.time_created,
            parent_id: session.parent_id,
          },
          project: proj || { id: session.project_id, worktree: session.directory, name: null },
          messages,
          parts,
        };

        // Write export to a temp file; the indexer will copy it to the archive
        const exportDir = path.join(getOpenCodeDataDir(), 'exports');
        fs.mkdirSync(exportDir, { recursive: true });
        const exportPath = path.join(exportDir, `${session.id}.json`);
        fs.writeFileSync(exportPath, JSON.stringify(exportData), 'utf-8');

        results.push({
          project: projectName,
          filePath: exportPath,
        });
      }
    } finally {
      db.close();
    }

    return results;
  }

  async parseConversation(
    filePath: string,
    project: string,
    archivePath: string
  ): Promise<ConversationExchange[]> {
    return parseOpenCodeConversation(filePath, project, archivePath);
  }
}
