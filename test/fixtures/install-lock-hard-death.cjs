'use strict';

const { writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function runWrapper() {
  const pluginRoot = requiredEnvironment('HARD_DEATH_PLUGIN_ROOT');
  const runnerPath = requiredEnvironment('HARD_DEATH_INSTALL_RUNNER');
  const wrapperReceipt = requiredEnvironment('HARD_DEATH_WRAPPER_RECEIPT');
  const { acquireInstallLock, runNodeRepair } = await import(pathToFileURL(runnerPath).href);
  const lock = acquireInstallLock(pluginRoot, { heartbeatMs: 20 });
  if (!lock) throw new Error('fixture could not acquire install lock');

  const repair = runNodeRepair(pluginRoot, {
    lockHandle: lock,
    timeoutMs: 60_000,
    terminationGraceMs: 100,
  });
  writeFileSync(wrapperReceipt, `${process.pid}\n`, { flag: 'wx' });
  await repair.promise;
}

function runInstaller() {
  const installerReceipt = requiredEnvironment('HARD_DEATH_INSTALLER_RECEIPT');
  writeFileSync(installerReceipt, `${process.pid}\n`, { flag: 'wx' });
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1_000);
}

if (process.argv[2] === '--wrapper') {
  runWrapper().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
} else {
  runInstaller();
}
