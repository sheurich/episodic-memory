import { describe, it, expect } from 'vitest';
import path from 'path';
import { parsePiConversation } from '../src/parsers/pi.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'pi-session.jsonl');

describe('Pi parser', () => {
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
