# Episodic Memory MCP Tools Reference

The episodic-memory MCP server exposes two tools: `search` and `read`.

> **Claude Code note:** Claude Code auto-prefixes MCP tool names. These tools
> appear as `mcp__plugin_episodic-memory_episodic-memory__search` and
> `mcp__plugin_episodic-memory_episodic-memory__read` in Claude Code.

## search

Search your episodic memory of past conversations using semantic or text search for a single query term or phrase.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | Yes | Single-concept search query |
| `mode` | `"vector"` \| `"text"` \| `"both"` | No | Search mode (default: `"both"`) |
| `limit` | `number` | No | Maximum results to return, 1-50 (default: 10) |
| `after` | `string` | No | Only return conversations after this date (YYYY-MM-DD) |
| `before` | `string` | No | Only return conversations before this date (YYYY-MM-DD) |
| `response_format` | `"markdown"` \| `"json"` | No | Output format (default: `"markdown"`) |

## search_multi

Search for conversations that match ALL provided concepts.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `concepts` | `string[]` | Yes | Multi-concept AND search terms (2-5 strings) |
| `limit` | `number` | No | Maximum results to return, 1-50 (default: 10) |
| `after` | `string` | No | Only return conversations after this date (YYYY-MM-DD) |
| `before` | `string` | No | Only return conversations before this date (YYYY-MM-DD) |
| `response_format` | `"markdown"` \| `"json"` | No | Output format (default: `"markdown"`) |

### Search Modes

- **`vector`** — Semantic similarity search using embeddings
- **`text`** — Exact text matching (case-insensitive)
- **`both`** — Combined semantic + text search (default, recommended)

### Single-Concept Search

```json
{
  "query": "React Router authentication errors",
  "mode": "both",
  "limit": 10
}
```

### Multi-Concept Search (AND)

Search for conversations containing ALL concepts with `search_multi`:

```json
{
  "concepts": ["authentication", "React Router", "error handling"],
  "limit": 10
}
```

### Date Filtering

```json
{
  "query": "refactoring patterns",
  "after": "2025-09-01",
  "before": "2025-10-01"
}
```

### Response Format

#### Markdown (default)

Human-readable format with:
- Project name and date
- Conversation summary
- Matched exchange snippet
- Similarity score
- File path and line numbers

#### JSON

Machine-readable format:
```json
{
  "results": [...],
  "count": 5,
  "mode": "both"
}
```

## read

Display a full conversation from episodic memory as markdown.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | Absolute path to the conversation file |
| `startLine` | `number` | No | Starting line number (1-indexed, inclusive) |
| `endLine` | `number` | No | Ending line number (1-indexed, inclusive) |

### Usage

**Read entire conversation:**
```json
{
  "path": "/path/to/conversation-archive/project/uuid.jsonl"
}
```

**Read specific range:**
```json
{
  "path": "/path/to/conversation-archive/project/uuid.jsonl",
  "startLine": 100,
  "endLine": 200
}
```

### Response Format

Markdown-formatted conversation with:
- Message roles (user/assistant)
- Content (including tool uses and results)
- Line numbers for reference

## Error Handling

Both tools return errors as text content with `isError: true`:
- Invalid parameters (validation errors)
- File not found
- Date parsing errors
- Search failures

## Performance Notes

- **search** is fast (< 100ms typically)
- **read** can be slow for large conversations
  - Use `startLine`/`endLine` to paginate
  - Conversations can be 1000+ lines
- Vector search uses sqlite-vec with cached embeddings
- Text search uses SQLite FTS5 full-text index
