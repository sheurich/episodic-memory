import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  utimesSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'fs';
import { spawn as spawnProcess } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  acquireInstallLock,
  releaseInstallLock,
  runNpmInstall,
} from '../cli/install-runner.js';
import * as installRunner from '../cli/install-runner.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER_PATH = join(REPO_ROOT, 'cli', 'mcp-server-wrapper.js');
const INSTALL_RUNNER_PATH = join(REPO_ROOT, 'cli', 'install-runner.js');
const HARD_DEATH_FIXTURE_PATH = join(REPO_ROOT, 'test', 'fixtures', 'install-lock-hard-death.cjs');

function makeFakeChild(pid = 999999999): any {
  const child: any = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function writeNodeExecutable(nodeDirectory: string): string {
  mkdirSync(nodeDirectory, { recursive: true });
  const nodeExecutable = join(nodeDirectory, 'node.exe');
  writeFileSync(nodeExecutable, '// inert test fixture; never executed\n');
  return realpathSync(nodeExecutable);
}

function writeNpmPackage(packageRoot: string, name = 'npm'): string {
  const binDirectory = join(packageRoot, 'bin');
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name,
    version: '10.0.0',
    bin: { npm: 'bin/npm-cli.js' },
  }));
  const npmCliPath = join(binDirectory, 'npm-cli.js');
  writeFileSync(npmCliPath, '// inert test fixture; never executed\n');
  return realpathSync(npmCliPath);
}

describe('install-runner — npm launcher selection', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'episodic-memory-npm-launcher-'));
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it('ignores a valid foreign npm_execpath and launches the npm paired with Node', () => {
    const nodeDirectory = join(root, 'Program Files', 'paired Node with spaces');
    const nodeExecutable = writeNodeExecutable(nodeDirectory);
    const pairedNpmCliPath = writeNpmPackage(join(nodeDirectory, 'node_modules', 'npm'));
    const foreignNpmCliPath = writeNpmPackage(join(root, 'foreign npm installation', 'npm'));

    const launch = (installRunner as any).resolveNpmInstallLaunch({
      platform: 'win32',
      nodeExecutable,
      npmExecPath: foreignNpmCliPath,
      environment: {},
    });

    expect(launch).toEqual({
      executable: nodeExecutable,
      args: [pairedNpmCliPath, 'install', '--package-lock=false', '--no-audit', '--no-fund'],
      shell: false,
    });
  });

  it('finds npm in the fixed sibling lib layout paired with the configured Windows Node', () => {
    const nodeDirectory = join(root, 'paired root with spaces', 'bin');
    const nodeExecutable = writeNodeExecutable(nodeDirectory);
    const npmCliPath = writeNpmPackage(join(
      nodeDirectory,
      '..',
      'lib',
      'node_modules',
      'npm',
    ));

    expect((installRunner as any).resolveNpmInstallLaunch({
      platform: 'win32',
      nodeExecutable,
      npmExecPath: null,
      environment: {},
    })).toEqual({
      executable: nodeExecutable,
      args: [npmCliPath, 'install', '--package-lock=false', '--no-audit', '--no-fund'],
      shell: false,
    });
  });

  it('fails closed when only a structurally valid foreign npm_execpath exists', () => {
    const nodeExecutable = writeNodeExecutable(join(root, 'isolated Node'));
    const foreignNpmCliPath = writeNpmPackage(join(root, 'self-declared foreign npm', 'npm'));

    expect(() => (installRunner as any).resolveNpmInstallLaunch({
      platform: 'win32',
      nodeExecutable,
      npmExecPath: foreignNpmCliPath,
      environment: {},
    })).toThrow(/Unable to resolve a trusted npm-cli\.js for Windows/);
  });

  it('fails closed when the configured Node executable does not exist', () => {
    const nodeDirectory = join(root, 'missing Node executable');
    const nodeExecutable = join(nodeDirectory, 'node.exe');
    writeNpmPackage(join(nodeDirectory, 'node_modules', 'npm'));

    expect(() => (installRunner as any).resolveNpmInstallLaunch({
      platform: 'win32',
      nodeExecutable,
      environment: {},
    })).toThrow(/Unable to resolve a trusted npm-cli\.js for Windows/);
  });

  it('fails closed when the paired entry is owned by a foreign package', () => {
    const nodeDirectory = join(root, 'foreign paired package');
    const nodeExecutable = writeNodeExecutable(nodeDirectory);
    writeNpmPackage(join(nodeDirectory, 'node_modules', 'npm'), 'not-npm');

    expect(() => (installRunner as any).resolveNpmInstallLaunch({
      platform: 'win32',
      nodeExecutable,
      environment: {},
    })).toThrow(/Unable to resolve a trusted npm-cli\.js for Windows/);
  });

  it('keeps the literal npm executable and unchanged install argv on POSIX', () => {
    expect((installRunner as any).resolveNpmInstallLaunch({
      platform: 'darwin',
      nodeExecutable: '/ignored/node',
      npmExecPath: '/ignored/npm-cli.js',
    })).toEqual({
      executable: 'npm',
      args: ['install', '--package-lock=false', '--no-audit', '--no-fund'],
      shell: false,
    });
  });
});

