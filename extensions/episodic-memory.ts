/**
 * Episodic Memory Extension for Pi
 *
 * 1. On session start, runs the background multi-source indexer.
 * 2. Registers native Pi tools: search_conversations, read_conversation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ConversationReadError, createConversationReader } from "../src/conversation-reader.js";
import { getArchiveDir } from "../src/paths.js";

export default function (pi: ExtensionAPI) {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(extensionDir, "..");
  const distDir = path.join(pluginRoot, "dist");
  // Capture the configured trust boundary once. Tool arguments can select a
  // file within this root, but can never redefine the root itself.
  const conversationReader = createConversationReader(getArchiveDir());

  // 1. Session start background indexing
  pi.on("session_start", async (_event, _ctx) => {
    if (process.env.EPISODIC_MEMORY_DISABLE_AUTO_SYNC === "1") return;

    const indexCli = path.join(distDir, "index-cli.js");
    if (!fs.existsSync(indexCli)) return;

    // Fire and forget — don't block session startup
    const child = spawn("node", [indexCli, "index-all-sources", "--no-summaries"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  });

  // 2. Register native search tool
  pi.registerTool({
    name: "search_conversations",
    label: "Search Conversations",
    description:
      "Search episodic memory across past coding agent sessions (Claude Code, Codex, Pi, Gemini, Cursor, OpenCode). Recalls past discussions, decisions, patterns, solutions, and gotchas.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search query for semantic and/or text search",
      }),
      mode: Type.Optional(
        Type.Union([Type.Literal("vector"), Type.Literal("text"), Type.Literal("both")], {
          description: "Search mode: 'vector' for semantic similarity, 'text' for exact keyword match, 'both' for combined (default: 'both')",
          default: "both",
        })
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 50,
          description: "Maximum number of results to return (default: 10)",
          default: 10,
        })
      ),
      project: Type.Optional(
        Type.String({
          description: "Filter by project name (exact match)",
        })
      ),
      after: Type.Optional(
        Type.String({
          description: "Only return conversations after this date (YYYY-MM-DD)",
        })
      ),
      before: Type.Optional(
        Type.String({
          description: "Only return conversations before this date (YYYY-MM-DD)",
        })
      ),
      include_sidechains: Type.Optional(
        Type.Boolean({
          description: "Include subagent/workflow conversations (default: true)",
          default: true,
        })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const searchMod = await import(path.join(distDir, "search.js"));
      const options = {
        mode: params.mode ?? "both",
        limit: params.limit ?? 10,
        project: params.project,
        after: params.after,
        before: params.before,
        include_sidechains: params.include_sidechains ?? true,
      };

      const results = await searchMod.searchConversations(params.query, options);
      if (!results || results.length === 0) {
        return {
          content: [{ type: "text", text: `No conversations found matching "${params.query}".` }],
          details: { count: 0, query: params.query },
        };
      }

      const formatted = await searchMod.formatResults(results);
      return {
        content: [{ type: "text", text: formatted }],
        details: {
          count: results.length,
          query: params.query,
          results: results.map((r: any) => ({
            id: r.exchange?.id,
            project: r.exchange?.project,
            archivePath: r.exchange?.archivePath,
            lineStart: r.exchange?.lineStart,
            lineEnd: r.exchange?.lineEnd,
            similarity: r.similarity,
          })),
        },
      };
    },
  });

  // 3. Register native read tool
  pi.registerTool({
    name: "read_conversation",
    label: "Read Conversation",
    description:
      "Read a bounded window of up to 40 lines from a JSONL conversation path returned by search_conversations.",
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute archive JSONL path returned by search_conversations",
      }),
      startLine: Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "Starting physical JSONL line number (1-indexed, inclusive)",
      }),
      endLine: Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "Ending physical JSONL line number (1-indexed, inclusive; at most 40 selected lines)",
      }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const result = await conversationReader.readConversation(params, signal);
        return {
          content: [{ type: "text", text: result.markdown || "No conversation content found in the selected lines." }],
          details: {
            path: result.path,
            startLine: result.startLine,
            endLine: result.endLine,
            linesRead: result.linesRead,
          },
        };
      } catch (error) {
        const code = error instanceof ConversationReadError
          ? error.code
          : error instanceof Error && error.name === "AbortError"
            ? "cancelled"
            : "read_failed";
        const message = error instanceof ConversationReadError
          ? error.message
          : code === "cancelled"
            ? "Conversation read cancelled."
            : "Conversation read failed safely.";
        return {
          content: [{ type: "text", text: message }],
          details: { error: code },
        };
      }
    },
  });
}
