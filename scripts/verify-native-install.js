#!/usr/bin/env node
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { findMissingDeps, probeBetterSqlite3 } from '../cli/install-check.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromRoot = createRequire(join(packageRoot, 'package.json'));
const wrapperPath = join(packageRoot, 'cli', 'mcp-server-wrapper.js');
const sqlitePackagePath = join(packageRoot, 'node_modules', 'better-sqlite3');
const scenarios = new Set(['fresh', 'missing-dependency', 'missing-binding', 'invalid-binding']);

function bindingPaths(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...bindingPaths(path));
    else if (entry.isFile() && entry.name.endsWith('.node')) paths.push(path);
  }
  return paths;
}

function assertHealthy() {
  const missing = findMissingDeps(packageRoot);
  if (missing.length > 0) throw new Error(`missing dependencies: ${missing.join(', ')}`);
  const native = probeBetterSqlite3(packageRoot);
  if (!native.ok) throw new Error(`better-sqlite3 probe failed:\n${native.error}`);
}

function verifyFreshRuntime() {
  const onnx = requireFromRoot('onnxruntime-node');
  if (typeof onnx.InferenceSession?.create !== 'function') throw new Error('onnxruntime-node did not expose InferenceSession.create');

  const Database = requireFromRoot('better-sqlite3');
  const sqliteVec = requireFromRoot('sqlite-vec');
  const database = new Database(':memory:');
  try {
    sqliteVec.load(database);
    const row = database.prepare('SELECT vec_version() AS version').get();
    if (typeof row?.version !== 'string') throw new Error('sqlite-vec did not return its version');
  } finally {
    database.close();
  }
}

function damageInstall(scenario) {
  if (scenario === 'missing-dependency') {
    rmSync(join(packageRoot, 'node_modules', 'onnxruntime-node', 'package.json'));
    return;
  }

  if (scenario === 'missing-binding' || scenario === 'invalid-binding') {
    const paths = bindingPaths(sqlitePackagePath);
    if (paths.length === 0) throw new Error('no better-sqlite3 native binding was installed');
    for (const path of paths) {
      if (scenario === 'missing-binding') rmSync(path);
      else writeFileSync(path, 'not a native binding');
    }
  }
}

function count(text, fragment) {
  return text.split(fragment).length - 1;
}

function runWrapper(scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath], {
      cwd: packageRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let output = '';
    let ready = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP wrapper timed out:\n${output}`));
    }, 120_000);

    const capture = data => {
      const text = data.toString();
      output += text;
      process.stderr.write(text);
      if (!ready && output.includes('Episodic Memory MCP server running via stdio')) {
        ready = true;
        child.stdin.end();
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (!ready) reject(new Error(`MCP server did not start (code=${code}, signal=${signal}):\n${output}`));
      else if (code !== 0) reject(new Error(`MCP wrapper did not exit cleanly (code=${code}, signal=${signal}):\n${output}`));
      else resolve(output);
    });
  }).then(output => {
    if (scenario === 'fresh' && output.includes('dependencies are unhealthy')) {
      throw new Error('fresh install unexpectedly needed repair');
    }
    if (scenario === 'missing-dependency' && count(output, 'Installing episodic-memory dependencies...') !== 1) {
      throw new Error('missing dependency was not repaired exactly once');
    }
    if ((scenario === 'missing-binding' || scenario === 'invalid-binding') && count(output, 'episodic-memory: better-sqlite3 is ready under') !== 1) {
      throw new Error('native dependency was not repaired exactly once');
    }
  });
}

async function main() {
  const scenario = process.argv[2];
  if (!scenarios.has(scenario)) throw new Error(`usage: ${process.execPath} scripts/verify-native-install.js <${[...scenarios].join('|')}>`);

  assertHealthy();
  if (scenario === 'fresh') verifyFreshRuntime();
  else damageInstall(scenario);
  await runWrapper(scenario);
  assertHealthy();
  console.error(`episodic-memory: verified native install scenario ${scenario}`);
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
