import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import packageJson from '../package.json';

const root = join(import.meta.dirname, '..');
const workflowPath = join(root, '.github', 'workflows', 'native-install.yml');
const verifierPath = join(root, 'scripts', 'verify-native-install.js');

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

describe('native install dependency policy', () => {
  it('declares better-sqlite3 13.x without restricting package engines', () => {
    expect(packageJson.dependencies['better-sqlite3']).toBe('^13.0.3');
    expect(packageJson).not.toHaveProperty('engines');
    expect(packageJson.allowScripts['better-sqlite3']).toBe(true);
  });
});

describe('native install CI workflow', () => {
  it('defines exactly the six supported OS and Node combinations on native runner architectures', () => {
    const workflow = read(workflowPath);
    const osValues = workflow.match(/^\s*os:\s*\[([^\]]+)\]/m)?.[1].split(',').map(value => value.trim());
    const nodeValues = workflow.match(/^\s*node:\s*\[([^\]]+)\]/m)?.[1].split(',').map(value => value.trim());

    expect(osValues).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
    expect(nodeValues).toEqual(['24.15.0', '26.x']);
    expect((osValues?.length ?? 0) * (nodeValues?.length ?? 0)).toBe(6);
    expect(workflow).toContain('runs-on: ${{ matrix.os }}');
    expect(workflow.match(/^\s*runs-on:/gm)).toHaveLength(1);
    expect(workflow).not.toMatch(/^\s+(?:include|exclude):/m);
    expect(workflow).not.toContain('architecture:');
    expect(workflow).toContain('permissions:\n  contents: read');
  });

  it('uses the required actions, npm version, and lockfile-free clean install', () => {
    const workflow = read(workflowPath);

    expect(workflow).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1');
    expect(workflow).toContain('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020  # v7.0.0');
    expect(workflow).not.toMatch(/uses:\s+actions\/(?:checkout|setup-node)@v\d/);
    expect(workflow).toContain('npm@12.0.2');
    expect(workflow).toMatch(/- name: Start clean[\s\S]*?\n\s+run: >-\n\s+node -e/);
    expect(workflow).toContain("for (const path of ['node_modules', 'package-lock.json'])");
    expect(workflow).toContain('npm install --package-lock=false --no-audit --no-fund');
    expect(workflow).not.toContain('npm ci');
    expect(workflow).not.toMatch(/^\s*cache:/m);
  });

  it('verifies tool versions, builds, covers every real native scenario, and runs tests serially', () => {
    const workflow = read(workflowPath);

    expect(workflow).toMatch(/- name: Verify Node and npm versions[\s\S]*?\n\s+run: >-\n\s+node -e/);
    expect(workflow).toContain('process.versions.node');
    expect(workflow).toContain("'12.0.2'");
    expect(workflow).toContain('npm run build');
    for (const scenario of ['fresh', 'missing-dependency', 'missing-binding', 'invalid-binding']) {
      expect(workflow).toContain(`node scripts/verify-native-install.js ${scenario}`);
    }
    expect(workflow).toContain('npm test -- --maxWorkers=1');
  });
});

describe('real native install verifier', () => {
  it('uses the normal wrapper and covers runtime loads and all damage modes cross-platform', () => {
    const verifier = read(verifierPath);

    expect(verifier).toContain('process.execPath');
    expect(verifier).toContain("'cli', 'mcp-server-wrapper.js'");
    expect(verifier).toContain("requireFromRoot('onnxruntime-node')");
    expect(verifier).toContain("requireFromRoot('sqlite-vec')");
    expect(verifier).toContain('missing-dependency');
    expect(verifier).toContain("rmSync(join(packageRoot, 'node_modules', 'onnxruntime-node'), { recursive: true, force: true })");
    expect(verifier).not.toContain("'onnxruntime-node', 'package.json'");
    expect(verifier).toContain('missing-binding');
    expect(verifier).toContain('invalid-binding');
    expect(verifier).toContain("entry.name.endsWith('.node')");
    expect(verifier).toContain('child.stdin.end()');
    expect(verifier).not.toMatch(/\bshell\s*:\s*true|\bfind\b|\bbash\b/);
  });
});