describe('install-runner — install lock (#161)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'episodic-memory-install-lock-'));
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it('a second acquire is excluded while the lock is held; re-acquiring works after release', () => {
    const first = acquireInstallLock(root);
    expect(first).not.toBeNull();

    const second = acquireInstallLock(root);
    expect(second).toBeNull();

    releaseInstallLock(first!);

    const third = acquireInstallLock(root);
    expect(third).not.toBeNull();
    releaseInstallLock(third!);
  });

  it('does not steal an aged lock from a live owner and heartbeats ownership metadata', async () => {
    const staleMs = 80;
    const first = acquireInstallLock(root, { staleMs, heartbeatMs: 10 });
    expect(first).not.toBeNull();
    const ownerPath = join(root, '.episodic-memory-install.lock', 'owner.json');
    const firstOwner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    const firstMtime = statSync(ownerPath).mtimeMs;

    const ancient = new Date(Date.now() - staleMs - 1000);
    utimesSync(join(root, '.episodic-memory-install.lock'), ancient, ancient);
    utimesSync(ownerPath, ancient, ancient);
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(acquireInstallLock(root, { staleMs, heartbeatMs: 10 })).toBeNull();
    const refreshedOwner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    expect(refreshedOwner.token).toBe(firstOwner.token);
    expect(refreshedOwner.pid).toBe(process.pid);
    expect(statSync(ownerPath).mtimeMs).toBeGreaterThan(firstMtime);
    releaseInstallLock(first!);
  });

  it('recovers an aged lock whose owner is confirmed dead', () => {
    const staleMs = 50;
    const lockPath = join(root, '.episodic-memory-install.lock');
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      version: 2,
      token: 'dead-owner',
      pid: 999999999,
      startedAt: Date.now() - 10_000,
      installer: { state: 'idle' },
    }));
    const ancient = new Date(Date.now() - staleMs - 1000);
    utimesSync(lockPath, ancient, ancient);
    utimesSync(join(lockPath, 'owner.json'), ancient, ancient);

    const replacement = acquireInstallLock(root, { staleMs, heartbeatMs: 10 });
    expect(replacement).not.toBeNull();
    expect(replacement!.token).not.toBe('dead-owner');
    releaseInstallLock(replacement!);
  });

  it.each([
    ['missing metadata', undefined],
    ['malformed metadata', '{not-json'],
    ['unknown metadata version', JSON.stringify({ version: 99, token: 'unknown', pid: 999999999 })],
    ['missing installer metadata', JSON.stringify({
      version: 2,
      token: 'missing-installer',
      pid: 999999999,
      startedAt: Date.now() - 10_000,
    })],
    ['inconclusive pending-spawn metadata', JSON.stringify({
      version: 2,
      token: 'pending-spawn',
      pid: 999999999,
      startedAt: Date.now() - 10_000,
      installer: { state: 'pending' },
    })],
    ['inconclusive running metadata without a process group', JSON.stringify({
      version: 2,
      token: 'missing-process-group',
      pid: 999999999,
      startedAt: Date.now() - 10_000,
      installer: { state: 'running', pid: 999999998, groupId: null },
    })],
  ])('fails closed for an aged lock with %s', (_label, metadata) => {
    const staleMs = 50;
    const lockPath = join(root, '.episodic-memory-install.lock');
    mkdirSync(lockPath);
    if (metadata !== undefined) writeFileSync(join(lockPath, 'owner.json'), metadata);
    const ancient = new Date(Date.now() - staleMs - 1000);
    utimesSync(lockPath, ancient, ancient);
    if (metadata !== undefined) utimesSync(join(lockPath, 'owner.json'), ancient, ancient);

    expect(acquireInstallLock(root, { staleMs, heartbeatMs: 10 })).toBeNull();
    expect(existsSync(lockPath)).toBe(true);
  });

  it('an old handle cannot delete a replacement owner lock', () => {
    const first = acquireInstallLock(root, { heartbeatMs: 10 });
    expect(first).not.toBeNull();
    const lockPath = join(root, '.episodic-memory-install.lock');
    const ownerPath = join(lockPath, 'owner.json');

    first!.stopHeartbeat();
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath);
    writeFileSync(ownerPath, JSON.stringify({
      version: 1,
      token: 'replacement-owner',
      pid: process.pid,
      startedAt: Date.now(),
    }));

    releaseInstallLock(first!);
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(ownerPath, 'utf8')).token).toBe('replacement-owner');
  });
});

