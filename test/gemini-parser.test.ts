import { describe, it, expect } from 'vitest';
import path from 'path';
import { parseGeminiConversation } from '../src/parsers/gemini.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'gemini-session.json');

describe('Gemini parser', () => {
  it('should parse user→gemini exchanges', async () => {
    const exchanges = await parseGeminiConversation(FIXTURE, 'test-project', FIXTURE);
    // Two user→gemini pairs: msg-001→(msg-002+msg-003), msg-004→msg-005
    expect(exchanges.length).toBe(2);
  });

  it('should set source to gemini', async () => {
    const exchanges = await parseGeminiConversation(FIXTURE, 'test-project', FIXTURE);
    for (const ex of exchanges) {
      expect(ex.source).toBe('gemini');
    }
  });

  it('should capture user message content', async () => {
    const exchanges = await parseGeminiConversation(FIXTURE, 'test-project', FIXTURE);
    expect(exchanges[0].userMessage).toContain('TLS certificates');
    expect(exchanges[1].userMessage).toContain('mutual TLS');
  });

  it('should accumulate consecutive gemini messages into one exchange', async () => {
    const exchanges = await parseGeminiConversation(FIXTURE, 'test-project', FIXTURE);
    // msg-002 (tool-only) + msg-003 (text) should merge into one exchange
    expect(exchanges[0].assistantMessage).toContain('cert_path');
  });

  it('should extract tool calls', async () => {
    const exchanges = await parseGeminiConversation(FIXTURE, 'test-project', FIXTURE);
    expect(exchanges[0].toolCalls).toBeDefined();
    expect(exchanges[0].toolCalls!.length).toBe(1);
    expect(exchanges[0].toolCalls![0].toolName).toBe('read_file');
  });

  it('should set sessionId from the session object', async () => {
    const exchanges = await parseGeminiConversation(FIXTURE, 'test-project', FIXTURE);
    expect(exchanges[0].sessionId).toBe('test-gemini-session-001');
  });

  it('should skip info and error messages', async () => {
    const exchanges = await parseGeminiConversation(FIXTURE, 'test-project', FIXTURE);
    // Only 2 exchanges, info/error messages ignored
    expect(exchanges.length).toBe(2);
    const allText = exchanges.map(e => e.assistantMessage).join(' ');
    expect(allText).not.toContain('Rate limit exceeded');
    expect(allText).not.toContain('Session context updated');
  });

  it('should assign correct line ranges (1-indexed message indices)', async () => {
    const exchanges = await parseGeminiConversation(FIXTURE, 'test-project', FIXTURE);
    // First exchange: user at index 0 (line 1), last gemini at index 2 (line 3)
    expect(exchanges[0].lineStart).toBe(1);
    expect(exchanges[0].lineEnd).toBe(3);
    // Second exchange: user at index 3 (line 4), gemini at index 4 (line 5)
    expect(exchanges[1].lineStart).toBe(4);
    expect(exchanges[1].lineEnd).toBe(5);
  });

  it('should handle empty or missing file gracefully', async () => {
    const exchanges = await parseGeminiConversation('/nonexistent/file.json', 'test', '/nonexistent');
    expect(exchanges).toEqual([]);
  });
});
