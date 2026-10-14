/**
 * First-install process orchestration. This file intentionally uses Node
 * built-ins only because it runs before package dependencies are available.
 */

import { spawn as defaultSpawn } from 'child_process';
import { randomUUID } from 'crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join, resolve } from 'path';

const LOCK_DIR_NAME = '.episodic-memory-install.lock';
const OWNER_FILE_NAME = 'owner.json';
const OWNER_VERSION = 2;
const DEFAULT_STALE_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_CAP_BYTES = 128 * 1024;
const TERMINATION_GRACE_MS = 2_000;
const STOP_CONFIRM_MS = 2_000;
const NPM_INSTALL_ARGS = ['install', '--package-lock=false', '--no-audit', '--no-fund'];
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;

function canonicalRegularFile(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;

  try {
    const canonicalPath = realpathSync(candidate);
    return statSync(canonicalPath).isFile() ? canonicalPath : null;
  } catch {
    return null;
  }
}

function canonicalTrustedNpmCli(fixedCandidate) {
  try {
    const expectedEntry = resolve(fixedCandidate);
    const canonicalEntry = canonicalRegularFile(expectedEntry);
    if (!canonicalEntry || canonicalEntry.toLowerCase() !== expectedEntry.toLowerCase()) return null;

    const packageRoot = dirname(dirname(canonicalEntry));
    if (basename(packageRoot).toLowerCase() !== 'npm') return null;

    const expectedPackageJson = join(packageRoot, 'package.json');
    const packageJsonPath = canonicalRegularFile(expectedPackageJson);
    if (!packageJsonPath || packageJsonPath.toLowerCase() !== expectedPackageJson.toLowerCase()) return null;
    const packageJsonStat = statSync(packageJsonPath);
    if (packageJsonStat.size > MAX_PACKAGE_JSON_BYTES) return null;

    const packageMetadata = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const npmBin = typeof packageMetadata?.bin === 'string'
      ? packageMetadata.bin
      : packageMetadata?.bin?.npm;
    if (packageMetadata?.name !== 'npm' || typeof npmBin !== 'string') return null;

    const declaredEntry = canonicalRegularFile(resolve(packageRoot, npmBin));
    return declaredEntry?.toLowerCase() === canonicalEntry.toLowerCase() ? canonicalEntry : null;
  } catch {
    return null;
  }
}

