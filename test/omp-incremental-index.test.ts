import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type Database from 'better-sqlite3';

const { embed, query } = vi.hoisted(() => ({ embed: vi.fn(), query: vi.fn() }));
vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => {}),
  generateExchangeEmbedding: embed,
  generateQueryEmbedding: vi.fn(async () => new Array(384).fill(0)),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query }));

import { indexUnprocessed } from '../src/indexer.js';
import { initDatabase, insertExchange } from '../src/db.js';
import { parseConversation } from '../src/parser.js';
import { searchConversations } from '../src/search.js';

const timestamp = '2026-01-01T00:00:00Z';
const header = { type: 'session', id: 'omp-session', cwd: '/fixture/project-a', timestamp };
function message(id: string, parentId: string | null, role: 'user' | 'assistant', text: string) {
  return { type: 'message', id, parentId, timestamp, message: { role, content: [{ type: 'text', text }] } };
}
const user = message('u1', null, 'user', 'Which answer is active?');
const answerA = message('a1', 'u1', 'assistant', 'abandoned-answer-A');
const answerB = message('b1', 'u1', 'assistant', 'replacement-answer-B');
function jsonl(lines: unknown[]): string {
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

describe('OMP active-path incremental indexing (real parser and SQLite)', () => {
  let root: string;
  let source: string;
  let archive: string;
  let db: Database.Database;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'em-omp-index-'));
    const projects = join(root, 'projects');
    const archives = join(root, 'archive');
    mkdirSync(join(projects, 'project-a'), { recursive: true });
    source = join(projects, 'project-a', 'session.jsonl');
    archive = join(archives, 'project-a', 'session.jsonl');
    vi.stubEnv('TEST_PROJECTS_DIR', projects);
    vi.stubEnv('TEST_ARCHIVE_DIR', archives);
    vi.stubEnv('TEST_DB_PATH', join(root, 'index.sqlite'));
    vi.stubEnv('EPISODIC_MEMORY_DB_PATH', '');
    vi.stubEnv('EPISODIC_MEMORY_CONFIG_DIR', join(root, 'config'));
    vi.stubEnv('EPISODIC_MEMORY_MAX_MESSAGE_BYTES', '307200');
    vi.stubEnv('CONVERSATION_SEARCH_EXCLUDE_PROJECTS', '');
    embed.mockReset().mockResolvedValue(new Array(384).fill(0.125));
    query.mockReset().mockImplementation(() => { throw new Error('Unexpected SDK call'); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Make a redundant insert visible in row snapshots, even on a fast rerun.
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    db = initDatabase();
    writeFileSync(source, jsonl([header, user, answerA]));
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const index = () => indexUnprocessed(1, true); // noSummaries / skipSummaries
  function rows() {
    return db.prepare('SELECT * FROM exchanges ORDER BY id').all() as Array<{
      id: string; archive_path: string; harness: string; assistant_message: string;
      line_start: number; line_end: number; last_indexed: number;
    }>;
  }
  function snapshot() {
    return {
      rows: rows(),
      vectors: db.prepare('SELECT id, embedding FROM vec_exchanges ORDER BY id').all(),
      tools: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
    };
  }
  function ompRows() {
    return rows().filter(row => row.archive_path === archive && row.harness === 'omp');
  }
  function seedTool(exchangeId: string) {
    // The current OMP parser extracts only text. Seed a dependent row to test
    // cleanup of existing tool_calls without mocking or changing the parser.
    db.prepare(`INSERT INTO tool_calls (id, exchange_id, tool_name, timestamp)
      VALUES (?, ?, 'fixture-tool', ?)`).run(`tool-${exchangeId}`, exchangeId, timestamp);
  }
  function expectConsistent() {
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare('SELECT id FROM vec_exchanges ORDER BY id').all())
      .toEqual(rows().map(({ id }) => ({ id })));
  }

  it('replaces A (lines 2–3) with B (2–4), isolates archives/harnesses, and makes the third run a no-op', async () => {
    const otherSource = join(root, 'projects', 'project-a', 'other.jsonl');
    writeFileSync(otherSource, jsonl([header, user, message('other', 'u1', 'assistant', 'untouched OMP answer')]));
    const claudeSource = join(root, 'projects', 'project-a', 'claude.jsonl');
    const claudeTurn = (seq: number) => jsonl([
      { type: 'user', uuid: `cu${seq}`, sessionId: 'claude-session', timestamp,
        message: { role: 'user', content: `Claude question ${seq}` } },
      { type: 'assistant', uuid: `ca${seq}`, parentUuid: `cu${seq}`, sessionId: 'claude-session', timestamp,
        message: { role: 'assistant', content: [{ type: 'text', text: `Claude answer ${seq}` }] } },
    ]);
    writeFileSync(claudeSource, claudeTurn(1));
    await index();
    expect(embed).toHaveBeenCalledTimes(3);
    const old = ompRows()[0];
    expect(old).toMatchObject({ line_start: 2, line_end: 3, assistant_message: 'abandoned-answer-A' });
    seedTool(old.id);
    // Even a non-OMP row at this exact archive path must not be purged.
    // Keep MAX(line_end) at 3 to match the concrete regeneration repro.
    insertExchange(db, {
      id: 'other-harness-same-archive', project: 'project-a', timestamp,
      archivePath: archive, lineStart: 1, lineEnd: 1, harness: 'claude',
      userMessage: 'unrelated harness', assistantMessage: 'keep this row',
    }, new Array(384).fill(0.5));
    seedTool('other-harness-same-archive');
    expect(db.prepare('SELECT MAX(line_end) AS line FROM exchanges WHERE archive_path = ?').get(archive))
      .toEqual({ line: 3 });
    const unaffected = snapshot();

    appendFileSync(source, jsonl([answerB]));
    const parsed = await parseConversation(source, 'project-a', archive);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ assistantMessage: 'replacement-answer-B', lineStart: 2, lineEnd: 4 });
    await index();
    expect(ompRows()).toHaveLength(1);
    expect(ompRows()[0]).toMatchObject({ id: parsed[0].id, assistant_message: 'replacement-answer-B', line_end: 4 });
    expect(embed).toHaveBeenCalledTimes(4);
    expect(rows().filter(row => row.id !== parsed[0].id)).toEqual(unaffected.rows.filter(row => row.id !== old.id));
    expect(db.prepare('SELECT * FROM vec_exchanges WHERE id = ?').get(old.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM tool_calls WHERE exchange_id = ?').get(old.id)).toBeUndefined();
    expect(snapshot().tools).toEqual(unaffected.tools.filter((row: any) => row.exchange_id !== old.id));
    expect(snapshot().vectors.filter((row: any) => row.id !== parsed[0].id))
      .toEqual(unaffected.vectors.filter((row: any) => row.id !== old.id));
    expectConsistent();
    expect(await searchConversations('abandoned-answer-A', { mode: 'text' })).toEqual([]);
    expect((await searchConversations('replacement-answer-B', { mode: 'text' })).map(r => r.exchange.id)).toEqual([parsed[0].id]);
    const vectorIds = (await searchConversations('active', { mode: 'vector', limit: 10 })).map(r => r.exchange.id);
    expect(vectorIds).toContain(parsed[0].id);
    expect(vectorIds).not.toContain(old.id);

    const stable = snapshot();
    const version = db.pragma('data_version', { simple: true });
    await index();
    expect(embed).toHaveBeenCalledTimes(4);
    expect(snapshot()).toEqual(stable);
    expect(db.pragma('data_version', { simple: true })).toBe(version);
    expect(query).not.toHaveBeenCalled();

    // Append-only harnesses still use the existing incremental path.
    appendFileSync(claudeSource, claudeTurn(2));
    await index();
    expect(embed).toHaveBeenCalledTimes(5);
    expect(rows().filter(row => row.archive_path.endsWith('claude.jsonl'))).toHaveLength(2);
    expect(ompRows()).toEqual(stable.rows.filter(row => row.archive_path === archive && row.harness === 'omp'));
  });

  it('switches a deeper branch while preserving the unchanged prefix and its embedding', async () => {
    appendFileSync(source, jsonl([
      message('u2', 'a1', 'user', 'Old branch question'),
      message('a2', 'u2', 'assistant', 'Old branch answer'),
    ]));
    await index();
    const prefix = ompRows().find(row => row.line_end === 3)!;
    const abandoned = ompRows().find(row => row.line_end === 5)!;
    seedTool(abandoned.id);
    const prefixVector = db.prepare('SELECT embedding FROM vec_exchanges WHERE id = ?').get(prefix.id);
    appendFileSync(source, jsonl([
      message('u3', 'a1', 'user', 'New branch question'),
      message('a3', 'u3', 'assistant', 'New branch answer'),
    ]));
    await index();
    expect(ompRows()).toHaveLength(2);
    expect(ompRows()).toContainEqual(prefix);
    expect(ompRows().some(row => row.id === abandoned.id)).toBe(false);
    expect(ompRows().some(row => row.assistant_message === 'New branch answer' && row.line_end === 7)).toBe(true);
    expect(db.prepare('SELECT embedding FROM vec_exchanges WHERE id = ?').get(prefix.id)).toEqual(prefixVector);
    expect(snapshot().tools).toEqual([]);
    expect(embed).toHaveBeenCalledTimes(3);
    expectConsistent();
  });

  it('refreshes changed content when the parser ID and line range stay stable', async () => {
    await index();
    const old = ompRows()[0];
    seedTool(old.id);
    writeFileSync(source, jsonl([header, user, answerB]));
    expect((await parseConversation(source, 'project-a', archive))[0].id).toBe(old.id);
    await index();
    expect(ompRows()).toHaveLength(1);
    expect(ompRows()[0]).toMatchObject({ id: old.id, assistant_message: 'replacement-answer-B', line_end: 3 });
    expect(snapshot().tools).toEqual([]);
    expectConsistent();
    expect(embed).toHaveBeenCalledTimes(2);
    const stable = snapshot();
    await index();
    expect(snapshot()).toEqual(stable);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  function appendReplacementBranch() {
    appendFileSync(source, jsonl([
      answerB,
      message('u2', 'b1', 'user', 'Follow up'),
      message('b2', 'u2', 'assistant', 'replacement-answer-C'),
    ]));
  }

  it('prepares every replacement before deleting anything; rejected embedding preserves the entire archive', async () => {
    await index();
    seedTool(ompRows()[0].id);
    const before = snapshot();
    appendReplacementBranch();
    embed.mockImplementationOnce(async () => {
      expect(snapshot()).toEqual(before);
      return new Array(384).fill(0.25);
    }).mockImplementationOnce(async () => {
      expect(snapshot()).toEqual(before);
      throw new Error('fixture embedding aborted');
    });
    await expect(index()).rejects.toThrow('fixture embedding aborted');
    expect(snapshot()).toEqual(before);
    expectConsistent();
    await index();
    expect(ompRows().map(row => row.assistant_message).sort()).toEqual(['replacement-answer-B', 'replacement-answer-C']);
    expectConsistent();
  });

  it.each([
    ['wrong dimensions', [0.5]],
    ['NaN', new Array(384).fill(NaN)],
    ['float32 overflow', new Array(384).fill(1e100)],
  ])('preserves existing rows on an invalid replacement embedding: %s', async (_name, embedding) => {
    await index();
    seedTool(ompRows()[0].id);
    const before = snapshot();
    appendFileSync(source, jsonl([answerB]));
    embed.mockResolvedValueOnce(embedding);
    await expect(index()).rejects.toThrow();
    expect(snapshot()).toEqual(before);
    expectConsistent();
  });

  it('rolls back all row/vector/tool changes when a later replacement insert fails', async () => {
    await index();
    seedTool(ompRows()[0].id);
    const before = snapshot();
    appendReplacementBranch();
    db.exec(`CREATE TRIGGER fail_second_replacement BEFORE INSERT ON exchanges
      WHEN NEW.assistant_message = 'replacement-answer-C'
      BEGIN SELECT RAISE(ABORT, 'fixture insert aborted'); END`);
    await expect(index()).rejects.toThrow('fixture insert aborted');
    expect(snapshot()).toEqual(before);
    expectConsistent();
    db.exec('DROP TRIGGER fail_second_replacement');
    await index();
    expect(ompRows()).toHaveLength(2);
    expect(snapshot().tools).toEqual([]);
    expectConsistent();
  });

  it('rolls back replacements and deleted vectors/tools if abandoned-row cleanup fails', async () => {
    appendFileSync(source, jsonl([
      message('u2', 'a1', 'user', 'Old follow up'),
      message('a2', 'u2', 'assistant', 'Old follow up answer'),
    ]));
    await index();
    for (const row of ompRows()) seedTool(row.id);
    const before = snapshot();
    appendFileSync(source, jsonl([answerB]));
    // Fail on the second abandoned row, after the first row and its tools
    // were deleted and the second vector was deleted by deleteExchange().
    db.exec(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON exchanges
      WHEN (SELECT COUNT(*) FROM exchanges WHERE harness = 'omp'
        AND assistant_message != 'replacement-answer-B') = 1
      BEGIN SELECT RAISE(ABORT, 'fixture cleanup aborted'); END`);
    await expect(index()).rejects.toThrow('fixture cleanup aborted');
    expect(snapshot()).toEqual(before);
    expectConsistent();
    db.exec('DROP TRIGGER fail_cleanup');
    await index();
    expect(ompRows()).toHaveLength(1);
    expect(ompRows()[0].assistant_message).toBe('replacement-answer-B');
    expect(snapshot().tools).toEqual([]);
    expectConsistent();
  });

  it('skips an oversized replacement before embedding but removes the abandoned answer', async () => {
    await index();
    seedTool(ompRows()[0].id);
    vi.stubEnv('EPISODIC_MEMORY_MAX_MESSAGE_BYTES', '100');
    appendFileSync(source, jsonl([message('huge', 'u1', 'assistant', 'x'.repeat(101))]));
    await index();
    expect(ompRows()).toEqual([]);
    expect(snapshot().tools).toEqual([]);
    expect(embed).toHaveBeenCalledTimes(1);
    expectConsistent();
    await index();
    expect(embed).toHaveBeenCalledTimes(1);
    appendFileSync(source, jsonl([answerB]));
    await index();
    expect(ompRows()[0]).toMatchObject({ assistant_message: 'replacement-answer-B', line_end: 5 });
    expect(readFileSync(archive, 'utf8')).toBe(readFileSync(source, 'utf8'));
    expect(embed).toHaveBeenCalledTimes(2);
    expectConsistent();
  });

  it('reconciles a reachable empty active path, then indexes its eventual answer', async () => {
    await index();
    seedTool(ompRows()[0].id);
    // A new root user abandons the old tree, with no completed exchange yet.
    appendFileSync(source, jsonl([message('new-root', null, 'user', 'New root question')]));
    expect(await parseConversation(source, 'project-a', archive)).toEqual([]);
    await index();
    expect(ompRows()).toEqual([]);
    expect(snapshot().tools).toEqual([]);
    expect(embed).toHaveBeenCalledTimes(1);
    expectConsistent();
    const version = db.pragma('data_version', { simple: true });
    await index();
    expect(db.pragma('data_version', { simple: true })).toBe(version);
    appendFileSync(source, jsonl([message('new-answer', 'new-root', 'assistant', 'New root answer')]));
    await index();
    expect(ompRows()[0]).toMatchObject({ assistant_message: 'New root answer', line_start: 4, line_end: 5 });
    expect(readFileSync(archive, 'utf8')).toBe(readFileSync(source, 'utf8'));
    expect(embed).toHaveBeenCalledTimes(2);
    expectConsistent();
  });
});
