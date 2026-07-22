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

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import { ConversationExchange, ConversationSource, ToolCall } from '../types.js';
import { getPiSessionsDir, getExcludedProjects } from '../paths.js';

interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, any>;
  toolCallId?: string;
  toolName?: string;
  content?: any;
  isError?: boolean;
}

interface PiMessage {
  role: 'user' | 'assistant' | 'toolResult';
  content: PiContentBlock[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: Record<string, any>;
  stopReason?: string;
  timestamp?: number;
}

interface PiLine {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: PiMessage;
  // session metadata
  version?: number;
  cwd?: string;
  // model_change
  provider?: string;
  modelId?: string;
  // thinking_level_change
  thinkingLevel?: string;
}

/**
 * Decode a Pi directory slug back to a filesystem path.
 * --Users-sheurich-src-foo-- → /Users/sheurich/src/foo
 */
function decodePiSlug(slug: string): string {
  // Strip leading/trailing --
  let inner = slug.replace(/^--/, '').replace(/--$/, '');
  // Replace - with /
  inner = inner.replace(/-/g, '/');
  // Pi uses /private prefix on macOS temp dirs; keep it verbatim
  if (!inner.startsWith('/')) {
    inner = '/' + inner;
  }
  return inner;
}

/**
 * Derive a human-readable project name from the cwd slug.
 * Takes the last meaningful path component.
 */
function projectNameFromSlug(slug: string): string {
  const decoded = decodePiSlug(slug);
  // Use last non-empty component
  const parts = decoded.split('/').filter(Boolean);
  return parts[parts.length - 1] || slug;
}

export async function parsePiConversation(
  filePath: string,
  projectName: string,
  archivePath: string
): Promise<ConversationExchange[]> {
  const exchanges: ConversationExchange[] = [];

  if (!fs.existsSync(filePath)) return exchanges;

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let lineNumber = 0;
  let sessionCwd: string | undefined;
  let sessionId: string | undefined;
  let currentModel: string | undefined;
  let currentProvider: string | undefined;
  let currentThinkingLevel: string | undefined;

  let currentExchange: {
    userMessage: string;
    userLine: number;
    assistantMessages: string[];
    lastAssistantLine: number;
    timestamp: string;
    toolCalls: ToolCall[];
  } | null = null;

  const finalizeExchange = () => {
    if (currentExchange && currentExchange.assistantMessages.length > 0) {
      const exchangeId = crypto
        .createHash('md5')
        .update(`${archivePath}:${currentExchange.userLine}-${currentExchange.lastAssistantLine}`)
        .digest('hex');

      const toolCalls = currentExchange.toolCalls.map(tc => ({
        ...tc,
        exchangeId
      }));

      exchanges.push({
        id: exchangeId,
        project: projectName,
        timestamp: currentExchange.timestamp,
        userMessage: currentExchange.userMessage,
        assistantMessage: currentExchange.assistantMessages.join('\n\n'),
        archivePath,
        lineStart: currentExchange.userLine,
        lineEnd: currentExchange.lastAssistantLine,
        source: 'pi',
        sessionId,
        cwd: sessionCwd,
        model: currentModel,
        modelProvider: currentProvider,
        provider: currentProvider,
        thinkingLevel: currentThinkingLevel,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined
      });
    }
  };

  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;

    let parsed: PiLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    // Handle metadata lines
    if (parsed.type === 'session') {
      sessionCwd = parsed.cwd;
      sessionId = parsed.id;
      continue;
    }

    if (parsed.type === 'model_change') {
      currentModel = parsed.modelId;
      currentProvider = parsed.provider;
      continue;
    }

    if (parsed.type === 'thinking_level_change') {
      currentThinkingLevel = parsed.thinkingLevel;
      continue;
    }

    if (parsed.type !== 'message' || !parsed.message) continue;

    const msg = parsed.message;

    if (msg.role === 'user') {
      finalizeExchange();

      // Extract text from content blocks
      const textParts = (msg.content || [])
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text!);
      const userText = textParts.join('\n') || '(no text)';

      currentExchange = {
        userMessage: userText,
        userLine: lineNumber,
        assistantMessages: [],
        lastAssistantLine: lineNumber,
        timestamp: parsed.timestamp || new Date().toISOString(),
        toolCalls: []
      };
    } else if (msg.role === 'assistant' && currentExchange) {
      const textParts: string[] = [];
      const toolCalls: ToolCall[] = [];

      for (const block of msg.content || []) {
        if (block.type === 'text' && block.text?.trim()) {
          textParts.push(block.text);
        } else if (block.type === 'toolCall') {
          toolCalls.push({
            id: block.id || crypto.randomUUID(),
            exchangeId: '',
            toolName: block.name || 'unknown',
            toolInput: block.arguments,
            isError: false,
            timestamp: parsed.timestamp || new Date().toISOString()
          });
        }
      }

      if (textParts.length > 0) {
        currentExchange.assistantMessages.push(textParts.join('\n'));
      }
      if (toolCalls.length > 0) {
        currentExchange.toolCalls.push(...toolCalls);
      }
      currentExchange.lastAssistantLine = lineNumber;

      if (parsed.timestamp) {
        currentExchange.timestamp = parsed.timestamp;
      }

      // Capture model info from the message itself if present
      if (msg.model) currentModel = msg.model;
      if (msg.provider) currentProvider = msg.provider;
    }
    // toolResult messages are skipped (they're responses to tool calls)
  }

  finalizeExchange();
  return exchanges;
}

export class PiSource implements ConversationSource {
  readonly name = 'pi' as const;
  readonly label = 'Pi';

  async discoverConversations(): Promise<Array<{ project: string; filePath: string }>> {
    const sessionsDir = getPiSessionsDir();
    if (!fs.existsSync(sessionsDir)) return [];

    const excluded = new Set(getExcludedProjects());
    const results: Array<{ project: string; filePath: string }> = [];

    const slugDirs = fs.readdirSync(sessionsDir);
    for (const slug of slugDirs) {
      const slugPath = path.join(sessionsDir, slug);
      if (!fs.statSync(slugPath).isDirectory()) continue;

      const projectName = projectNameFromSlug(slug);
      if (excluded.has(projectName)) continue;

      const files = fs.readdirSync(slugPath).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        results.push({
          project: projectName,
          filePath: path.join(slugPath, file)
        });
      }
    }

    return results;
  }

  async parseConversation(
    filePath: string,
    project: string,
    archivePath: string
  ): Promise<ConversationExchange[]> {
    return parsePiConversation(filePath, project, archivePath);
  }
}
