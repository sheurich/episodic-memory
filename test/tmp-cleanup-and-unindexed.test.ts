import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { syncConversations } from '../src/sync.js';
import { verifyIndex, repairIndex } from '../src/verify.js';
import { summarizeConversation } from '../src/summarizer.js';
import Database from 'better-sqlite3';
import { generateExchangeEmbedding } from '../src/embeddings.js';
import { suppressConsole } from './test-utils.js';

vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => {}),
  generateExchangeEmbedding: vi.fn(async () => new Array(384).fill(0.1))
}));

vi.mock('../src/summarizer.js', () => ({
  summarizeConversation: vi.fn(async () => 'Mock summary')
}));

const restoreConsole = suppressConsole();

function line(obj: object): string {
  return JSON.stringify(obj);
}

function toolUseConversation(extraTurns = 0): string {
  const lines = [
    line({ type: 'user', message: { role: 'user', content: 'List the files' }, timestamp: '2024-01-01T00:00:00Z' }),
    line({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Listing.' },
          { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } } // no id: hashed fallback
        ]
      },
      timestamp: '2024-01-01T00:00:01Z'
    })
  ];
  for (let i = 0; i < extraTurns; i++) {
    lines.push(line({ type: 'user', message: { role: 'user', content: `more ${i}` }, timestamp: `2024-01-01T00:01:0${i}Z` }));
    lines.push(line({ type: 'assistant', message: { role: 'assistant', content: `done ${i}` }, timestamp: `2024-01-01T00:02:0${i}Z` }));
  }
  return lines.join('\n') + '\n';
}