function fixedWindowsNpmCliCandidates(nodeExecutable) {
  const nodeDirectory = dirname(nodeExecutable);
  return [
    join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
}

/** Resolve the fixed npm installer launch without changing global platform state in tests. */
export function resolveNpmInstallLaunch({
  platform = process.platform,
  nodeExecutable = process.execPath,
} = {}) {
  if (platform !== 'win32') {
    return { executable: 'npm', args: [...NPM_INSTALL_ARGS], shell: false };
  }

  const canonicalNodeExecutable = canonicalRegularFile(nodeExecutable);
  if (canonicalNodeExecutable) {
    for (const candidate of fixedWindowsNpmCliCandidates(canonicalNodeExecutable)) {
      const npmCliPath = canonicalTrustedNpmCli(candidate);
      if (npmCliPath) {
        return {
          executable: canonicalNodeExecutable,
          args: [npmCliPath, ...NPM_INSTALL_ARGS],
          shell: false,
        };
      }
    }
  }

  throw new Error(
    'Unable to resolve a trusted npm-cli.js for Windows; refusing to invoke npm without a validated JavaScript entry point',
  );
}

function lockPathFor(pluginRoot) {
  return join(pluginRoot, LOCK_DIR_NAME);
}

function ownerPathFor(lockPath) {
  return join(lockPath, OWNER_FILE_NAME);
}

function isValidInstallerMetadata(installer) {
  if (!installer || typeof installer !== 'object' || Array.isArray(installer)) return false;
  if (installer.state === 'idle' || installer.state === 'pending' || installer.state === 'stopped') {
    return Object.keys(installer).length === 1;
  }
  return installer.state === 'running' &&
    Number.isSafeInteger(installer.pid) &&
    installer.pid > 0 &&
    (installer.groupId === null ||
      (Number.isSafeInteger(installer.groupId) && installer.groupId > 0));
}

function readOwner(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(ownerPathFor(lockPath), 'utf8'));
    if (
      parsed?.version !== OWNER_VERSION ||
      typeof parsed.token !== 'string' ||
      parsed.token.length < 1 ||
      parsed.token.length > 128 ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid < 1 ||
      !Number.isFinite(parsed.startedAt) ||
      !isValidInstallerMetadata(parsed.installer)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function processLiveness(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    // EPERM and platform-specific failures are inconclusive. Never steal.
    return 'unknown';
  }
}

function processGroupLiveness(groupId) {
  try {
    process.kill(-groupId, 0);
    return 'alive';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function installerIsConclusivelyStopped(installer) {
  if (installer.state === 'idle' || installer.state === 'stopped') return true;
  if (installer.state !== 'running') return false;

  // Check both the recorded child and its detached process group. PID or PGID
  // reuse only makes this fail closed; it can never authorize recovery.
  if (processLiveness(installer.pid) !== 'dead') return false;
  // A missing process-group identity cannot establish that descendants are
  // gone (notably after hard death on platforms without detached groups).
  if (installer.groupId === null) return false;
  return processGroupLiveness(installer.groupId) === 'dead';
}

function ownerIsConclusivelyStopped(owner) {
  return processLiveness(owner.pid) === 'dead' &&
    installerIsConclusivelyStopped(owner.installer);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function updateOwnedInstaller(handle, installer) {
  if (!handle || !isValidInstallerMetadata(installer)) return false;

  let currentIdentity;
  try {
    currentIdentity = lstatSync(handle.path);
  } catch {
    return false;
  }
  const currentOwner = readOwner(handle.path);
  if (
    !sameIdentity(currentIdentity, handle) ||
    currentOwner?.token !== handle.token
  ) {
    return false;
  }

  const temporaryOwnerPath = join(handle.path, `.owner-${handle.token}-${randomUUID()}.tmp`);
  const nextOwner = { ...currentOwner, installer };
  try {
    writeFileSync(temporaryOwnerPath, `${JSON.stringify(nextOwner)}\n`, { flag: 'wx' });

    // Revalidate immediately before replacement so an old owner cannot write
    // installer metadata over a successor lock.
    const replacementIdentity = lstatSync(handle.path);
    const replacementOwner = readOwner(handle.path);
    if (
      !sameIdentity(replacementIdentity, handle) ||
      replacementOwner?.token !== handle.token
    ) {
      try { rmSync(temporaryOwnerPath, { force: true }); } catch {}
      return false;
    }
    renameSync(temporaryOwnerPath, handle.ownerPath);
    return true;
  } catch {
    try { rmSync(temporaryOwnerPath, { force: true }); } catch {}
    return false;
  }
}

function createOwnedLock(lockPath, heartbeatMs) {
  mkdirSync(lockPath);
  const directoryIdentity = lstatSync(lockPath);
  const token = randomUUID();
  const owner = {
    version: OWNER_VERSION,
    token,
    pid: process.pid,
    startedAt: Date.now(),
    installer: { state: 'idle' },
  };
  const ownerPath = ownerPathFor(lockPath);
  const temporaryOwnerPath = join(lockPath, `.owner-${token}.tmp`);

  try {
    writeFileSync(temporaryOwnerPath, `${JSON.stringify(owner)}\n`, { flag: 'wx' });
    renameSync(temporaryOwnerPath, ownerPath);
  } catch (error) {
    try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
    throw error;
  }

  let heartbeat;
  let heartbeatStopped = false;
  const stopHeartbeat = () => {
    if (heartbeatStopped) return;
    heartbeatStopped = true;
    if (heartbeat) clearInterval(heartbeat);
  };
  const beat = () => {
    if (heartbeatStopped) return;
    try {
      const currentIdentity = lstatSync(lockPath);
      const currentOwner = readOwner(lockPath);
      if (!sameIdentity(currentIdentity, directoryIdentity) || currentOwner?.token !== token) {
        stopHeartbeat();
        return;
      }
      const now = new Date();
      // Updating timestamps rather than rewriting metadata prevents an old
      // owner from overwriting a successor during a replacement race.
      utimesSync(ownerPath, now, now);
      utimesSync(lockPath, now, now);
    } catch {
      stopHeartbeat();
    }
  };

  heartbeat = setInterval(beat, heartbeatMs);
  heartbeat.unref?.();

  return {
    path: lockPath,
    ownerPath,
    token,
    dev: directoryIdentity.dev,
    ino: directoryIdentity.ino,
    stopHeartbeat,
  };
}

function tryCreateOwnedLock(lockPath, heartbeatMs) {
  try {
    return createOwnedLock(lockPath, heartbeatMs);
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
}

/**
 * Acquire an atomic, uniquely-owned install lock. An aged lock is recoverable
 * only when well-formed metadata identifies both the wrapper and any owned
 * installer process/group as conclusively stopped. Missing, malformed,
 * permission-denied, pending-spawn, and otherwise inconclusive states fail
 * closed.
 */
export function acquireInstallLock(
  pluginRoot,
  { staleMs = DEFAULT_STALE_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS } = {},
) {
  const lockPath = lockPathFor(pluginRoot);
  const interval = Number.isFinite(heartbeatMs) && heartbeatMs > 0
    ? heartbeatMs
    : DEFAULT_HEARTBEAT_MS;
  const initial = tryCreateOwnedLock(lockPath, interval);
  if (initial) return initial;

  let inspectedIdentity;
  let ownerMtime;
  try {
    inspectedIdentity = lstatSync(lockPath);
    ownerMtime = statSync(ownerPathFor(lockPath)).mtimeMs;
  } catch {
    // A missing or unreadable metadata file is not evidence that its owner is
    // dead. A concurrently released lock gets one safe create retry.
    if (!existsSync(lockPath)) return tryCreateOwnedLock(lockPath, interval);
    return null;
  }

  if (Date.now() - ownerMtime <= staleMs) return null;
  const owner = readOwner(lockPath);
  if (!owner || !ownerIsConclusivelyStopped(owner)) return null;

  // Revalidate identity, token, age, and liveness immediately before moving
  // the dead lock aside. This keeps a stale observation from deleting a newer
  // owner that won a replacement race.
  try {
    const currentIdentity = lstatSync(lockPath);
    const currentOwner = readOwner(lockPath);
    const currentMtime = statSync(ownerPathFor(lockPath)).mtimeMs;
    if (
      !sameIdentity(currentIdentity, inspectedIdentity) ||
      currentOwner?.token !== owner.token ||
      Date.now() - currentMtime <= staleMs ||
      !ownerIsConclusivelyStopped(currentOwner)
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const quarantinePath = join(pluginRoot, `${LOCK_DIR_NAME}.dead-${randomUUID()}`);
  try {
    renameSync(lockPath, quarantinePath);
  } catch {
    return null;
  }

  try {
    return tryCreateOwnedLock(lockPath, interval);
  } finally {
    try { rmSync(quarantinePath, { recursive: true, force: true }); } catch {}
  }
}

/** Release only the lock still carrying this handle's token and inode. */
export function releaseInstallLock(handle) {
  if (!handle) return false;

  let identity;
  const owner = readOwner(handle.path);
  try {
    identity = lstatSync(handle.path);
  } catch {
    return false;
  }
  if (
    owner?.token !== handle.token ||
    identity.dev !== handle.dev ||
    identity.ino !== handle.ino ||
    (owner.installer.state !== 'idle' && owner.installer.state !== 'stopped')
  ) {
    return false;
  }
  handle.stopHeartbeat?.();

  const releasedPath = `${handle.path}.released-${handle.token}`;
  try {
    renameSync(handle.path, releasedPath);
  } catch {
    return false;
  }

  // Verify the directory moved was still ours before deleting it. In the
  // impossible-to-eliminate final rename race, fail closed rather than delete
  // an unrecognised owner.
  const movedOwner = readOwner(releasedPath);
  if (movedOwner?.token !== handle.token) {
    try {
      if (!existsSync(handle.path)) renameSync(releasedPath, handle.path);
    } catch {}
    return false;
  }
  try {
    rmSync(releasedPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function waitForInstallLock(pluginRoot, { pollMs = 250, timeoutMs = 60_000 } = {}) {
  const lockPath = lockPathFor(pluginRoot);
  const deadline = Date.now() + timeoutMs;
  while (existsSync(lockPath) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return !existsSync(lockPath);
}

function isOwnedGroupStopped(child, directExited, isWindows) {
  if (!directExited) return false;
  if (isWindows || !child.pid) return true;
  try {
    process.kill(-child.pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function runTrackedProcess({
  executable,
  args,
  pluginRoot,
  spawn,
  lockHandle,
  timeoutMs,
  terminationGraceMs,
  successMessage,
  failureMessage,
}) {
  const isWindows = process.platform === 'win32';

  // Persist an ambiguous pre-spawn state first. If this wrapper dies between
  // spawning and recording the child identity, stale-lock recovery must not
  // guess that no installer exists.
  if (lockHandle && !updateOwnedInstaller(lockHandle, { state: 'pending' })) {
    throw new Error(`${failureMessage}: install lock ownership could not be registered`);
  }

  let child;
  try {
    child = spawn(executable, args, {
      cwd: pluginRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: !isWindows,
    });
  } catch (error) {
    if (!lockHandle || updateOwnedInstaller(lockHandle, { state: 'stopped' })) {
      releaseInstallLock(lockHandle);
    }
    throw error;
  }

  const childPid = child?.pid;
  if (lockHandle && Number.isSafeInteger(childPid) && childPid > 0) {
    const runningInstaller = {
      state: 'running',
      pid: childPid,
      groupId: isWindows ? null : childPid,
    };
    if (!updateOwnedInstaller(lockHandle, runningInstaller)) {
      // The child was spawned but cannot safely be tied to this lock. Stop only
      // the child/group we just created and retain the pending lock fail-closed.
      if (!isWindows) {
        try { process.kill(-childPid, 'SIGKILL'); } catch {}
      }
      try { child.kill('SIGKILL'); } catch {}
      throw new Error(`${failureMessage}: installer ownership could not be recorded`);
    }
  }

  let emittedBytes = 0;
  const forwardBounded = data => {
    if (emittedBytes >= OUTPUT_CAP_BYTES) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const allowed = Math.min(bytes.length, OUTPUT_CAP_BYTES - emittedBytes);
    if (allowed > 0) process.stderr.write(bytes.subarray(0, allowed));
    emittedBytes += allowed;
  };
  child.stdout?.on('data', forwardBounded);
  child.stderr?.on('data', forwardBounded);

  let directExited = false;
  let exitCode;
  let exitSignal;
  let spawnError;
  let terminationReason;
  let settled = false;
  let handlersRemoved = false;
  let escalationTimer;
  let stopConfirmationTimer;
  let hardDeadlineTimer;
  let processTimeout;
  let resolvePromise;
  let rejectPromise;

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  function killOwnedProcess(signal) {
    if (!isWindows && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // It may not be a group leader (notably injected test children). Fall
        // back to the direct child without invoking a shell.
      }
    }
    try { child.kill(signal); } catch {}
  }

  function removeHandlers() {
    if (handlersRemoved) return;
    handlersRemoved = true;
    process.removeListener('exit', onProcessExit);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGHUP', onSighup);
  }

  function clearProcessTimers() {
    if (processTimeout) clearTimeout(processTimeout);
    if (escalationTimer) clearTimeout(escalationTimer);
    if (stopConfirmationTimer) clearInterval(stopConfirmationTimer);
    if (hardDeadlineTimer) clearTimeout(hardDeadlineTimer);
  }

  function finish() {
    if (settled) return;
    if (!isOwnedGroupStopped(child, directExited, isWindows)) return;
    if (lockHandle && !updateOwnedInstaller(lockHandle, { state: 'stopped' })) {
      // Ownership changed or metadata could not be persisted. Never release a
      // lock unless this token records that its installer is stopped.
      settled = true;
      clearProcessTimers();
      removeHandlers();
      rejectPromise(new Error(`${failureMessage}: installer stop could not be recorded`));
      return;
    }
    settled = true;
    clearProcessTimers();
    removeHandlers();
    releaseInstallLock(lockHandle);

    if (spawnError) {
      rejectPromise(spawnError);
    } else if (terminationReason) {
      rejectPromise(new Error(`${failureMessage}: ${terminationReason}`));
    } else if (exitCode === 0) {
      if (successMessage) console.error(successMessage);
      resolvePromise();
    } else {
      rejectPromise(new Error(`${failureMessage} with exit code ${exitCode}`));
    }
  }

  function failClosedIfStillRunning() {
    if (settled) return;
    if (isOwnedGroupStopped(child, directExited, isWindows)) {
      finish();
      return;
    }
    // The process or group could not be confirmed stopped. Reject so the
    // wrapper can exit, but deliberately retain the lock and heartbeat rather
    // than permit a concurrent installer to mutate node_modules.
    settled = true;
    clearProcessTimers();
    removeHandlers();
    rejectPromise(new Error(`${failureMessage}: process stop could not be confirmed`));
  }

  function beginStopConfirmation() {
    finish();
    if (settled || stopConfirmationTimer) return;
    stopConfirmationTimer = setInterval(finish, 25);
    stopConfirmationTimer.unref?.();
  }

  function terminate(signal = 'SIGTERM', reason = `terminated by ${signal}`) {
    if (settled || terminationReason) return;
    terminationReason = reason;
    killOwnedProcess(signal);
    escalationTimer = setTimeout(() => {
      if (!settled && !isOwnedGroupStopped(child, directExited, isWindows)) {
        killOwnedProcess('SIGKILL');
      }
    }, terminationGraceMs);
    escalationTimer.unref?.();
    hardDeadlineTimer = setTimeout(failClosedIfStillRunning, terminationGraceMs + STOP_CONFIRM_MS);
    hardDeadlineTimer.unref?.();
  }

  function onProcessExit() {
    if (settled) return;
    terminationReason ||= 'parent process exited';
    killOwnedProcess('SIGKILL');
    // An exit listener cannot await. Release only if child exit and group
    // death were already observed synchronously; otherwise leave recovery to
    // the conclusively-dead-owner protocol on the next startup.
    finish();
  }
  function onSigterm() { terminate('SIGTERM'); }
  function onSigint() { terminate('SIGINT'); }
  function onSighup() { terminate('SIGHUP'); }

  process.on('exit', onProcessExit);
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  process.on('SIGHUP', onSighup);

  child.on('exit', (code, signal) => {
    if (settled) return;
    directExited = true;
    exitCode = code;
    exitSignal = signal;
    if (signal && !terminationReason) terminationReason = `terminated by ${signal}`;
    if (!isOwnedGroupStopped(child, directExited, isWindows)) {
      killOwnedProcess('SIGTERM');
      escalationTimer ||= setTimeout(() => killOwnedProcess('SIGKILL'), terminationGraceMs);
      escalationTimer.unref?.();
      hardDeadlineTimer ||= setTimeout(failClosedIfStillRunning, terminationGraceMs + STOP_CONFIRM_MS);
      hardDeadlineTimer.unref?.();
    }
    beginStopConfirmation();
  });

  child.on('error', error => {
    if (settled) return;
    spawnError = error;
    directExited = true;
    beginStopConfirmation();
  });

  processTimeout = setTimeout(
    () => terminate('SIGTERM', `timed out after ${timeoutMs}ms`),
    timeoutMs,
  );
  processTimeout.unref?.();

  return { promise, terminate };
}

export function runNpmInstall(
  pluginRoot,
  {
    spawn = defaultSpawn,
    lockHandle,
    timeoutMs = INSTALL_TIMEOUT_MS,
    terminationGraceMs = TERMINATION_GRACE_MS,
  } = {},
) {
  const launch = resolveNpmInstallLaunch();
  console.error('Installing episodic-memory dependencies (first run only)...');
  console.error('This may take 30-60 seconds...');

  const tracked = runTrackedProcess({
    executable: launch.executable,
    args: launch.args,
    pluginRoot,
    spawn,
    lockHandle,
    timeoutMs,
    terminationGraceMs,
    successMessage: 'Dependencies installed successfully.',
    failureMessage: 'npm install failed',
  });
  tracked.promise.catch(error => {
    if (!error.message.includes('terminated') && !error.message.includes('timed out')) {
      console.error('ERROR: Failed to install dependencies.');
      console.error(`Please run manually: cd "${pluginRoot}" && npm install`);
    }
  });
  return tracked;
}

/** Run the fixed native-repair script under the same lock/process lifecycle. */
export function runNodeRepair(
  pluginRoot,
  {
    spawn = defaultSpawn,
    lockHandle,
    timeoutMs = INSTALL_TIMEOUT_MS,
    terminationGraceMs = TERMINATION_GRACE_MS,
  } = {},
) {
  return runTrackedProcess({
    executable: process.execPath,
    args: [join(pluginRoot, 'scripts', 'reinstall-native.js')],
    pluginRoot,
    spawn,
    lockHandle,
    timeoutMs,
    terminationGraceMs,
    successMessage: 'Native dependency repaired successfully.',
    failureMessage: 'native dependency repair failed',
  });
}
