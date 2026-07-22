import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseOpenCodeConversation, OpenCodeSource } from '../src/parsers/opencode.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';

const FIXTURE_DB = path.join(__dirname, 'fixtures', 'opencode.db');

/**
 * Export a session from the fixture DB to a JSON file (mirrors what
 * OpenCodeSource.discoverConversations does with the live DB).
 */
function exportSession(dbPath: string, sessionId: string, outPath: string): void {
  const db = new Database(dbPath, { readonly: true });

  const session = db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId) as any;
  const project = db.prepare('SELECT id, worktree, name FROM project WHERE id = ?').get(session.project_id) as any;
  const messages = db.prepare(
    'SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created'
  ).all(sessionId) as any[];
  const messageIds = messages.map((m: any) => m.id);
  const placeholders = messageIds.map(() => '?').join(',');
  const parts = messageIds.length > 0
    ? db.prepare(
        `SELECT id, message_id, time_created, data FROM part WHERE message_id IN (${placeholders}) ORDER BY time_created`
      ).all(...messageIds) as any[]
    : [];

  db.close();

  fs.writeFileSync(outPath, JSON.stringify({ session, project, messages, parts }));
}

describe('OpenCode Parser', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'));
  const mainExport = path.join(tmpDir, 'ses_main001.json');
  const subExport = path.join(tmpDir, 'ses_sub001.json');
  const errExport = path.join(tmpDir, 'ses_err001.json');
  const emptyExport = path.join(tmpDir, 'ses_empty.json');

  beforeAll(() => {
    exportSession(FIXTURE_DB, 'ses_main001', mainExport);
    exportSession(FIXTURE_DB, 'ses_sub001', subExport);
    exportSession(FIXTURE_DB, 'ses_err001', errExport);
    // Empty session has no messages, export manually
    const db = new Database(FIXTURE_DB, { readonly: true });
    const session = db.prepare('SELECT * FROM session WHERE id = ?').get('ses_empty') as any;
    const project = db.prepare('SELECT id, worktree, name FROM project WHERE id = ?').get(session.project_id) as any;
    db.close();
    fs.writeFileSync(emptyExport, JSON.stringify({ session, project, messages: [], parts: [] }));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a multi-step session into exchanges', async () => {
    const exchanges = await parseOpenCodeConversation(mainExport, 'my-project', '/archive/ses_main001.json');

    expect(exchanges).toHaveLength(2);

    // First exchange: JWT auth with 2 assistant steps
    const ex1 = exchanges[0];
    expect(ex1.source).toBe('opencode');
    expect(ex1.userMessage).toBe('Add JWT authentication to the login endpoint');
    expect(ex1.assistantMessage).toContain("I'll start by reading the current auth setup.");
    expect(ex1.assistantMessage).toContain('RS256 signing');
    expect(ex1.model).toBe('anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(ex1.provider).toBe('amazon-bedrock');
    expect(ex1.cwd).toBe('/Users/test/src/my-project');
    expect(ex1.agentVersion).toBe('1.3.0');
    expect(ex1.sessionId).toBe('ses_main001');

    // Should have tool calls from both assistant steps
    expect(ex1.toolCalls).toBeDefined();
    expect(ex1.toolCalls!.length).toBe(2);
    expect(ex1.toolCalls![0].toolName).toBe('read');
    expect(ex1.toolCalls![1].toolName).toBe('edit');

    // Second exchange: unit tests, different model
    const ex2 = exchanges[1];
    expect(ex2.userMessage).toBe('Now add unit tests for the JWT auth');
    expect(ex2.model).toBe('gemini-3-pro-preview');
    expect(ex2.provider).toBe('google-vertex');
  });

  it('parses sub-session (explore subagent)', async () => {
    const exchanges = await parseOpenCodeConversation(subExport, 'my-project', '/archive/ses_sub001.json');

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].userMessage).toBe('Explore existing auth patterns in this codebase');
    expect(exchanges[0].assistantMessage).toContain('middleware-based auth pattern');
    expect(exchanges[0].sessionId).toBe('ses_sub001');
  });

  it('filters out errored assistant messages', async () => {
    const exchanges = await parseOpenCodeConversation(errExport, 'my-project', '/archive/ses_err001.json');

    expect(exchanges).toHaveLength(1);
    // Should only have the successful retry text
    expect(exchanges[0].assistantMessage).toContain('production deployment');
    expect(exchanges[0].assistantMessage).not.toContain('Not Found');
  });

  it('returns empty for session with no messages', async () => {
    const exchanges = await parseOpenCodeConversation(emptyExport, 'my-project', '/archive/ses_empty.json');
    expect(exchanges).toHaveLength(0);
  });

  it('returns empty for non-existent file', async () => {
    const exchanges = await parseOpenCodeConversation('/no/such/file.json', 'test', '/archive/test.json');
    expect(exchanges).toHaveLength(0);
  });

  it('generates stable exchange IDs from archivePath + message ID', async () => {
    const exchanges1 = await parseOpenCodeConversation(mainExport, 'my-project', '/archive/ses_main001.json');
    const exchanges2 = await parseOpenCodeConversation(mainExport, 'my-project', '/archive/ses_main001.json');

    expect(exchanges1[0].id).toBe(exchanges2[0].id);
    expect(exchanges1[1].id).toBe(exchanges2[1].id);

    // Different archivePath → different IDs
    const exchanges3 = await parseOpenCodeConversation(mainExport, 'my-project', '/other/archive/ses_main001.json');
    expect(exchanges3[0].id).not.toBe(exchanges1[0].id);
  });
});

describe('OpenCodeSource discovery', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-disc-'));
  const testDbPath = path.join(tmpDir, 'opencode.db');

  beforeAll(() => {
    // Copy fixture DB to tmp location
    fs.copyFileSync(FIXTURE_DB, testDbPath);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers sessions from the database', async () => {
    // Point to the test DB
    const origEnv = process.env.OPENCODE_DB;
    const origDataDir = process.env.OPENCODE_DATA_DIR;
    process.env.OPENCODE_DB = testDbPath;
    process.env.OPENCODE_DATA_DIR = tmpDir;

    try {
      const source = new OpenCodeSource();
      expect(source.name).toBe('opencode');
      expect(source.label).toBe('OpenCode');

      const conversations = await source.discoverConversations();

      // Should find 3 sessions (main, sub, err) — empty session has no user messages
      expect(conversations.length).toBe(3);

      // All should have project name derived from worktree
      for (const conv of conversations) {
        expect(conv.project).toBe('my-project');
        expect(fs.existsSync(conv.filePath)).toBe(true);
      }

      // Each exported file should be parseable
      for (const conv of conversations) {
        const exchanges = await source.parseConversation(conv.filePath, conv.project, conv.filePath);
        expect(exchanges.length).toBeGreaterThanOrEqual(1);
        for (const ex of exchanges) {
          expect(ex.source).toBe('opencode');
        }
      }
    } finally {
      if (origEnv !== undefined) process.env.OPENCODE_DB = origEnv;
      else delete process.env.OPENCODE_DB;
      if (origDataDir !== undefined) process.env.OPENCODE_DATA_DIR = origDataDir;
      else delete process.env.OPENCODE_DATA_DIR;
    }
  });

  it('returns empty when DB does not exist', async () => {
    const origEnv = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = '/nonexistent/opencode.db';

    try {
      const source = new OpenCodeSource();
      const conversations = await source.discoverConversations();
      expect(conversations).toHaveLength(0);
    } finally {
      if (origEnv !== undefined) process.env.OPENCODE_DB = origEnv;
      else delete process.env.OPENCODE_DB;
    }
  });
});