describe('install-runner — hard parent death ownership', () => {
  let root: string;
  let wrapper: ReturnType<typeof spawnProcess> | undefined;
  let ownedGroupId: number | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'episodic-memory-hard-death-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'home'), { recursive: true });
    copyFileSync(HARD_DEATH_FIXTURE_PATH, join(root, 'scripts', 'reinstall-native.js'));
  });

  afterEach(async () => {
    if (wrapper && isAlive(wrapper.pid!)) {
      try { wrapper.kill('SIGKILL'); } catch {}
    }
    if (ownedGroupId && isProcessGroupAlive(ownedGroupId)) {
      try { process.kill(-ownedGroupId, 'SIGKILL'); } catch {}
      try { await waitFor(() => !isProcessGroupAlive(ownedGroupId!), 5_000); } catch {}
    }
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it.skipIf(process.platform === 'win32')(
    'does not recover a dead-wrapper lock until its owned installer group has stopped',
    async () => {
      const wrapperReceipt = join(root, 'wrapper.pid');
      const installerReceipt = join(root, 'installer.pid');
      wrapper = spawnProcess(process.execPath, [join(root, 'scripts', 'reinstall-native.js'), '--wrapper'], {
        cwd: root,
        env: {
          HARD_DEATH_PLUGIN_ROOT: root,
          HARD_DEATH_INSTALL_RUNNER: INSTALL_RUNNER_PATH,
          HARD_DEATH_WRAPPER_RECEIPT: wrapperReceipt,
          HARD_DEATH_INSTALLER_RECEIPT: installerReceipt,
          HOME: join(root, 'home'),
          HF_HOME: join(root, 'home', 'huggingface'),
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
        },
        stdio: 'ignore',
      });

      await waitFor(() => existsSync(wrapperReceipt) && existsSync(installerReceipt), 10_000);
      const recordedWrapperPid = Number(readFileSync(wrapperReceipt, 'utf8').trim());
      ownedGroupId = Number(readFileSync(installerReceipt, 'utf8').trim());
      expect(recordedWrapperPid).toBe(wrapper.pid);
      expect(Number.isSafeInteger(ownedGroupId)).toBe(true);
      expect(isProcessGroupAlive(ownedGroupId)).toBe(true);

      const ownerPath = join(root, '.episodic-memory-install.lock', 'owner.json');
      const recordedOwner = JSON.parse(readFileSync(ownerPath, 'utf8'));
      wrapper.kill('SIGKILL');
      await waitFor(() => !isAlive(recordedWrapperPid), 5_000);
      expect(isProcessGroupAlive(ownedGroupId)).toBe(true);

      const ancient = new Date(Date.now() - 10_000);
      utimesSync(ownerPath, ancient, ancient);
      utimesSync(dirname(ownerPath), ancient, ancient);

      const contender = acquireInstallLock(root, { staleMs: 10, heartbeatMs: 10 });
      expect(contender).toBeNull();
      expect(recordedOwner.installer).toEqual({
        state: 'running',
        pid: ownedGroupId,
        groupId: ownedGroupId,
      });

      process.kill(-ownedGroupId, 'SIGTERM');
      await waitFor(() => !isProcessGroupAlive(ownedGroupId!), 5_000);
      ownedGroupId = undefined;

      const replacement = acquireInstallLock(root, { staleMs: 10, heartbeatMs: 10 });
      expect(replacement).not.toBeNull();
      releaseInstallLock(replacement!);
    },
    20_000,
  );
});

