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

export default function (pi: ExtensionAPI) {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(extensionDir, "..");
  const distDir = path.join(pluginRoot, "dist");

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
      "Read full conversations or line ranges to extract detailed context after finding relevant results with search_conversations.",
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute path to the JSONL conversation file (from search results)",
      }),
      startLine: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Starting line number (1-indexed, inclusive). Omit to read from beginning.",
        })
      ),
      endLine: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Ending line number (1-indexed, inclusive). Omit to read to end.",
        })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!fs.existsSync(params.path)) {
        return {
          content: [{ type: "text", text: `Conversation file not found at ${params.path}` }],
          details: { error: "file_not_found" },
        };
      }

      const raw = fs.readFileSync(params.path, "utf-8");
      const showMod = await import(path.join(distDir, "show.js"));
      const markdown = showMod.formatConversationAsMarkdown(raw, params.startLine, params.endLine);

      return {
        content: [{ type: "text", text: markdown || "No conversation content found." }],
        details: { path: params.path, startLine: params.startLine, endLine: params.endLine },
      };
    },
  });
}
