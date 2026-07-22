# OpenCode Source Parser — Feasibility Analysis

**Date:** 2026-03-27
**Branch:** `multi-source-indexing`
**OpenCode version:** 1.3.0 (Zig/Bun rewrite; npm package `opencode-ai`)

## 1. Session Storage Format

### Storage location

OpenCode uses a **single SQLite database** at:

```
$XDG_DATA_HOME/opencode/opencode.db     # default: ~/.local/share/opencode/opencode.db
```

Overridable via `OPENCODE_DB` environment variable (absolute path, or relative to
the data directory).

A file-based mirror exists under `~/.local/share/opencode/storage/` with
per-session directories for messages and per-message directories for parts
(JSON files, 1:1 with DB records). Either interface could be used; the SQLite
DB is more practical for a parser since it supports indexed queries and
eliminates filesystem traversal.

### Schema (Drizzle ORM, 9 migrations through 2026-03-12)

```
project   → id (sha1 of worktree path | "global"), worktree, name, vcs, time_created, …
session   → id, project_id FK, parent_id (nullable self-ref), slug, directory, title,
             version, time_created, time_updated, time_archived, summary_*, workspace_id
message   → id, session_id FK (cascade delete), time_created, time_updated, data (JSON)
part      → id, message_id FK (cascade delete), session_id, time_created, time_updated, data (JSON)
```

Supporting tables: `permission`, `todo`, `session_share`, `workspace`,
`account`, `account_state`, `control_account`.

### Message `data` JSON structure

**User messages:**
```json
{
  "role": "user",
  "time": { "created": 1769801425193 },
  "summary": { "title": "...", "diffs": [] },
  "agent": "plan",                          // "plan" | "build" | "explore"
  "model": {
    "providerID": "amazon-bedrock",
    "modelID": "global.anthropic.claude-opus-4-5-20251101-v1:0"
  }
}
```

Text content is NOT in the message `data` column. It is stored in the `part`
table.

**Assistant messages:**
```json
{
  "role": "assistant",
  "time": { "created": ..., "completed": ... },
  "parentID": "msg_...",                    // links to user message
  "modelID": "...",
  "providerID": "...",
  "mode": "plan",
  "agent": "plan",
  "path": { "cwd": "/...", "root": "/..." },
  "cost": 0.11822375,
  "tokens": { "input": 7016, "output": 382, "reasoning": 0, "cache": { "read": 0, "write": 11775 } },
  "finish": "stop",
  "error": null | { "name": "APIError"|"MessageAbortedError", "data": { "message": "..." } }
}
```

### Part `data` JSON structure

| `type`        | Key fields                                              |
|---------------|---------------------------------------------------------|
| `text`        | `text`, `time.start`, `time.end`                        |
| `tool`        | `callID`, `tool`, `state.status`, `state.input`, `state.output` |
| `reasoning`   | `text`, `metadata.bedrock.signature`, `time`            |
| `step-start`  | `snapshot`                                              |
| `step-finish` | `reason`, `cost`, `tokens`, `snapshot`                  |

Part type distribution in the local database (337 total):
- `tool`: 142  (42%)
- `text`: 71   (21%)
- `step-start`: 59
- `step-finish`: 56
- `reasoning`: 9

### Timestamps

All timestamps are **Unix milliseconds** (e.g., `1769801425193`).

### Agent modes

OpenCode has three agent modes: `plan`, `build`, `explore`. The mode is
recorded on both user and assistant messages.

### Sub-sessions

Sessions can have a `parent_id` pointing to another session. These represent
OpenCode's subagent-spawned sessions (e.g., `@explore` subagent). Example:

```
ses_3ef9d5eddffe3mqhKobR8rq43S  "UniFi infrastructure gaps analysis"
  ├─ ses_3ef9d39a9ffeOsIimCoUR7hI7i  "Explore UniFi Terraform config (@explore)"
  ├─ ses_3ef9d2b5dffechVMYn9kNvOxhY  "Explore monitoring/alerting setup (@explore)"
  └─ ses_3ef9d3295ffecoBqzijijodmOW  "Explore Ansible UniFi config (@explore)"
```

## 2. Exchange Reconstruction Complexity

### The fundamental difference from other parsers

