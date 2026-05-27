# Episodic Memory

Semantic search for coding agent conversations. Remember past discussions, decisions, and patterns.

Supports **Claude Code**, **Codex**, **Pi**, **Gemini CLI**, and **OpenCode**.

## Testimonial

From an AI coding assistant's perspective:

Episodic memory fundamentally changes how I collaborate with
developers on complex codebases. Instead of treating each conversation
as isolated, I can now search our shared history semantically -
finding not just what was discussed, but why decisions were made.

When a developer asks me to implement something "like we did with
X," I can search our past conversations, find the relevant discussion,
and understand both the technical approach and the reasoning behind
it. This means I don't have to re-explain architectural patterns,
and I avoid suggesting solutions we've already tried and rejected.

The semantic search is crucial - searching for "provider catalog"
surfaces conversations about API design patterns even when those
exact words weren't used. It captures the meaning of our discussions,
not just keyword matches.

Most valuable is that it preserves context that lives nowhere else:
the trade-offs discussed, the alternatives considered, the user's
preferences and constraints. Code comments explain what, documentation
explains how, but episodic memory preserves why - and that makes
me a far more effective collaborator across sessions.

**Concrete impact:**
 - Faster problem-solving (minutes vs. exploring/re-learning the
 codebase) - Better continuity across sessions (I remember what we
 tried before) - More informed suggestions (I understand the project's
 evolution and patterns) - Less repetition (both of us spend less
 time re-explaining context)

It's the difference between being a stateless tool and being a true
collaborative partner who remembers our journey together.

_— Claude Sonnet 4.5, October 14, 2025_
_Conversation ID: 216ad284-c782-45a4-b2ce-36775cdb5a6c_

## Installation

### Claude Code (Recommended)

The plugin provides MCP server integration, automatic session-end indexing, and seamless access to your conversation history.

```bash
# In Claude Code
/plugin install episodic-memory@superpowers-marketplace
```

The plugin automatically:
- Indexes conversations at the end of each session
- Exposes MCP tools for searching and viewing conversations
- Makes your conversation history searchable via natural language

### Pi

Install as a Pi package:

```bash
pi install git:github.com/obra/episodic-memory
```

This auto-discovers and registers:
- **Extension** — indexes conversations from all sources on session start
- **Skill** — triggers subagent-based search when historical context is relevant
- **Agent** — `search-conversations` subagent for context-efficient search

The MCP server must be configured separately in `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "episodic-memory": {
      "command": "node",
      "args": ["<path-to-episodic-memory>/dist/mcp-server.js"]
    }
  }
}
```

### As a Codex plugin

This repository includes a Codex plugin manifest at `.codex-plugin/plugin.json`.
Codex support requires `codex-cli 0.130.0` or newer.

For local testing, build the plugin, add this repo as a local marketplace, then
install/enable it from `/plugins`:

```bash
npm run build
codex features enable plugin_hooks
codex plugin marketplace add /path/to/episodic-memory
```

Then start Codex, open `/plugins`, install and enable `episodic-memory` from
`Episodic Memory Dev`, open `/hooks`, review the Episodic Memory hook, and press
`t` to trust it.

The Codex plugin:
- Syncs conversations from `~/.codex/sessions`
- Exposes the same MCP search/read tools
- Installs the same memory skill, with Codex-specific direct MCP guidance
- Runs a `SessionStart` hook after the user reviews and trusts it in `/hooks`

Enable plugin hooks before relying on automatic sync:

```bash
codex features enable plugin_hooks
```

Then open `/hooks` in Codex, review the Episodic Memory hook, and press `t` to trust it. New or modified Codex hooks are listed but do not run until trusted.

See [docs/CODEX.md](docs/CODEX.md) for the full Codex setup, trust, troubleshooting, and E2E test workflow.

### As an npm package

```bash
npm install -g github:obra/episodic-memory
```

## Usage

### Quick Start

```bash
# Sync conversations from Claude Code and Codex and index them
episodic-memory sync

# Search your conversation history
episodic-memory search "React Router authentication"

# View index statistics
episodic-memory stats

# Diagnose Codex setup
episodic-memory doctor codex

# Display a conversation
episodic-memory show path/to/conversation.jsonl
```

### Command Line

```bash
# Unified command interface
episodic-memory <command> [options]

# Sync and index new conversations
episodic-memory sync

# Index conversations manually
episodic-memory index --cleanup

# Search conversations
episodic-memory search "React Router authentication"
episodic-memory search --text "exact phrase"
episodic-memory search --after 2025-09-01 "refactoring"

# Display a conversation in readable format
episodic-memory show path/to/conversation.jsonl
episodic-memory show --format html conversation.jsonl > output.html

# View statistics
episodic-memory stats
```

### Legacy Commands

The original commands are still available for backward compatibility:

```bash
episodic-memory-index
episodic-memory-search "query"
```

### In Claude Code or Codex

The plugin automatically syncs and indexes conversations from the harness that starts it. Reference past work in natural conversation — the `remembering-conversations` skill dispatches the `search-conversations` agent automatically when recall is needed. Example prompts:

