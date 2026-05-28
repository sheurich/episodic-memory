#!/usr/bin/env node
/**
 * MCP Server for Episodic Memory.
 *
 * This server provides tools to search and explore indexed Claude Code and Codex conversations
 * using semantic search, text search, and conversation display capabilities.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  searchConversations,
  searchMultipleConcepts,
  formatResults,
  formatMultiConceptResults,
  SearchOptions,
} from './search.js';
import { formatConversationAsMarkdown } from './show.js';
import { VERSION } from './version.js';
import fs from 'fs';

// Zod Schemas for Input Validation

const SearchModeEnum = z.enum(['vector', 'text', 'both']);
const ResponseFormatEnum = z.enum(['markdown', 'json']);
const OptionalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
  .nullish()
  .transform((value) => value ?? undefined);
const OptionalStringSchema = z
  .string()
  .min(1)
  .nullish()
  .transform((value) => value ?? undefined);

const SearchInputSchema = z
  .object({
    query: z
      .string()
      .min(2, 'Query must be at least 2 characters')
      .describe('Search query for semantic and/or text search'),
    mode: SearchModeEnum.default('both').describe(
      'Search mode: "vector" for semantic similarity, "text" for exact matching, "both" for combined (default: "both").'
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of results to return (default: 10)'),
    after: OptionalDateSchema.describe('Only return conversations after this date (YYYY-MM-DD format)'),
    before: OptionalDateSchema.describe('Only return conversations before this date (YYYY-MM-DD format)'),
    project: OptionalStringSchema.describe('Filter by project name (exact match)'),
    session_id: OptionalStringSchema.describe('Filter by session ID (exact match)'),
    git_branch: OptionalStringSchema.describe('Filter by git branch name (exact match)'),
    response_format: ResponseFormatEnum.default('markdown').describe(
      'Output format: "markdown" for human-readable or "json" for machine-readable (default: "markdown")'
    ),
  })
  .strict();

const SearchMultiInputSchema = z
  .object({
    concepts: z
      .array(z.string().min(2))
      .min(2, 'Must provide at least 2 concepts for multi-concept search')
      .max(5, 'Cannot search more than 5 concepts at once')
      .describe('Concepts for multi-concept AND search'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of results to return (default: 10)'),
    after: OptionalDateSchema.describe('Only return conversations after this date (YYYY-MM-DD format)'),
    before: OptionalDateSchema.describe('Only return conversations before this date (YYYY-MM-DD format)'),
    project: OptionalStringSchema.describe('Filter by project name (exact match)'),
    session_id: OptionalStringSchema.describe('Filter by session ID (exact match)'),
    git_branch: OptionalStringSchema.describe('Filter by git branch name (exact match)'),
    response_format: ResponseFormatEnum.default('markdown').describe(
      'Output format: "markdown" for human-readable or "json" for machine-readable (default: "markdown")'
    ),
  })
  .strict();

type SearchInput = z.infer<typeof SearchInputSchema>;
type SearchMultiInput = z.infer<typeof SearchMultiInputSchema>;

const ShowConversationInputSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Path is required')
      .describe('Absolute path to the JSONL conversation file to display'),
    startLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Starting line number (1-indexed, inclusive). Omit to start from beginning.'),
    endLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Ending line number (1-indexed, inclusive). Omit to read to end.'),
  })
  .strict();

type ShowConversationInput = z.infer<typeof ShowConversationInputSchema>;

const OptionalDateInputJsonSchema = {
  oneOf: [
    { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    { type: 'null' },
  ],
};

const optionalStringInputJsonSchema = (description: string) => ({
  oneOf: [
    { type: 'string', minLength: 1 },
    { type: 'null' },
  ],
  description,
});

// Error Handling Utility

function handleError(error: unknown): string {
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

// Create MCP Server

const server = new Server(
  {
    name: 'episodic-memory',
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register Tools

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search',
        description: `Gives you memory across sessions. You don't automatically remember past Claude Code and Codex conversations - this tool restores context by searching them. Use BEFORE every task to recover decisions, solutions, and avoid reinventing work. Returns ranked results with project, date, snippets, and file paths.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 2 },
            mode: { type: 'string', enum: ['vector', 'text', 'both'], default: 'both' },
            limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
            after: OptionalDateInputJsonSchema,
            before: OptionalDateInputJsonSchema,
            project: optionalStringInputJsonSchema('Filter by project name (exact match)'),
            session_id: optionalStringInputJsonSchema('Filter by session ID (exact match)'),
            git_branch: optionalStringInputJsonSchema('Filter by git branch name (exact match)'),
            response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Search Episodic Memory',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'search_multi',
        description: `Search for memories that match multiple concepts at once. Use when one concept is too broad and you need precise AND matching across 2-5 concepts. Returns ranked results with project, date, snippets, and file paths.`,
        inputSchema: {
          type: 'object',
          properties: {
            concepts: { type: 'array', items: { type: 'string', minLength: 2 }, minItems: 2, maxItems: 5 },
            limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
            after: OptionalDateInputJsonSchema,
            before: OptionalDateInputJsonSchema,
            project: optionalStringInputJsonSchema('Filter by project name (exact match)'),
            session_id: optionalStringInputJsonSchema('Filter by session ID (exact match)'),
            git_branch: optionalStringInputJsonSchema('Filter by git branch name (exact match)'),
            response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' },
          },
          required: ['concepts'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Search Episodic Memory by Multiple Concepts',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'read',
        description: `Read full conversations to extract detailed context after finding relevant results with search. Essential for understanding the complete rationale, evolution, and gotchas behind past decisions. Use startLine/endLine pagination for large conversations to avoid context bloat (line numbers are 1-indexed).`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1 },
            startLine: { type: 'number', minimum: 1 },
            endLine: { type: 'number', minimum: 1 },
          },
          required: ['path'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Read Full Conversation',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  };
});

// Handle Tool Calls

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (name === 'search') {
      const params = SearchInputSchema.parse(args);
      const options: SearchOptions = {
        mode: params.mode,
        limit: params.limit,
        after: params.after,
        before: params.before,
        project: params.project,
        session_id: params.session_id,
        git_branch: params.git_branch,
      };

      const results = await searchConversations(params.query, options);
      const resultText = params.response_format === 'json'
        ? JSON.stringify(
            {
              results: results.map((r) => ({
                exchange: r.exchange,
                similarity: r.similarity,
                snippet: r.snippet,
              })),
              count: results.length,
              mode: params.mode,
            },
            null,
            2
          )
        : await formatResults(results);

      return {
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
      };
    }

    if (name === 'search_multi') {
      const params: SearchMultiInput = SearchMultiInputSchema.parse(args);
      const options = {
        limit: params.limit,
        after: params.after,
        before: params.before,
        project: params.project,
        session_id: params.session_id,
        git_branch: params.git_branch,
      };

      const results = await searchMultipleConcepts(params.concepts, options);
      const resultText = params.response_format === 'json'
        ? JSON.stringify(
            {
              results,
              count: results.length,
              concepts: params.concepts,
            },
            null,
            2
          )
        : await formatMultiConceptResults(results, params.concepts);

      return {
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
      };
    }

    if (name === 'read') {
      const params = ShowConversationInputSchema.parse(args);

      // Verify file exists
      if (!fs.existsSync(params.path)) {
        throw new Error(`File not found: ${params.path}`);
      }

      // Read and format conversation with optional line range
      const jsonlContent = fs.readFileSync(params.path, 'utf-8');
      const markdownContent = formatConversationAsMarkdown(
        jsonlContent,
        params.startLine,
        params.endLine
      );

      return {
        content: [
          {
            type: 'text',
            text: markdownContent,
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    // Return errors within the result (not as protocol errors)
    return {
      content: [
        {
          type: 'text',
          text: handleError(error),
        },
      ],
      isError: true,
    };
  }
});

// Main Function

async function main() {
  console.error('Episodic Memory MCP server running via stdio');

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run the Server

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
