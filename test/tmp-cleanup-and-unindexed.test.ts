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
  it('reports a malformed-JSON archive with a real summary and no rows instead of passing silently', async () => {
    const project = path.join(archiveDir, 'project');
    fs.mkdirSync(project, { recursive: true });
    const conv = path.join(project, 'malformed.jsonl');
    fs.writeFileSync(conv, '{not json\n{"also": broken\n');
    fs.writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'A real summary');

    const issues = await verifyIndex();
    expect(issues.corrupted.map(c => c.path)).toEqual([conv]);
    expect(issues.unindexed).toEqual([]);
  });

  it('routes a flat archive/pi file whose Pi session header exceeds 64 KiB to the Pi parser', async () => {
    const project = path.join(archiveDir, 'pi', 'big-header-project');
    fs.mkdirSync(project, { recursive: true });
    const conv = path.join(project, 'session.jsonl');
    fs.writeFileSync(conv, [
      line({ type: 'session', id: 'pi-big-header', cwd: '/work/big', padding: 'x'.repeat(80 * 1024) }),
      line({ type: 'message', timestamp: '2026-10-12T12:00:00.000Z', message: { role: 'user', content: 'Pi question' } }),
      line({ type: 'message', timestamp: '2026-10-12T12:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Pi answer' }] } }),
    ].join('\n') + '\n');
    fs.writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'An existing summary');

    const before = await verifyIndex();
    expect(before.unindexed.map(u => u.path)).toEqual([conv]);
    await repairIndex(before);

    const db = new Database(process.env.TEST_DB_PATH!);
    try {
      const row = db.prepare('SELECT source, project, session_id AS sessionId, cwd FROM exchanges').get() as Record<string, string>;
      expect(row).toEqual({ source: 'pi', project: 'big-header-project', sessionId: 'pi-big-header', cwd: '/work/big' });
    } finally {
      db.close();
    }
  });

  it('removes the stale row and vector when an outdated archive exchange becomes oversize', async () => {
    const project = path.join(archiveDir, 'project');
    fs.mkdirSync(project, { recursive: true });
    const conv = path.join(project, 'grows.jsonl');
    const turn = (userText: string) => [
      line({ type: 'user', uuid: 'u1', message: { role: 'user', content: userText }, timestamp: '2024-01-01T00:00:00Z' }),
      line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'ok' }, timestamp: '2024-01-01T00:00:01Z' }),
    ].join('\n') + '\n';
    fs.writeFileSync(conv, turn('small question'));
    fs.writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'An existing summary');

    await repairIndex(await verifyIndex());
    const count = (table: string) => {
      const db = new Database(process.env.TEST_DB_PATH!);
      try { return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; } finally { db.close(); }
    };
    // vec_exchanges needs the sqlite-vec extension, so count it via initDatabase.
    const { initDatabase } = await import('../src/db.js');
    const vecCount = () => {
      const db = initDatabase();
      try { return (db.prepare('SELECT COUNT(*) AS n FROM vec_exchanges').get() as { n: number }).n; } finally { db.close(); }
    };
    expect(count('exchanges')).toBe(1);
    expect(vecCount()).toBe(1);

    // Same exchange id (same first user uuid), but its content now exceeds the cap.
    fs.writeFileSync(conv, turn('x'.repeat(2048)));
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(conv, future, future);

    process.env.EPISODIC_MEMORY_MAX_MESSAGE_BYTES = '1024';
    try {
      const before = await verifyIndex();
      expect(before.outdated.map(o => o.path)).toEqual([conv]);
      await repairIndex(before);
      expect(count('exchanges')).toBe(0);
      expect(vecCount()).toBe(0);
      expect(await verifyIndex()).toEqual({ missing: [], orphaned: [], outdated: [], corrupted: [], unindexed: [] });
    } finally {
      delete process.env.EPISODIC_MEMORY_MAX_MESSAGE_BYTES;
    }
  });

  const ompHeader = { type: 'session', id: 'omp-session', cwd: '/fixture/project', timestamp: '2026-01-01T00:00:00Z' };
  function ompMessage(id: string, parentId: string | null, role: 'user' | 'assistant', text: string) {
    return { type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00Z', message: { role, content: [{ type: 'text', text }] } };
  }
  const jsonlOf = (lines: object[]) => lines.map(line).join('\n') + '\n';

  async function withIndexDb<T>(fn: (db: import('better-sqlite3').Database) => T): Promise<T> {
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try { return fn(db); } finally { db.close(); }
  }
  const indexSnapshot = () => withIndexDb(db => ({
    rows: db.prepare('SELECT * FROM exchanges ORDER BY id').all(),
    vectors: db.prepare('SELECT id, embedding FROM vec_exchanges ORDER BY id').all(),
  }));

  it('repairs a valid OMP archive that now parses to zero exchanges by deleting stale rows, without reporting it corrupted', async () => {
    const project = path.join(archiveDir, 'project');
    fs.mkdirSync(project, { recursive: true });
    const conv = path.join(project, 'omp.jsonl');
    fs.writeFileSync(conv, jsonlOf([ompHeader, ompMessage('u1', null, 'user', 'Question'), ompMessage('a1', 'u1', 'assistant', 'Abandoned answer')]));
    fs.writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'An existing summary');
    await repairIndex(await verifyIndex());
    expect((await indexSnapshot()).rows).toHaveLength(1);
    expect((await indexSnapshot()).vectors).toHaveLength(1);

    // A new unanswered root abandons the old active branch: zero exchanges.
    fs.appendFileSync(conv, jsonlOf([ompMessage('new-root', null, 'user', 'New root question')]));
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(conv, future, future);

    const before = await verifyIndex();
    expect(before.outdated.map(o => o.path)).toEqual([conv]);
    expect(before.corrupted).toEqual([]);
    expect(before.unindexed).toEqual([]);

    await repairIndex(before);

    const after = await indexSnapshot();
    expect(after.rows).toEqual([]);
    expect(after.vectors).toEqual([]);
    expect(await verifyIndex()).toEqual({ missing: [], orphaned: [], outdated: [], corrupted: [], unindexed: [] });
  });

  it('reports a valid header followed by damaged message lines as corrupted and never deletes the existing rows and vectors', async () => {
    const project = path.join(archiveDir, 'project');
    fs.mkdirSync(project, { recursive: true });
    const conv = path.join(project, 'omp-damaged.jsonl');
    fs.writeFileSync(conv, jsonlOf([ompHeader, ompMessage('u1', null, 'user', 'Question'), ompMessage('a1', 'u1', 'assistant', 'Answer')]));
    fs.writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'An existing summary');
    await repairIndex(await verifyIndex());
    const good = await indexSnapshot();
    expect(good.rows).toHaveLength(1);
    expect(good.vectors).toHaveLength(1);

    // The header survives, but every message line is damaged.
    fs.writeFileSync(conv, `${line(ompHeader)}\n{"type":"message","id":"u1","parentId":null,"mess\n{not json\n`);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(conv, future, future);

    const issues = await verifyIndex();
    expect(issues.corrupted.map(c => c.path)).toEqual([conv]);
    expect(issues.outdated).toEqual([]);
    expect(issues.unindexed).toEqual([]);

    // Even when handed the archive as outdated, repair keeps the last good index.
    await repairIndex({
      missing: [], orphaned: [], corrupted: [], unindexed: [],
      outdated: [{ path: conv, fileTime: future.getTime(), dbTime: 0 }],
    });
    expect(await indexSnapshot()).toEqual(good);
  });

  it('keeps the corrupted diagnostic for an archive with no valid JSONL record, even when blank lines surround it', async () => {
    const project = path.join(archiveDir, 'project');
    fs.mkdirSync(project, { recursive: true });
    const conv = path.join(project, 'garbage.jsonl');
    fs.writeFileSync(conv, '\n{not json\n\n');
    fs.writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'A real summary');
    const issues = await verifyIndex();
    expect(issues.corrupted.map(c => c.path)).toEqual([conv]);
    expect(issues.unindexed).toEqual([]);
  });

  it('leaves existing rows and vectors untouched when an embedding fails partway through repairing an outdated archive', async () => {
    const project = path.join(archiveDir, 'project');
    fs.mkdirSync(project, { recursive: true });
    const conv = path.join(project, 'atomic.jsonl');
    const turn = (id: string, ts: string) => [
      line({ type: 'user', uuid: `${id}-u`, message: { role: 'user', content: `question ${id}` }, timestamp: ts }),
      line({ type: 'assistant', uuid: `${id}-a`, message: { role: 'assistant', content: `answer ${id}` }, timestamp: ts }),
    ].join('\n') + '\n';
    fs.writeFileSync(conv, turn('old', '2024-01-01T00:00:00Z'));
    fs.writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'An existing summary');
    await repairIndex(await verifyIndex());
    const before = await indexSnapshot();
    expect(before.rows).toHaveLength(1);

    // The old exchange disappears and two new ones appear; the second embedding fails.
    fs.writeFileSync(conv, turn('new1', '2024-01-02T00:00:00Z') + turn('new2', '2024-01-02T00:01:00Z'));
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(conv, future, future);
    const issues = await verifyIndex();
    expect(issues.outdated.map(o => o.path)).toEqual([conv]);

    vi.mocked(generateExchangeEmbedding)
      .mockResolvedValueOnce(new Array(384).fill(0.2))
      .mockRejectedValueOnce(new Error('fixture embedding failed'));
    await repairIndex(issues);

    expect(await indexSnapshot()).toEqual(before);

    // A later successful repair replaces the archive's rows.
    await repairIndex(await verifyIndex());
    const healed = await indexSnapshot();
    expect(healed.rows).toHaveLength(2);
    expect(healed.vectors).toHaveLength(2);
    expect((healed.rows as Array<{ assistant_message: string }>).map(r => r.assistant_message).sort()).toEqual(['answer new1', 'answer new2']);
  });

  afterAll(() => restoreConsole());
});