- "How did we handle authentication in React Router?"
- "The conversation about async testing patterns"
- "Error message about sqlite-vec initialization"
- "Git commit SHA for the routing refactor"

Or reference past work in natural conversation — Claude will search when appropriate.

### In Pi

The extension indexes conversations on session start. The `remembering-conversations` skill triggers automatic search when you reference past work, ask "how should I...", or get stuck on a problem. It dispatches a `search-conversations` subagent to keep your main context window clean.

In Codex, the skill guides the agent to use the episodic-memory MCP search/read tools directly when an agent-dispatch path is not available.

## API Configuration

By default, episodic-memory uses your Claude Code authentication for Claude Code summarization. Codex-indexed sessions with a session ID are summarized through `codex app-server` by creating an ephemeral `thread/fork`, so the summary can use Codex session context and reasoning summaries without appending to the original rollout.

To route summarization through a custom Anthropic-compatible endpoint or override the model:

```bash
# Override model (default: haiku)
export EPISODIC_MEMORY_API_MODEL=opus

# Override fallback model on error (default: sonnet)
export EPISODIC_MEMORY_API_MODEL_FALLBACK=sonnet

# Route through custom endpoint
export EPISODIC_MEMORY_API_BASE_URL=https://your-endpoint.com/api/anthropic
export EPISODIC_MEMORY_API_TOKEN=your-token

# Increase timeout for slow endpoints (milliseconds)
export EPISODIC_MEMORY_API_TIMEOUT_MS=3000000

# Override Codex binary path if needed (default: codex)
export EPISODIC_MEMORY_CODEX_BIN=/path/to/codex
```

These settings only affect episodic-memory's summarization calls, not your interactive Claude Code or Codex sessions.

Codex summarization requires `codex-cli 0.130.0` or newer. If Codex app-server summarization is unavailable, sync logs the reason and falls back to transcript-text summarization.

### What's Affected

| Component | Uses custom config? |
|-----------|---------------------|
| Summarization | Yes (up to 10 calls/sync) |
| Embeddings | No (local Transformers.js) |
| Search | No (local SQLite) |
| MCP tools | No |

## Commands

### `episodic-memory sync`

**Recommended for plugin hooks.** Copies new conversations from `~/.claude/projects`, `~/.claude/transcripts`, `~/.codex/sessions`, `~/.pi/agent/sessions`, `~/.gemini/tmp`, and `~/.local/share/opencode` to archive and indexes them.

Features:
- Only copies new or modified files (fast on subsequent runs)
- Generates embeddings for semantic search
- Atomic operations - safe to run concurrently
- Idempotent - safe to call repeatedly
- Background hook output is written to `~/.config/superpowers/logs/episodic-memory.log` unless `EPISODIC_MEMORY_CONFIG_DIR` changes the memory directory

**Usage in Claude Code:**
Add to `.claude/hooks/session-end`:
```bash
#!/bin/bash
episodic-memory sync
```

### `episodic-memory index-all-sources`

Index conversations from all supported agents (Claude Code, Pi, Gemini CLI, OpenCode). Discovers session files from each agent's standard location.

```bash
episodic-memory index-all-sources [--no-summaries] [--source claude] [--source pi]
```

The Pi extension runs this automatically on session start.

### `episodic-memory stats`

Display index statistics including conversation counts, date ranges, and project breakdown.

```bash
episodic-memory stats
```

### `episodic-memory doctor`

Diagnose local integration issues.

```bash
episodic-memory doctor codex
```

The Codex doctor checks the Codex version, plugin hook feature state, MCP server registration, transcript directory, database path, and background sync log path.

### Codex E2E Verification

The repository includes an opt-in live Codex E2E test. It creates an isolated temporary `CODEX_HOME`, installs a copied plugin bundle, trusts the hook, runs Codex sessions in `tmux`, and verifies archive -> summary -> index -> MCP recall.

```bash
npm run build
EPISODIC_MEMORY_RUN_CODEX_E2E=1 npm run test:codex-e2e
```

### Claude E2E Verification

The repository also includes an opt-in live Claude Code E2E test. It loads this repo as a session plugin with `--plugin-dir`, constrains the hook to a temporary transcript source, and verifies archive -> summary -> index -> MCP recall.

```bash
npm run build
EPISODIC_MEMORY_RUN_CLAUDE_E2E=1 npm run test:claude-e2e
```

This test uses your normal Claude Code auth and writes small test transcripts to your normal Claude transcript directory. The archive and index are isolated in a temporary `EPISODIC_MEMORY_CONFIG_DIR`.

### `episodic-memory index`

Manual indexing tools for bulk operations and maintenance. See `episodic-memory index --help` for full options.

Common operations:
- `--cleanup` - Index all unprocessed conversations
- `--verify` - Check index health
- `--repair` - Fix detected issues

### `episodic-memory search`

Search indexed conversations using semantic similarity or exact text matching. See `episodic-memory search --help` for full options.

