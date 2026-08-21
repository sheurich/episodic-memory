import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Runtime-required packages externalized from the MCP server bundle (see the
 * `bundle` script in package.json). The bundle inline-imports these at runtime
 * via Node's resolver, so a partial node_modules extraction — directory exists
 * but the package is missing its package.json and lib/ — surfaces as a
 * confusing `ERR_MODULE_NOT_FOUND` *after* the wrapper has already declared
 * dependencies healthy and launched the server (#95 Bug 1).
 *
 * Excludes optional / OS-specific externals (sharp, fsevents) — missing those
 * is not necessarily fatal.
 */
export const REQUIRED_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@huggingface/transformers',
  'better-sqlite3',
  'onnxruntime-node',
  'proper-lockfile',
  'sqlite-vec',
];

/**
 * Return the list of required packages whose package.json is missing under
 * `<pluginRoot>/node_modules`. An empty array means the install looks complete;
 * a non-empty array is the diagnostic to print before re-running `npm install`.
 *
 * Probing each package's package.json — not just the directory — catches
 * partial extractions where the folder exists but the manifest hasn't been
 * written yet (the failure mode reported for episodic-memory@1.4.1 on Windows
 * 11 in #95).
 */
export function findMissingDeps(pluginRoot) {
  const nodeModules = join(pluginRoot, 'node_modules');
  if (!existsSync(nodeModules)) {
    return REQUIRED_PACKAGES.slice();
  }
  return REQUIRED_PACKAGES.filter(pkg => !existsSync(join(nodeModules, pkg, 'package.json')));
}

const BETTER_SQLITE3_PROBE = `
const { createRequire } = require('module');
const { join } = require('path');
const requireFromPlugin = createRequire(join(process.argv[1], 'package.json'));
const Database = requireFromPlugin('better-sqlite3');
const db = new Database(':memory:');
try {
  const row = db.prepare('SELECT 42 AS n').get();
  if (row.n !== 42) throw new Error('better-sqlite3 returned an unexpected result');
} finally {
  db.close();
}
`;

/**
 * Load and exercise better-sqlite3 in an isolated process using the exact Node
 * executable that will run the MCP server.
 */
export function probeBetterSqlite3(pluginRoot) {
  const result = spawnSync(process.execPath, ['-e', BETTER_SQLITE3_PROBE, pluginRoot], {
    cwd: pluginRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status === 0) return { ok: true };

  const detail = [result.stderr, result.stdout, result.error?.message]
    .filter(Boolean)
    .map(value => value.trim())
    .filter(Boolean)
    .join('\n');
  return {
    ok: false,
    error: detail || `native probe exited with status ${result.status}`,
  };
}
