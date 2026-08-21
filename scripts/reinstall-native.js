#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { probeBetterSqlite3 } from '../cli/install-check.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = join(packageRoot, 'node_modules', 'better-sqlite3');
const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'cmd.exe' : 'npm';
const npmArgs = isWindows
  ? ['/d', '/s', '/c', 'npm.cmd', 'install', '--no-audit', '--no-fund']
  : ['install', '--no-audit', '--no-fund'];

rmSync(modulePath, { recursive: true, force: true });

const npmEnv = { ...process.env };
for (const key of Object.keys(npmEnv)) {
  if (key.toLowerCase() === 'npm_config_allow_scripts') delete npmEnv[key];
}

const install = spawnSync(npmCommand, npmArgs, {
  cwd: packageRoot,
  env: npmEnv,
  stdio: 'inherit',
  shell: false,
});

if (install.status !== 0) {
  console.error(`episodic-memory: native dependency install failed (status=${install.status})`);
  process.exit(install.status ?? 1);
}

const probe = probeBetterSqlite3(packageRoot);
if (!probe.ok) {
  console.error(`episodic-memory: better-sqlite3 remains unusable under ${process.execPath}`);
  console.error(probe.error);
  process.exit(1);
}

console.error(`episodic-memory: better-sqlite3 is ready under ${process.execPath}`);
