---
name: remembering-conversations
description: Use when user asks 'how should I...' or 'what's the best approach...' after exploring code, OR when you've tried to solve something and are stuck, OR for unfamiliar workflows, OR when user references past work. Searches conversation history.
---

# Remembering Conversations

**Core principle:** Search before reinventing. Searching costs nothing; reinventing or repeating mistakes costs everything.

## Dispatch a Search Subagent

**YOU MUST dispatch a search subagent for any historical search.**

Announce: "Searching episodic memory for [topic]."

Delegate to the `search-conversations` agent with a task like:

> Search past conversations for [topic]. Focus on [what you're looking for — decisions, patterns, gotchas, code examples].

The agent will:
1. Search with the `search` tool on the `episodic-memory` MCP server
2. Read the top 2-5 results with the `read` tool
3. Synthesize findings (200-1000 words)
4. Return actionable insights + sources

**Saves 50-100x context vs. loading raw conversations.**

## When to Use

Search memory once you understand what you're being asked. Not before.

**After understanding the task:**
- User asks "how should I..." or "what's the best approach..."
- You've explored current codebase and need to make architectural decisions
- User asks for implementation approach after describing what they want

**When you're stuck:**
- You've investigated a problem and can't find the solution
- Facing a complex problem without obvious solution in current code
- Need to follow an unfamiliar workflow or process

**When historical signals are present:**
- User says "last time", "before", "we discussed", "you implemented"
- User asks "why did we...", "what was the reason..."
- User says "do you remember...", "what do we know about..."

**Don't search first:**
- For current codebase structure (use Grep/Read to explore first)
- For info in current conversation
- Before understanding what you're being asked to do

## Direct Tool Access (Discouraged)

Calling MCP tools directly wastes your context window. Always dispatch the
subagent instead. See MCP-TOOLS.md for the tool API reference if needed.
