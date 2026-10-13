import { describe, it, expect } from 'vitest';
import path from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { parsePiConversation } from '../src/parsers/pi.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'pi-session.jsonl');

async function parseSession(entries: unknown[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-parser-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n'));
    return await parsePiConversation(file, 'test-project', '/archive/session.jsonl');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const systemMessage = {
  type: 'message',
  id: 'system-context',
  parentId: null,
  message: {
    role: 'system',
    content: 'Private system context',
    sections: { 'Private prompt section': 'Private section content', removed: null },
    toolsAdded: [{ name: 'private_tool', description: 'Private tool', parameters: {} }],
    toolsRemoved: [{ name: 'private_removed_tool' }],
  },
};

const assistantMessage = {
  type: 'message',
  timestamp: '2026-10-12T12:00:00.000Z',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Hidden reasoning' },
      { type: 'text', text: 'Normal reply' },
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'config.ts' } },
    ],
    model: 'test-model',
    provider: 'test-provider',
  },
};

describe('Pi parser', () => {
  it.each([
    ['string', 'String prompt', 'String prompt'],
    ['multimodal array', [
      { type: 'text', text: 'First part' },
      { type: 'image', data: 'synthetic-image', mimeType: 'image/png' },
      { type: 'text', text: 'Second part' },
    ], 'First part\nSecond part'],
    ['empty string', '', '(no text)'],
    ['empty array', [], '(no text)'],
    ['image-only array', [{ type: 'image', data: 'synthetic-image', mimeType: 'image/png' }], '(no text)'],
  ])('should parse %s user content and ignore system context', async (_label, content, expected) => {
    const exchanges = await parseSession([
      { type: 'session', version: 3, id: 'synthetic-session', cwd: '/tmp/test-project' },
      { type: 'thinking_level_change', thinkingLevel: 'high' },
      systemMessage,
      { type: 'message', message: { role: 'user', content } },
      systemMessage,
      assistantMessage,
      { type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'Tool output' }] } },
      systemMessage,
    ]);

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({
      userMessage: expected,
      assistantMessage: 'Normal reply',
      lineStart: 4,
      lineEnd: 6,
      source: 'pi',
      sessionId: 'synthetic-session',
      cwd: '/tmp/test-project',
      model: 'test-model',
      provider: 'test-provider',
      thinkingLevel: 'high',
      timestamp: assistantMessage.timestamp,
    });
    expect(exchanges[0].toolCalls).toEqual([expect.objectContaining({
      id: 'call-1',
      exchangeId: exchanges[0].id,
      toolName: 'read',
      toolInput: { path: 'config.ts' },
      isError: false,
    })]);
    expect(JSON.stringify(exchanges)).not.toContain('Private');
  });

  it('should ignore a system-only transcript', async () => {
    expect(await parseSession([systemMessage])).toEqual([]);
  });
  it('should parse user→assistant exchanges', async () => {
    const exchanges = await parsePiConversation(FIXTURE, 'myproject', FIXTURE);
    // Two exchanges: m1→(m2+m4), m5→(m6+m8)
    expect(exchanges.length).toBe(2);
  });

  it('should set source to pi', async () => {
    const exchanges = await parsePiConversation(FIXTURE, 'myproject', FIXTURE);
    for (const ex of exchanges) {
      expect(ex.source).toBe('pi');
    }
  });

  it('should capture user message text', async () => {
    const exchanges = await parsePiConversation(FIXTURE, 'myproject', FIXTURE);
    expect(exchanges[0].userMessage).toContain('project structure');
    expect(exchanges[1].userMessage).toContain('main.ts');
  });

  it('should accumulate assistant text across messages', async () => {
    const exchanges = await parsePiConversation(FIXTURE, 'myproject', FIXTURE);
    // First exchange: m2 has "I'll explore..." then m4 has the structure listing
    expect(exchanges[0].assistantMessage).toContain("explore the project");
    expect(exchanges[0].assistantMessage).toContain("Main entry point");
  });

  it('should extract tool calls from assistant content blocks', async () => {
    const exchanges = await parsePiConversation(FIXTURE, 'myproject', FIXTURE);
    expect(exchanges[0].toolCalls).toBeDefined();
    expect(exchanges[0].toolCalls!.length).toBe(1);
    expect(exchanges[0].toolCalls![0].toolName).toBe('bash');
  });

  it('should capture second exchange tool calls', async () => {
    const exchanges = await parsePiConversation(FIXTURE, 'myproject', FIXTURE);
    expect(exchanges[1].toolCalls).toBeDefined();
    expect(exchanges[1].toolCalls!.length).toBe(1);
    expect(exchanges[1].toolCalls![0].toolName).toBe('read');
  });

  it('should extract session metadata from the session line', async () => {
    const exchanges = await parsePiConversation(FIXTURE, 'myproject', FIXTURE);
    expect(exchanges[0].sessionId).toBe('test-pi-session-001');
    expect(exchanges[0].cwd).toBe('/Users/testuser/src/myproject');
  });

  it('should capture model and provider from assistant messages', async () => {
    const exchanges = await parsePiConversation(FIXTURE, 'myproject', FIXTURE);
    expect(exchanges[0].model).toBe('claude-sonnet-4-20250514');
    expect(exchanges[0].provider).toBe('anthropic');
  });

  it('should capture thinking level from metadata lines', async () => {
    const exchanges = await parsePiConversation(FIXTURE, 'myproject', FIXTURE);
    expect(exchanges[0].thinkingLevel).toBe('high');
  });

  it('should skip toolResult messages (not create separate exchanges)', async () => {
    const exchanges = await parsePiConversation(FIXTURE, 'myproject', FIXTURE);
    // toolResult lines don't create exchanges
    expect(exchanges.length).toBe(2);
  });

  it('should handle empty or missing file gracefully', async () => {
    const exchanges = await parsePiConversation('/nonexistent/file.jsonl', 'test', '/nonexistent');
    expect(exchanges).toEqual([]);
  });
});