describe('no orphan .tmp copies, unindexed conversations', () => {
  let testDir: string;
  let archiveDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episodic-memory-fixes-test-'));
    archiveDir = path.join(testDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, 'projects'), { recursive: true });
    process.env.TEST_PROJECTS_DIR = path.join(testDir, 'projects');
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.TEST_DB_PATH = path.join(testDir, 'db.sqlite');
    vi.mocked(summarizeConversation).mockClear();
    vi.mocked(generateExchangeEmbedding).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TEST_PROJECTS_DIR;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('leaves no .tmp copy behind when the rename onto the archive copy fails', async () => {
    const source = path.join(testDir, 'source', 'project');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'conv.jsonl'), toolUseConversation());
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    });

    const result = await syncConversations(path.join(testDir, 'source'), archiveDir, { skipIndex: true, skipSummaries: true });

    expect(rename).toHaveBeenCalled();
    expect(result.copied).toBe(1);
    const files = fs.readdirSync(path.join(archiveDir, 'project'));
    expect(files.filter(f => /\.tmp\.\d+$/.test(f))).toEqual([]);
    expect(fs.readFileSync(path.join(archiveDir, 'project', 'conv.jsonl'), 'utf-8')).toBe(toolUseConversation());
  });

  it('reports an archived conversation with a summary but no rows as unindexed, and repair indexes it without summarizing', async () => {
    const project = path.join(archiveDir, 'project');
    fs.mkdirSync(project, { recursive: true });
    const conv = path.join(project, 'conv.jsonl');
    fs.writeFileSync(conv, toolUseConversation());
    fs.writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'An existing summary');
    // An empty summary is the permanent-skip sentinel: never reported as unindexed.
    fs.writeFileSync(path.join(project, 'empty.jsonl'), line({ type: 'summary', summary: 'x' }) + '\n');
    fs.writeFileSync(path.join(project, 'empty-summary.txt'), '');

    const before = await verifyIndex();
    expect(before.unindexed.map(u => u.path)).toEqual([conv]);
    expect(before.missing).toEqual([]);

    await repairIndex(before);

    expect(summarizeConversation).not.toHaveBeenCalled();
    expect(fs.readFileSync(conv.replace('.jsonl', '-summary.txt'), 'utf-8')).toBe('An existing summary');
    const after = await verifyIndex();
    expect(after.unindexed).toEqual([]);
  });

  it('does not schedule or index an opted-out archive that has a summary and zero rows', async () => {
    const project = path.join(archiveDir, 'project');
    fs.mkdirSync(project, { recursive: true });
    const conv = path.join(project, 'private.jsonl');
    fs.writeFileSync(
      conv,
      toolUseConversation() +
        line({
          type: 'user',
          message: { role: 'user', content: '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>' },
          timestamp: '2024-01-01T00:03:00Z'
        }) + '\n'
    );
    fs.writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'An existing summary');

    const before = await verifyIndex();
    expect(before.unindexed).toEqual([]);

    // Repair must also refuse a stale/forged issue list that names the file.
    await repairIndex({ missing: [], orphaned: [], outdated: [], corrupted: [], unindexed: [{ path: conv }] });
    expect(generateExchangeEmbedding).not.toHaveBeenCalled();
    expect(summarizeConversation).not.toHaveBeenCalled();
    const db = new Database(process.env.TEST_DB_PATH!);
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM exchanges').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('repairs a Pi archive with the Pi parser and archive project component', async () => {
    const project = path.join(archiveDir, 'pi', 'my-project');
    fs.mkdirSync(project, { recursive: true });
    const conv = path.join(project, 'session.jsonl');
    fs.writeFileSync(conv, [
      line({ type: 'session', id: 'pi-repair-session', cwd: '/work/my-project' }),
      line({ type: 'model_change', provider: 'test-provider', modelId: 'test-model' }),
      line({ type: 'message', timestamp: '2026-10-12T12:00:00.000Z', message: { role: 'user', content: 'Pi question' } }),
      line({ type: 'message', timestamp: '2026-10-12T12:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Pi answer' }] } }),
    ].join('\n') + '\n');
    fs.writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'An existing summary');

    const before = await verifyIndex();
    expect(before.unindexed.map(u => u.path)).toEqual([conv]);
    expect(before.corrupted).toEqual([]);

    await repairIndex(before);

    const db = new Database(process.env.TEST_DB_PATH!);
    try {
      const row = db.prepare('SELECT source, project, session_id AS sessionId, cwd, model, model_provider AS modelProvider, archive_path AS archivePath FROM exchanges').get() as Record<string, string>;
      expect(row).toEqual({
        source: 'pi',
        project: 'my-project',
        sessionId: 'pi-repair-session',
        cwd: '/work/my-project',
        model: 'test-model',
        modelProvider: 'test-provider',
        archivePath: conv,
      });
    } finally {
      db.close();
    }
  });

  it('does not report an intentionally opted-out archive without a summary as missing or unindexed', async () => {
    const project = path.join(archiveDir, 'project');
    fs.mkdirSync(project, { recursive: true });
    const conv = path.join(project, 'opted-out-no-summary.jsonl');
    fs.writeFileSync(
      conv,
      toolUseConversation() +
        line({
          type: 'user',
          message: { role: 'user', content: '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>' },
          timestamp: '2024-01-01T00:03:00Z'
        }) + '\n'
    );

    const issues = await verifyIndex();
    expect(issues).toEqual({ missing: [], orphaned: [], outdated: [], corrupted: [], unindexed: [] });
  });

  it('routes a nested legacy Claude archive under archive/pi/<session>/subagents/ to the generic parser', async () => {
    const subagents = path.join(archiveDir, 'pi', 'session-uuid', 'subagents');
    fs.mkdirSync(subagents, { recursive: true });
    const conv = path.join(subagents, 'agent-abc123.jsonl');
    fs.writeFileSync(conv, toolUseConversation());
    fs.writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'An existing summary');

    const before = await verifyIndex();
    expect(before.unindexed.map(u => u.path)).toEqual([conv]);
    expect(before.corrupted).toEqual([]);

    await repairIndex(before);

    const db = new Database(process.env.TEST_DB_PATH!);
    try {
      const row = db.prepare('SELECT source, project, archive_path AS archivePath FROM exchanges').get() as Record<string, string>;
      expect(row.source).not.toBe('pi');
      expect(row.project).toBe('pi');
      expect(row.archivePath).toBe(conv);
    } finally {
      db.close();
    }
    expect((await verifyIndex()).unindexed).toEqual([]);
  });

  it('does not report or index an archive whose exchanges are all oversize', async () => {
    const project = path.join(archiveDir, 'project');
    fs.mkdirSync(project, { recursive: true });
    const conv = path.join(project, 'all-oversize.jsonl');
    fs.writeFileSync(conv, [
      line({ type: 'user', message: { role: 'user', content: 'x'.repeat(2048) }, timestamp: '2024-01-01T00:00:00Z' }),
      line({ type: 'assistant', message: { role: 'assistant', content: 'ok' }, timestamp: '2024-01-01T00:00:01Z' }),
    ].join('\n') + '\n');
    fs.writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'An existing summary');

    process.env.EPISODIC_MEMORY_MAX_MESSAGE_BYTES = '1024';
    try {
      const issues = await verifyIndex();
      expect(issues.unindexed).toEqual([]);

      // Repair must also refuse a stale/forged issue list that names the file.
      await repairIndex({ missing: [], orphaned: [], outdated: [], corrupted: [], unindexed: [{ path: conv }] });
    } finally {
      delete process.env.EPISODIC_MEMORY_MAX_MESSAGE_BYTES;
    }
    expect(generateExchangeEmbedding).not.toHaveBeenCalled();
    const db = new Database(process.env.TEST_DB_PATH!);
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM exchanges').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });
  afterAll(() => restoreConsole());
});