describe('install-runner — runNpmInstall termination handling (#161)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'episodic-memory-install-runner-'));
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it('terminate() keeps the lock until delayed child exit and late events cannot remove a successor lock', async () => {
    const beforeSigterm = process.listenerCount('SIGTERM');
    const beforeSigint = process.listenerCount('SIGINT');
    const beforeSighup = process.listenerCount('SIGHUP');
    const beforeExit = process.listenerCount('exit');

    const child = makeFakeChild();
    const fakeSpawn = vi.fn(() => child);
    const lock = acquireInstallLock(root);
    expect(lock).not.toBeNull();

    const install = runNpmInstall(root, { spawn: fakeSpawn, lockHandle: lock, terminationGraceMs: 50 });

    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm + 1);
    install.terminate();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(existsSync(join(root, '.episodic-memory-install.lock'))).toBe(true);
    expect(acquireInstallLock(root)).toBeNull();

    child.emit('exit', null, 'SIGTERM');
    await expect(install.promise).rejects.toThrow(/terminated/);
    expect(existsSync(join(root, '.episodic-memory-install.lock'))).toBe(false);

    const successor = acquireInstallLock(root);
    expect(successor).not.toBeNull();
    child.emit('exit', null, 'SIGTERM');
    child.emit('error', new Error('late child event'));
    expect(existsSync(join(root, '.episodic-memory-install.lock'))).toBe(true);
    releaseInstallLock(successor!);

    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
    expect(process.listenerCount('SIGINT')).toBe(beforeSigint);
    expect(process.listenerCount('SIGHUP')).toBe(beforeSighup);
    expect(process.listenerCount('exit')).toBe(beforeExit);
  });

  it('refuses an explicit release while the owned installer is still running', async () => {
    const child = makeFakeChild();
    const lock = acquireInstallLock(root, { heartbeatMs: 10 });
    const install = runNpmInstall(root, { spawn: vi.fn(() => child), lockHandle: lock });

    expect(releaseInstallLock(lock!)).toBe(false);
    expect(existsSync(join(root, '.episodic-memory-install.lock'))).toBe(true);

    child.emit('exit', 0);
    await expect(install.promise).resolves.toBeUndefined();
    expect(existsSync(join(root, '.episodic-memory-install.lock'))).toBe(false);
  });

  it('escalates TERM to KILL after a bounded grace period without releasing a live child lock', async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const lock = acquireInstallLock(root);
      const install = runNpmInstall(root, {
        spawn: vi.fn(() => child),
        lockHandle: lock,
        terminationGraceMs: 25,
      });

      install.terminate('SIGTERM');
      expect(existsSync(join(root, '.episodic-memory-install.lock'))).toBe(true);
      await vi.advanceTimersByTimeAsync(25);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(existsSync(join(root, '.episodic-memory-install.lock'))).toBe(true);

      child.emit('exit', null, 'SIGKILL');
      await expect(install.promise).rejects.toThrow(/terminated/);
      expect(existsSync(join(root, '.episodic-memory-install.lock'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('spawns the platform-resolved npm launch with fixed argv and no shell', () => {
    const child = makeFakeChild();
    const fakeSpawn = vi.fn(() => child);
    const expectedLaunch = (installRunner as any).resolveNpmInstallLaunch();
    const install = runNpmInstall(root, { spawn: fakeSpawn });

    expect(fakeSpawn).toHaveBeenCalledWith(
      expectedLaunch.executable,
      expectedLaunch.args,
      expect.objectContaining({ cwd: root, shell: false }),
    );
    child.emit('exit', 0, null);
    return install.promise;
  });

  it('resolves and removes handlers when the child exits 0 normally (no termination)', async () => {
    const beforeSigterm = process.listenerCount('SIGTERM');

    const child = makeFakeChild();
    const fakeSpawn = vi.fn(() => child);
    const install = runNpmInstall(root, { spawn: fakeSpawn });

    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm + 1);

    child.emit('exit', 0);
    await expect(install.promise).resolves.toBeUndefined();

    expect(child.kill).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
  });

  it('rejects when the child exits non-zero, and still removes handlers', async () => {
    const beforeSigterm = process.listenerCount('SIGTERM');

    const child = makeFakeChild();
    const fakeSpawn = vi.fn(() => child);
    const install = runNpmInstall(root, { spawn: fakeSpawn });

    child.emit('exit', 1);
    await expect(install.promise).rejects.toThrow(/npm install failed/);

    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
  });

  it('keeps the same install lock through native repair termination until the process exits', async () => {
    const child = makeFakeChild();
    const fakeSpawn = vi.fn(() => child);
    const lock = acquireInstallLock(root);
    const repair = (installRunner as any).runNodeRepair(root, {
      // Caller input is deliberately ignored; the startup-root repair script
      // is the only allowed Node target.
      scriptPath: join(root, 'attacker-controlled.js'),
      spawn: fakeSpawn,
      lockHandle: lock,
      terminationGraceMs: 25,
    });

    expect(fakeSpawn).toHaveBeenCalledWith(
      process.execPath,
      [join(root, 'scripts', 'reinstall-native.js')],
      expect.objectContaining({ cwd: root, shell: false }),
    );
    repair.terminate('SIGTERM');
    expect(existsSync(join(root, '.episodic-memory-install.lock'))).toBe(true);

    child.emit('exit', null, 'SIGTERM');
    await expect(repair.promise).rejects.toThrow(/terminated/);
    expect(existsSync(join(root, '.episodic-memory-install.lock'))).toBe(false);
  });
});

describe('mcp-server-wrapper — real spawn, orphan prevention on SIGTERM (#161)', () => {
  let root: string;
  let binDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'episodic-memory-wrapper-root-'));
    binDir = mkdtempSync(join(tmpdir(), 'episodic-memory-wrapper-bin-'));
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
    try { rmSync(binDir, { recursive: true, force: true }); } catch {}
  });

  it.skipIf(process.platform === 'win32')(
    'kills the POSIX PATH npm stub when the wrapper is SIGTERM-ed mid-install',
    async () => {
    // A stub "npm" that just stays alive and records its own pid, so we can
    // tell whether the wrapper's real child-tree kill reaches it. No network
    // call is made — this never touches the real npm registry.
    const pidFile = join(root, 'npm-stub.pid');
    const npmStubPath = join(binDir, 'npm');
    writeFileSync(
      npmStubPath,
      `#!/usr/bin/env node\n` +
        `import { writeFileSync } from 'fs';\n` +
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1000);\n`,
      'utf-8'
    );
    chmodSync(npmStubPath, 0o755);

    // An empty plugin root: node_modules is entirely absent, so the wrapper's
    // findMissingDeps probe reports everything missing and takes the install
    // path, invoking our stub "npm" (resolved via PATH, prepended below).
    const wrapper = spawnProcess(process.execPath, [WRAPPER_PATH], {
      cwd: root,
      env: {
        ...process.env,
        EPISODIC_MEMORY_WRAPPER_ROOT: root,
        CLAUDE_PLUGIN_ROOT: root,
        PATH: `${binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitFor(() => existsSync(pidFile), 10_000);
      const stubPid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      expect(Number.isFinite(stubPid)).toBe(true);
      expect(isAlive(stubPid)).toBe(true);

      wrapper.kill('SIGTERM');

      await waitFor(() => !isAlive(stubPid), 10_000);
      expect(isAlive(stubPid)).toBe(false);
    } finally {
      try { wrapper.kill('SIGKILL'); } catch {}
    }
  }, 20_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error: any) {
    return error?.code !== 'ESRCH';
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!condition()) {
    throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
  }
}
