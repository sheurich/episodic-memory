import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { suppressConsole } from './test-utils.js';

const restoreConsole = suppressConsole();

const repairIndexSpy = vi.fn(async () => {});

function line(obj: object): string {
  return JSON.stringify(obj);
}

/**
 * Run `index-cli repair` in-process against a real verifyIndex() with only
 * repairIndex() observed, so the test needs no embedding model.
 */
async function runRepairCommand(): Promise<void> {
  vi.resetModules();
  vi.doMock('../src/verify.js', async () => {
    const actual = await vi.importActual<typeof import('../src/verify.js')>('../src/verify.js');
    return { ...actual, repairIndex: repairIndexSpy };
  });
  process.argv = [process.argv[0], 'index-cli.js', 'repair'];
  await import('../src/index-cli.js');
}

describe('index-cli repair command', () => {
  afterAll(() => restoreConsole());
  let testDir: string;
  const originalArgv = process.argv;
  const exitListeners = process.listeners('exit');

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episodic-memory-index-cli-repair-'));
    fs.mkdirSync(path.join(testDir, 'archive', 'project'), { recursive: true });
    process.env.TEST_ARCHIVE_DIR = path.join(testDir, 'archive');
    process.env.TEST_DB_PATH = path.join(testDir, 'db.sqlite');
    process.env.EPISODIC_MEMORY_CONFIG_DIR = path.join(testDir, 'config');
    repairIndexSpy.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    for (const listener of process.listeners('exit')) {
      if (!exitListeners.includes(listener)) process.removeListener('exit', listener);
    }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.removeAllListeners(signal);
    }
    vi.doUnmock('../src/verify.js');
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('invokes repair when unindexed archives are the only issue', async () => {
    const conv = path.join(testDir, 'archive', 'project', 'conv.jsonl');
    fs.writeFileSync(conv, [
      line({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      line({ type: 'assistant', message: { role: 'assistant', content: 'Hi' }, timestamp: '2024-01-01T00:00:01Z' }),
    ].join('\n') + '\n');
    fs.writeFileSync(conv.replace('.jsonl', '-summary.txt'), 'An existing summary');

    await runRepairCommand();
    await vi.waitFor(() => expect(repairIndexSpy).toHaveBeenCalledTimes(1));

    const issues = (repairIndexSpy.mock.calls[0] as unknown[])[0] as {
      missing: unknown[]; orphaned: unknown[]; outdated: unknown[]; corrupted: unknown[]; unindexed: Array<{ path: string }>;
    };
    expect(issues.unindexed.map(u => u.path)).toEqual([conv]);
    expect(issues.missing.length + issues.orphaned.length + issues.outdated.length).toBe(0);
  });
});
