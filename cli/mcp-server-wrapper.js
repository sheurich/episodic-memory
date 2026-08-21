#!/usr/bin/env node
/**
 * Cross-platform wrapper that verifies dependencies before starting the MCP server.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { findMissingDeps, probeBetterSqlite3 } from './install-check.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, '..');

function runNpmInstall() {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const npmCommand = isWindows ? 'cmd.exe' : 'npm';
    const npmArgs = isWindows
      ? ['/d', '/s', '/c', 'npm.cmd', 'install', '--package-lock=false', '--no-audit', '--no-fund']
      : ['install', '--package-lock=false', '--no-audit', '--no-fund'];

    console.error('Installing episodic-memory dependencies...');
    console.error('This may take 30-60 seconds...');

    const child = spawn(npmCommand, npmArgs, {
      cwd: PLUGIN_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    child.stdout.on('data', data => process.stderr.write(data));
    child.stderr.on('data', data => process.stderr.write(data));
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        console.error('Dependencies installed successfully.');
        resolve();
      } else {
        reject(new Error(`npm install failed with exit code ${code}`));
      }
    });
  });
}

function runNativeRepair() {
  return new Promise((resolve, reject) => {
    const repairScript = join(PLUGIN_ROOT, 'scripts', 'reinstall-native.js');
    const child = spawn(process.execPath, [repairScript], {
      cwd: PLUGIN_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    child.stdout.on('data', data => process.stderr.write(data));
    child.stderr.on('data', data => process.stderr.write(data));
    child.on('error', reject);
    child.on('exit', code => resolve(code));
  });
}

function checkInstallHealth() {
  const missing = findMissingDeps(PLUGIN_ROOT);
  if (missing.length > 0) {
    return {
      ok: false,
      kind: 'missing',
      error: `missing dependencies under node_modules: ${missing.join(', ')}`,
    };
  }

  const native = probeBetterSqlite3(PLUGIN_ROOT);
  if (!native.ok) {
    return {
      ok: false,
      kind: 'native',
      error: `better-sqlite3 failed under ${process.execPath}:\n${native.error}`,
    };
  }

  return { ok: true };
}

function startServer() {
  const mcpServerPath = join(PLUGIN_ROOT, 'dist', 'mcp-server.js');
  if (!existsSync(mcpServerPath)) {
    throw new Error(`MCP server not found at ${mcpServerPath}. Please run: npm run build`);
  }

  const child = spawn(process.execPath, [mcpServerPath], {
    stdio: 'inherit',
    shell: false,
  });

  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGHUP', () => child.kill('SIGHUP'));
  process.stdin.on('end', () => {
    child.kill();
    process.exit(0);
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code || 0);
  });
  child.on('error', err => {
    console.error(`ERROR: Failed to start MCP server: ${err.message}`);
    process.exit(1);
  });
}

async function main() {
  let health = checkInstallHealth();
  if (!health.ok) {
    console.error(`Episodic-memory dependencies are unhealthy: ${health.error}`);
    if (health.kind === 'native') await runNativeRepair();
    else await runNpmInstall();
    health = checkInstallHealth();
  }

  if (!health.ok) {
    throw new Error(
      `Episodic-memory dependencies are still unhealthy after npm install: ${health.error}\n` +
      `Recovery: cd "${PLUGIN_ROOT}" && npm run rebuild:native, using the npm paired with ${process.execPath}`
    );
  }

  startServer();
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
