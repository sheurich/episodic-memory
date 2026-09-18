import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import packageJson from '../package.json';
import { REQUIRED_PACKAGES, probeBetterSqlite3 } from '../cli/install-check.js';

const goodSqliteModule = `
module.exports = class Database {
  prepare(sql) {
    if (sql !== 'SELECT 42 AS n') throw new Error('unexpected SQL: ' + sql);
    return { get: () => ({ n: 42 }) };
  }
  close() {}
};
`;

function stageDependencies(root: string, sqliteModule: string): void {
  for (const name of REQUIRED_PACKAGES) {
    const packageDir = join(root, 'node_modules', name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name,
      version: '0.0.0',
      ...(name === 'better-sqlite3' ? { main: 'index.cjs' } : {}),
    }));
    if (name === 'better-sqlite3') writeFileSync(join(packageDir, 'index.cjs'), sqliteModule);
  }
}

function stageWrapperFixture(sqliteModule: string, repair: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'episodic-memory-wrapper-'));
  mkdirSync(join(root, 'cli'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, 'cli', 'install-check.js'), readFileSync(new URL('../cli/install-check.js', import.meta.url)));
  writeFileSync(join(root, 'cli', 'install-runner.js'), readFileSync(new URL('../cli/install-runner.js', import.meta.url)));
  writeFileSync(join(root, 'cli', 'mcp-server-wrapper.js'), readFileSync(new URL('../cli/mcp-server-wrapper.js', import.meta.url)));
  writeFileSync(join(root, 'scripts', 'reinstall-native.js'), readFileSync(new URL('../scripts/reinstall-native.js', import.meta.url)));
  writeFileSync(join(root, 'dist', 'mcp-server.js'), `import { writeFileSync } from 'fs'; writeFileSync(${JSON.stringify(join(root, 'server-started'))}, 'yes');`);
  stageDependencies(root, sqliteModule);

  const npmPath = join(root, 'bin', process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const packageDir = join(root, 'node_modules', 'better-sqlite3');
  const stagedManifests = REQUIRED_PACKAGES.map(name => ({
    directory: join(root, 'node_modules', name),
    contents: JSON.stringify({
      name,
      version: '0.0.0',
      ...(name === 'better-sqlite3' ? { main: 'index.cjs' } : {}),
    }),
  }));
  const npmScript = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
appendFileSync(${JSON.stringify(join(root, 'npm-runs'))}, process.argv.slice(2).join(' ') + '\\n');
for (const manifest of ${JSON.stringify(stagedManifests)}) {
  mkdirSync(manifest.directory, { recursive: true });
  writeFileSync(manifest.directory + '/package.json', manifest.contents);
}
writeFileSync(${JSON.stringify(join(packageDir, 'index.cjs'))}, ${JSON.stringify(repair ? goodSqliteModule : sqliteModule)});
`;
  if (process.platform === 'win32') {
    writeFileSync(npmPath, `@"${process.execPath}" "${join(root, 'bin', 'npm.mjs')}" %*\r\n`);
    writeFileSync(join(root, 'bin', 'npm.mjs'), npmScript.replace(/^#!.*\n/, ''));
  } else {
    writeFileSync(npmPath, npmScript);
    chmodSync(npmPath, 0o755);
  }

  return root;
}

function runWrapper(root: string, claudePluginRoot = root) {
  return spawnSync(process.execPath, [join(root, 'cli', 'mcp-server-wrapper.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: claudePluginRoot,
      PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
    },
  });
}

describe('npm 12 native install policy', () => {
  it('approves only the better-sqlite3 dependency install script', () => {
    expect(packageJson.allowScripts['better-sqlite3']).toBe(true);
  });

  it('uses a cross-platform repair script without a pinned Node version', () => {
    expect(packageJson.scripts['rebuild:native']).toBe('node scripts/reinstall-native.js');
  });

  it('does not start a nested npm rebuild from postinstall', () => {
    expect(packageJson.scripts).not.toHaveProperty('postinstall');
  });
});

describe('better-sqlite3 native health probe', () => {
  it('loads the package in the requested Node process and exercises an in-memory query', () => {
    const root = mkdtempSync(join(tmpdir(), 'episodic-memory-probe-'));
    try {
      stageDependencies(root, goodSqliteModule);
      expect(probeBetterSqlite3(root)).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a manifest-present package whose binding cannot load', () => {
    const root = mkdtempSync(join(tmpdir(), 'episodic-memory-probe-'));
    try {
      stageDependencies(root, `throw new Error('Could not locate the bindings file');`);
      const result = probeBetterSqlite3(root);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Could not locate the bindings file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MCP server wrapper native repair', () => {
  const repairCommand = 'install --package-lock=false --no-audit --no-fund\n';

  it('uses its own package root when CLAUDE_PLUGIN_ROOT points elsewhere', () => {
    const root = stageWrapperFixture(goodSqliteModule, false);
    try {
      const result = runWrapper(root, join(root, 'wrong-package'));
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, 'server-started'), 'utf8')).toBe('yes');
      expect(() => readFileSync(join(root, 'npm-runs'))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('installs missing dependencies without consulting a stale lockfile, rechecks, and starts the server', () => {
    const root = stageWrapperFixture(goodSqliteModule, true);
    try {
      rmSync(join(root, 'node_modules', 'onnxruntime-node'), { recursive: true, force: true });
      writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
      const result = runWrapper(root);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, 'npm-runs'), 'utf8')).toBe(repairCommand);
      expect(readFileSync(join(root, 'server-started'), 'utf8')).toBe('yes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reinstalls only the native dependency without consulting a stale lockfile, rechecks, and starts the server', () => {
    const root = stageWrapperFixture(`throw new Error('missing native binding');`, true);
    try {
      const result = runWrapper(root);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, 'npm-runs'), 'utf8')).toBe(repairCommand);
      expect(readFileSync(join(root, 'server-started'), 'utf8')).toBe('yes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs only once and refuses to start when the binding remains unhealthy', () => {
    const root = stageWrapperFixture(`throw new Error('missing native binding');`, false);
    try {
      const result = runWrapper(root);
      expect(result.status).toBe(1);
      expect(readFileSync(join(root, 'npm-runs'), 'utf8')).toBe(repairCommand);
      expect(() => readFileSync(join(root, 'server-started'))).toThrow();
      expect(result.stderr).toContain('still unhealthy after npm install');
      expect(result.stderr).toContain(process.execPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