| Property | Claude/Pi (JSONL) | Gemini (JSON) | OpenCode (SQLite) |
|----------|-------------------|---------------|--------------------|
| Storage | One file per session | One file per session | Single shared database |
| Message text | Inline in message | Inline in message | Separate `part` table |
| User→Assistant | Sequential in file | Sequential in array | `parentID` FK linking |
| Multi-step agent | Flat sequence | Flat sequence | **N assistant msgs per 1 user msg** |
| Tool calls | Inline | Inline | Separate parts on assistant messages |

### Key challenge: one-to-many user→assistant mapping

In Claude/Pi/Gemini, the assistant produces a single message (possibly
multi-turn but sequentially in the file). In OpenCode, one user message
generates **multiple assistant message rows**, each representing one "step"
in the agentic loop. A single exchange with one user message often has 5–10
assistant messages, each with its own tool calls and text fragments.

Example from the local database: one user message
(`msg_c1062a125001240GkZ14dMPSU1`) produced **8 assistant messages**, with text
spread across 7 of them and tool calls across all 8.

**Reconstruction algorithm:**

1. Query all sessions (optionally filter out `time_archived` sessions).
2. For each session, query messages ordered by `time_created`.
3. Group user messages with their corresponding assistant messages
   (`parentID = user.id`).
4. For each group, query parts where `message_id IN (assistant_msg_ids)`
   and `type = 'text'`.
5. Concatenate text parts in `time_created` order.
6. Optionally extract tool calls from `type = 'tool'` parts.

This is more complex than the existing parsers but straightforward SQL.

### Model metadata

Richer than any existing source. Provider and model ID are available on both
the user message (the selected model) and each assistant message (the model
that actually ran). Provider IDs include `amazon-bedrock`, `google-vertex`,
`google-vertex-anthropic`. Model IDs include full version strings.

### Error handling

8 of 87 messages (9%) in the local DB have errors (`MessageAbortedError`,
`APIError`). These should be filtered out — they contain no useful text
content.

## 3. Interface Mapping

| `ConversationSource` method | OpenCode mapping | Complexity |
|-----------------------------|------------------|------------|
| `name` | `'opencode'` | Trivial — requires adding to `AgentSource` union |
| `label` | `'OpenCode'` | Trivial |
| `discoverConversations()` | SQL: `SELECT s.id, s.directory, p.worktree FROM session s JOIN project p` | Low — returns session IDs as "file paths" |
| `parseConversation()` | SQL: join messages + parts, group by user msg | Medium — multi-step grouping |

### `archivePath` adaptation

The existing interface assumes file-based conversations. For OpenCode:

- **Option A (recommended):** Export each session to a JSON file in the
  archive directory, then treat it like Gemini. The synthetic path would be
  `<archiveDir>/opencode/<project>/ses_<id>.json`. This preserves the
  dedup-by-archivePath pattern and the ability to re-parse from archive.

- **Option B:** Use a synthetic path like `opencode://<session_id>` and
  dedup by session ID directly. Requires changing the archivePath-based dedup
  in `indexer.ts`.

Option A is preferred because it requires no changes to the indexer.

### Exchange ID generation

The existing `md5(archivePath:lineStart-lineEnd)` scheme doesn't apply
directly since there are no line numbers. Substitute with
`md5(archivePath:userMsgId)` using the OpenCode message ID, which is a
stable unique identifier.

## 4. Implementation Estimate

### New files

| File | Lines (est.) | Description |
|------|-------------|-------------|
| `src/parsers/opencode.ts` | ~200 | Parser: DB connection, session discovery, exchange reconstruction |
| `test/opencode-parser.test.ts` | ~80 | Unit tests with fixture DB |
| `test/fixtures/opencode.db` | — | Pre-populated test SQLite DB (small, ~50KB) |

### Modified files

| File | Change | Lines |
|------|--------|-------|
| `src/types.ts` | Add `'opencode'` to `AgentSource` union | 1 |
| `src/parsers/index.ts` | Import + register `OpenCodeSource` | 4 |
| `src/paths.ts` | Add `getOpenCodeDbPath()` with `OPENCODE_DB` override | 10 |
| `src/search.ts` | Add `[OPENCODE]` label in results | 2 |

**Total estimated new/changed code: ~300 lines.**

### Dependencies

The parser needs to read OpenCode's SQLite database. The project already uses
`better-sqlite3`, so no new dependency is required. The DB can be opened
read-only (`{ readonly: true }`).

