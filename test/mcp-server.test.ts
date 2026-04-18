import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../dist/mcp-server.js', import.meta.url));

let client: Client;
let transport: StdioClientTransport;

type ToolContent = { type: string; text?: string };

function getTextContent(content: ToolContent[]): string {
  const textItem = content.find((item) => item.type === 'text' && typeof item.text === 'string');
  expect(textItem?.text).toBeTruthy();
  return textItem!.text!;
}

beforeAll(async () => {
  client = new Client({ name: 'episodic-memory-test', version: '1.0.0' }, { capabilities: {} });
  transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    stderr: 'pipe',
  });
  await client.connect(transport);
});

afterAll(async () => {
  await transport.close();
});

describe('MCP search tools', () => {
  it('advertises separate single and multi-concept search tools', async () => {
    const tools = await client.listTools();
    const searchTool = tools.tools.find((tool) => tool.name === 'search');
    const searchMultiTool = tools.tools.find((tool) => tool.name === 'search_multi');

    expect(searchTool).toBeDefined();
    expect(searchMultiTool).toBeDefined();
    expect(searchTool?.inputSchema?.properties?.query).toMatchObject({
      type: 'string',
      minLength: 2,
    });
    expect(searchTool?.inputSchema?.properties).not.toHaveProperty('concepts');
    expect(searchMultiTool?.inputSchema?.properties?.concepts).toMatchObject({
      type: 'array',
      minItems: 2,
      maxItems: 5,
    });
    expect(searchMultiTool?.inputSchema?.properties).not.toHaveProperty('query');
  });

  it('accepts single-concept searches through search', async () => {
    const result = await client.callTool({
      name: 'search',
      arguments: {
        query: 'cheap neutrality',
        limit: 1,
        after: null,
        before: null,
        response_format: 'json',
      },
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(getTextContent(result.content as ToolContent[]));
    expect(payload).toMatchObject({
      count: expect.any(Number),
      results: expect.any(Array),
      mode: 'both',
    });
  });

  it('accepts multi-concept searches through search_multi', async () => {
    const result = await client.callTool({
      name: 'search_multi',
      arguments: {
        concepts: ['xyzabc123', 'qwerty789'],
        limit: 1,
        after: null,
        before: null,
        response_format: 'json',
      },
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(getTextContent(result.content as ToolContent[]));
    expect(payload).toMatchObject({
      count: expect.any(Number),
      results: expect.any(Array),
      concepts: ['xyzabc123', 'qwerty789'],
    });
  });
});