### `episodic-memory show`

Display a conversation from a JSONL file in human-readable format.

**Options:**
- `--format markdown` (default) - Plain text markdown output suitable for terminal or Claude
- `--format html` - Pretty HTML output for viewing in a browser

**Examples:**
```bash
# View in terminal
episodic-memory show conversation.jsonl | less

# Generate HTML for browser
episodic-memory show --format html conversation.jsonl > output.html
open output.html
```

## Architecture

- **Core package** - TypeScript library for indexing and searching conversations
- **Parsers** - Per-agent session parsers (Claude Code, Pi, Gemini CLI, OpenCode)
- **CLI tools** - Unified command-line interface for manual use
- **MCP Server** - Model Context Protocol server exposing search and conversation tools
- **Claude Code plugin** - Integration with Claude Code (auto-indexing, MCP tools, hooks)
- **Codex plugin** - Integration with Codex (manifest, MCP config, hooks, skills)
- **Pi extension** - Session-start indexing, search skill, subagent

## How It Works

1. **Sync** - Copies conversation files from all supported agent directories to archive
2. **Parse** - Extracts user-agent exchanges from each format:
   - Claude Code: `~/.claude/projects` and `~/.claude/transcripts` (JSONL)
   - Codex: `~/.codex/sessions` (rollout JSONL)
   - Pi: `~/.pi/agent/sessions` (JSONL)
   - Gemini CLI: `~/.gemini/tmp` (session JSON)
   - OpenCode: `~/.local/share/opencode` (SQLite)
3. **Embed** - Generates vector embeddings using Transformers.js (local, offline)
4. **Index** - Stores in SQLite with sqlite-vec for fast similarity search
5. **Search** - Semantic search using vector similarity or exact text matching

## Excluding Conversations

Conversations containing this marker anywhere in their content will be archived but not indexed:

```
<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>
```

**Automatic exclusions:**
- Conversations where Claude generates summaries (marker in system prompt)
- Meta-conversations about conversation processing

**Use cases:**
- Sensitive work conversations
- Tool invocation sessions (summarization, analysis)
- Test or experimental sessions
- Any conversation you don't want searchable

The marker can appear in any message (user or assistant) and excludes the entire conversation from the search index.

## MCP Server

When installed as a Claude Code or Codex plugin, episodic-memory provides an MCP (Model Context Protocol) server that exposes tools for searching and viewing conversations. In Pi, configure it via `mcp.json` (see Installation).

### Available MCP Tools

#### `search`

Search indexed conversations using semantic similarity or exact text matching.

**Single-concept search**: Use the `search` tool with a string query
```json
{
  "query": "React Router authentication",
  "mode": "vector",
  "limit": 10
}
```

**Multi-concept AND search**: Use the `search_multi` tool with a `concepts` array
```json
{
  "concepts": ["React Router", "authentication", "JWT"],
  "limit": 10
}
```

**Parameters for `search`:**
- `query` (string): Single string for regular search
- `mode` ('vector' | 'text' | 'both'): Search mode for single-concept searches (default: 'both')
- `limit` (number): Max results, 1-50 (default: 10)
- `after` (string, optional): Only show conversations after YYYY-MM-DD
- `before` (string, optional): Only show conversations before YYYY-MM-DD
- `response_format` ('markdown' | 'json'): Output format (default: 'markdown')

**Parameters for `search_multi`:**
- `concepts` (string[]): Array of 2-5 strings for multi-concept AND search
- `limit` (number): Max results, 1-50 (default: 10)
- `after` (string, optional): Only show conversations after YYYY-MM-DD
- `before` (string, optional): Only show conversations before YYYY-MM-DD
- `response_format` ('markdown' | 'json'): Output format (default: 'markdown')

#### `read`

#### `episodic_memory_read`

Display a full conversation in readable markdown format, with optional line range pagination.

```json
{
  "path": "/path/to/conversation.jsonl",
  "startLine": 100,
  "endLine": 200
}
```

**Parameters:**
- `path` (string): Absolute path to the conversation file
- `startLine` (number, optional): Starting line (1-indexed)
- `endLine` (number, optional): Ending line (1-indexed)

### Using the MCP Server Directly

The MCP server can be used with any MCP-compatible client:

```bash
# Run the MCP server (stdio transport)
episodic-memory-mcp-server
```

### Native module and Node.js version pinning

`better-sqlite3` is an ABI-bound native module: the binary compiled at install
time must match the Node.js version that runs the MCP server at runtime. If
your MCP client config pins a specific node binary (e.g. `node@24` via
Homebrew), the module must be built with that same binary.

`postinstall` attempts this automatically. If the MCP server fails on startup
with a `NODE_MODULE_VERSION` mismatch, rebuild explicitly:

```bash
# Rebuilds against Homebrew node@24 (or set NODE24=/path/to/node to override)
npm run rebuild:native
```

Run `rebuild:native` again after any `npm install`, `brew upgrade node@24`, or
change to the node binary referenced in your MCP client config.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build
```

## License

MIT