### Schema changes to episodic-memory DB

None. The existing `source`, `model`, `provider`, `agent_version` columns
accommodate OpenCode data without changes. The `source` column would store
`'opencode'`.

### Test fixture strategy

Create a minimal SQLite DB with:
- 1 project
- 2 sessions (1 top-level, 1 sub-session)
- 4 user messages, 8+ assistant messages
- Mix of text, tool, and reasoning parts
- 1 error message to test filtering

This is slightly more involved than the JSON/JSONL fixtures (~50KB
pre-built DB file) but avoids needing to mock SQLite.

## 5. Risks and Considerations

### Low risk

- **Schema stability:** The Drizzle migration history shows active evolution
  (9 migrations in 2 months). However, the core tables (`session`, `message`,
  `part`) and their `data` JSON shape have remained stable since the initial
  migration. New migrations add columns to `session` and new tables for
  accounts/workspaces — none alter the message/part schema.

- **Data volume:** Only 12 sessions / 87 messages / 337 parts in the local
  database. OpenCode is lightly used. Even with heavy use, the single-DB
  design means discovery is a simple SQL query, not filesystem traversal.

- **Read-only access:** Opening the DB with `{ readonly: true }` eliminates
  any risk of corrupting OpenCode's live database.

### Medium risk

- **Concurrent access:** OpenCode's DB uses WAL mode (`.db-shm`, `.db-wal`
  present). `better-sqlite3` can read WAL databases, but if OpenCode holds
  an exclusive lock during compaction or migration, reads could fail. Mitigation:
  open with `readonly: true` and catch/retry on `SQLITE_BUSY`.

- **Closed-source v1.x:** The 1.x rewrite source is not publicly available
  (the GitHub repo only has the 0.x Go version). Schema documentation is
  limited to what we can observe from the binary strings and live database.
  However, the Drizzle migration SQL extracted from the binary is
  authoritative — it IS the schema definition.

- **`data` JSON field evolution:** Message and part content is stored as
  untyped JSON in a `TEXT` column. The JSON shape could change between
  versions without a SQL migration. Defensive parsing (optional fields,
  graceful fallbacks) is essential.

### Not a risk

- **OpenCode not installed locally:** It is installed (v1.3.0) with real
  session data.

- **Format incompatibility with exchange-pair model:** Despite the more
  complex multi-step structure, the data maps well to the exchange model.
  Each user message + its aggregated assistant text = one exchange.

## 6. Comparison to Existing Parsers

| Aspect | Claude | Gemini | Pi | OpenCode |
|--------|--------|--------|----|----------|
| Format | JSONL file | JSON file | JSONL file | SQLite DB |
| Discovery | Walk `~/.claude/projects/` | Walk `~/.gemini/tmp/` | Walk `~/.pi/agent/sessions/` | `SELECT` from DB |
| Parsing | Stream JSONL | Parse JSON | Stream JSONL | SQL joins |
| Content extraction | Inline blocks | String or `{text}[]` | Content blocks | Part table join |
| Project resolution | Directory name | sha256→projects.json | Slug decode | `project.worktree` |
| Unique complexity | Sidechains, thinking | Content normalization | Slug encoding | Multi-step aggregation |
| Implementation effort | (existing) | ~180 lines | ~210 lines | **~200 lines** |

## 7. Recommendation

**Go.** The implementation is straightforward and comparable in size to the
Gemini and Pi parsers. Key advantages:

1. **No new dependencies** — `better-sqlite3` is already available.
2. **No schema changes** — existing columns accommodate all metadata.
3. **Rich metadata** — model, provider, cost, token counts, agent mode, cwd.
4. **Clean mapping** — despite the multi-step structure, the `parentID`
   linkage makes exchange reconstruction deterministic.

The main engineering decision is whether to export sessions to JSON for
archival (Option A) or adapt the dedup to work with synthetic paths (Option B).
Option A is recommended for consistency with the existing architecture.

Suggested implementation order:
1. Add `getOpenCodeDbPath()` to `paths.ts`
2. Add `'opencode'` to `AgentSource` type
3. Implement `OpenCodeSource` class in `src/parsers/opencode.ts`
4. Create test fixture DB and write tests
5. Register in `src/parsers/index.ts`
6. Add `[OPENCODE]` label in `src/search.ts`
