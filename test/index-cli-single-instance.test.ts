import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { acquireFileLock, releaseFileLock, type FileLockHandle } from '../src/file-lock.js';

/**
 * index-cli and sync-cli write the same index and archive. Hold the real
 * v1.4.2 lock and ensure index-cli exits before database work.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_CLI = join(REPO_ROOT, 'dist', 'index-cli.js');

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe('index-cli single-instance lock (#97 cross-harness)', () => {
  let testDir: string;
  let envOverrides: Record<string, string>;
  let lockPath: string;
  let heldLock: FileLockHandle | null = null;

  function runIndexCli(args: string[]): RunResult {
    const env = { ...process.env, ...envOverrides };
    delete env.EPISODIC_MEMORY_DB_PATH;
    const result = spawnSync(process.execPath, [INDEX_CLI, ...args], {
      env,
      timeout: 120_000,
      encoding: 'utf-8',
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'episodic-memory-index-lock-'));
    // Isolated transcript sources for every harness the CLI knows about, so
    // nothing reads the developer's real ~/.claude, ~/.codex, ~/.pi, ~/.gemini
    // or OpenCode data, and nothing touches the real ~/.config/superpowers.
    mkdirSync(join(testDir, 'projects'), { recursive: true });
    mkdirSync(join(testDir, 'archive'), { recursive: true });
    mkdirSync(join(testDir, 'config', 'logs'), { recursive: true });
    mkdirSync(join(testDir, 'claude'), { recursive: true });
    mkdirSync(join(testDir, 'codex'), { recursive: true });
    mkdirSync(join(testDir, 'pi'), { recursive: true });
    mkdirSync(join(testDir, 'gemini'), { recursive: true });
    mkdirSync(join(testDir, 'opencode'), { recursive: true });

    envOverrides = {
      TEST_PROJECTS_DIR: join(testDir, 'projects'),
      TEST_ARCHIVE_DIR: join(testDir, 'archive'),
      TEST_DB_PATH: join(testDir, 'test.db'),
      EPISODIC_MEMORY_CONFIG_DIR: join(testDir, 'config'),
      CLAUDE_CONFIG_DIR: join(testDir, 'claude'),
      CODEX_HOME: join(testDir, 'codex'),
      PI_HOME: join(testDir, 'pi'),
      GEMINI_HOME: join(testDir, 'gemini'),
      OPENCODE_DATA_DIR: join(testDir, 'opencode'),
    };

    // Pin the v1.4.2 path independently of getSyncLockPath().
    lockPath = join(testDir, 'config', 'logs', 'episodic-memory-sync.lock');
  });

  afterEach(() => {
    if (heldLock) {
      releaseFileLock(heldLock);
      heldLock = null;
    }
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it('skips `index-all-sources --no-summaries` with status 0 while the sync lock is held', () => {
    heldLock = acquireFileLock(lockPath);
    expect(heldLock).not.toBeNull();

    const result = runIndexCli(['index-all-sources', '--no-summaries']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`sync already running (pid ${process.pid}); skipping`);
    expect(result.stdout).not.toMatch(/Initializing database/);
    expect(existsSync(join(testDir, 'test.db'))).toBe(false);
  });

  it('skips `verify` too — it calls initDatabase() and can run schema migrations', () => {
    heldLock = acquireFileLock(lockPath);
    expect(heldLock).not.toBeNull();

    const result = runIndexCli(['verify']);

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/sync already running.*skipping/);
    expect(result.stdout).not.toMatch(/Verifying conversation index/);
    expect(existsSync(join(testDir, 'test.db'))).toBe(false);
  });

  it('releases the lock after an uncontended run', () => {
    const result = runIndexCli(['verify']);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/sync already running/);
    expect(result.stdout).toMatch(/Verification Results/);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.lock`)).toBe(false);
  });

  it('releases the lock when a command exits non-zero, so a failure cannot wedge later runs', () => {
    // Missing ID exits after the module-level lock is acquired.
    const failed = runIndexCli(['index-session']);

    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/Usage: index-cli index-session <session-id>/);
    expect(failed.stderr).not.toMatch(/sync already running/);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.lock`)).toBe(false);

    const next = runIndexCli(['verify']);
    expect(next.status).toBe(0);
    expect(next.stderr).not.toMatch(/sync already running/);
    expect(next.stdout).toMatch(/Verification Results/);
  });
});
