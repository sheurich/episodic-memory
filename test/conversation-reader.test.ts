import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createConversationReader } from '../src/conversation-reader.js';

function claudeLine(content: string, uuid: string): string {
  return JSON.stringify({
    uuid,
    parentUuid: null,
    timestamp: '2026-10-13T12:00:00.000Z',
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content },
  });
}

async function expectReadError(
  reader: ReturnType<typeof createConversationReader>,
  request: any,
  code: string,
): Promise<void> {
  await expect(reader.readConversation(request)).rejects.toMatchObject({ code });
}

describe('bounded native conversation reader', () => {
  let sandbox: string;
  let archiveRoot: string;
  let outsideRoot: string;

  beforeEach(() => {
    const scratch = join(process.cwd(), '.swival', 'deployment-fixes', 'test-tmp');
    mkdirSync(scratch, { recursive: true });
    sandbox = mkdtempSync(join(scratch, 'conversation-reader-'));
    archiveRoot = join(sandbox, 'archive');
    outsideRoot = join(sandbox, 'archive-outside');
    mkdirSync(archiveRoot);
    mkdirSync(outsideRoot);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it.each([
    ['outside path', () => join(outsideRoot, 'secret.jsonl')],
    ['root-prefix confusion', () => join(`${archiveRoot}-outside`, 'secret.jsonl')],
    ['parent traversal', () => join(archiveRoot, '..', 'archive-outside', 'secret.jsonl')],
  ])('rejects %s before reading it', async (_label, pathFor) => {
    const secretPath = pathFor();
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, claudeLine('outside secret', 'outside'));

    const reader = createConversationReader(archiveRoot);
    await expectReadError(reader, { path: secretPath, startLine: 1, endLine: 1 }, 'path_outside_archive');
  });

  it('rejects file and directory symlinks that escape the archive', async () => {
    const outsideFile = join(outsideRoot, 'session.jsonl');
    writeFileSync(outsideFile, claudeLine('outside secret', 'outside'));

    const fileLink = join(archiveRoot, 'linked-file.jsonl');
    const directoryLink = join(archiveRoot, 'linked-directory');
    symlinkSync(outsideFile, fileLink);
    symlinkSync(outsideRoot, directoryLink, 'dir');

    const reader = createConversationReader(archiveRoot);
    await expectReadError(reader, { path: fileLink, startLine: 1, endLine: 1 }, 'symlink_not_allowed');
    await expectReadError(
      reader,
      { path: join(directoryLink, 'session.jsonl'), startLine: 1, endLine: 1 },
      'symlink_not_allowed',
    );
  });

  it.each([
    [{ path: 'session.jsonl', endLine: 1 }, 'invalid_line_window'],
    [{ path: 'session.jsonl', startLine: 1 }, 'invalid_line_window'],
    [{ path: 'session.jsonl', startLine: 0, endLine: 1 }, 'invalid_line_window'],
    [{ path: 'session.jsonl', startLine: 1.5, endLine: 2 }, 'invalid_line_window'],
    [{ path: 'session.jsonl', startLine: Number.MAX_SAFE_INTEGER + 1, endLine: Number.MAX_SAFE_INTEGER + 1 }, 'invalid_line_window'],
    [{ path: 'session.jsonl', startLine: 4, endLine: 3 }, 'invalid_line_window'],
    [{ path: 'session.jsonl', startLine: 1, endLine: 41 }, 'line_window_too_large'],
  ])('rejects invalid line window %#', async (request, code) => {
    writeFileSync(join(archiveRoot, 'session.jsonl'), claudeLine('valid', 'valid'));
    const reader = createConversationReader(archiveRoot);
    await expectReadError(reader, request, code);
  });

  it('requires a regular .jsonl file', async () => {
    mkdirSync(join(archiveRoot, 'directory.jsonl'));
    writeFileSync(join(archiveRoot, 'not-jsonl.txt'), claudeLine('wrong extension', 'wrong'));
    const reader = createConversationReader(archiveRoot);

    await expectReadError(
      reader,
      { path: join(archiveRoot, 'directory.jsonl'), startLine: 1, endLine: 1 },
      'not_regular_jsonl',
    );
    await expectReadError(
      reader,
      { path: join(archiveRoot, 'not-jsonl.txt'), startLine: 1, endLine: 1 },
      'not_regular_jsonl',
    );
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO before an open can block', () => {
    const fifo = join(archiveRoot, 'fifo.jsonl');
    const created = spawnSync('mkfifo', [fifo], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024,
    });
    expect(created.status, created.stderr).toBe(0);
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', join(process.cwd(), 'test/fixtures/read-conversation-file.ts'),
      archiveRoot, fifo,
    ], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 1_500, maxBuffer: 64 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe('not_regular_jsonl');
  });

  it('caps selected input instead of reading or truncating an oversized JSONL line', async () => {
    const path = join(archiveRoot, 'oversized-line.jsonl');
    writeFileSync(path, `${'x'.repeat(64 * 1024 + 1)}\n`);

    const reader = createConversationReader(archiveRoot);
    await expectReadError(reader, { path, startLine: 1, endLine: 1 }, 'selected_input_too_large');
  });

  it('stops scanning a sparse huge file at the fixed 64 MiB cap', async () => {
    const path = join(archiveRoot, 'huge.jsonl');
    const fd = openSync(path, 'w');
    try {
      ftruncateSync(fd, 64 * 1024 * 1024 + 1);
    } finally {
      closeSync(fd);
    }

    const reader = createConversationReader(archiveRoot);
    await expectReadError(reader, { path, startLine: 2, endLine: 2 }, 'scan_limit_exceeded');
  });

  it('honors an already-aborted signal before filesystem validation', async () => {
    const controller = new AbortController();
    controller.abort();
    const reader = createConversationReader(archiveRoot);

    await expect(
      reader.readConversation(
        { path: join(archiveRoot, 'missing.jsonl'), startLine: 1, endLine: 1 },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('honors cancellation while asynchronously scanning', async () => {
    const path = join(archiveRoot, 'cancel.jsonl');
    const fd = openSync(path, 'w');
    try {
      ftruncateSync(fd, 32 * 1024 * 1024);
    } finally {
      closeSync(fd);
    }
    const controller = new AbortController();
    const reader = createConversationReader(archiveRoot);
    const pending = reader.readConversation({ path, startLine: 2, endLine: 2 }, controller.signal);
    setTimeout(() => controller.abort(), 0);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses physical JSONL line numbers and preserves Unicode across read chunks', async () => {
    const path = join(archiveRoot, 'unicode.jsonl');
    const first = claudeLine('padding-' + 'a'.repeat(20 * 1024), 'first');
    const third = claudeLine('Unicode survives: café 🦊 東京', 'third');
    writeFileSync(path, `${first}\n\n${third}\n`);

    const reader = createConversationReader(archiveRoot);
    const result = await reader.readConversation({ path, startLine: 3, endLine: 3 });

    expect(result.markdown).toContain('Unicode survives: café 🦊 東京');
    expect(result.markdown).not.toContain('padding-');
    expect(result.linesRead).toBe(1);
  });

  it('uses the archived OMP session header to keep a headerless message window private', async () => {
    const path = join(archiveRoot, 'omp-window.jsonl');
    const lines = [
      {
        type: 'session',
        id: 'omp-session-window',
        timestamp: '2026-10-13T12:00:00.000Z',
        cwd: '/work/omp-window',
      },
      {
        type: 'message',
        id: 'system',
        parentId: null,
        timestamp: '2026-10-13T12:00:00.500Z',
        message: { role: 'system', content: 'PRIVATE_OMP_SYSTEM_CHAIN_MARKER' },
      },
      {
        type: 'message',
        id: 'user',
        parentId: 'system',
        timestamp: '2026-10-13T12:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'OMP window user text.' }] },
      },
      {
        type: 'message',
        id: 'assistant',
        parentId: 'user',
        timestamp: '2026-10-13T12:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'PRIVATE_OMP_THINKING_SECRET_MARKER' },
            { type: 'text', text: 'OMP window assistant text.' },
          ],
        },
      },
    ];
    writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n'));

    const reader = createConversationReader(archiveRoot);
    const result = await reader.readConversation({ path, startLine: 3, endLine: 4 });

    expect(result.markdown).toContain('**Harness:** Oh My Pi (OMP)');
    expect(result.markdown).toContain('OMP window user text.');
    expect(result.markdown).toContain('OMP window assistant text.');
    expect(result.markdown).not.toContain('PRIVATE_OMP_THINKING_SECRET_MARKER');
    expect(result.markdown).not.toContain('PRIVATE_OMP_SYSTEM_CHAIN_MARKER');
    expect(result.linesRead).toBe(2);
  });

  it.each(['model_change', 'thinking_level_change'])('keeps OMP privacy when a window contains %s', async (type) => {
    const file = join(archiveRoot, 'omp-control-window.jsonl');
    const lines = [
      { type: 'session', id: 'omp-controls', cwd: '/synthetic' },
      { type, provider: 'synthetic', modelId: 'fixture', thinkingLevel: 'high' },
      { type: 'message', id: 'system', parentId: null,
        message: { role: 'system', content: 'PRIVATE_CONTROL_SYSTEM' } },
      { type: 'message', id: 'user', parentId: 'system',
        message: { role: 'user', content: 'Selected control-window user.' } },
      { type: 'message', id: 'assistant', parentId: 'user', message: {
        role: 'assistant', content: [
          { type: 'thinking', thinking: 'PRIVATE_CONTROL_THINKING' },
          { type: 'text', text: 'Selected control-window answer.' },
        ],
      } },
    ];
    writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'));
    const result = await createConversationReader(archiveRoot).readConversation({
      path: file, startLine: 2, endLine: 5,
    });
    expect(result.markdown).toContain('**Harness:** Oh My Pi (OMP)');
    expect(result.markdown).toContain('Selected control-window answer.');
    expect(result.markdown).not.toContain('PRIVATE_CONTROL_THINKING');
    expect(result.markdown).not.toContain('PRIVATE_CONTROL_SYSTEM');
  });

  it('fails closed for an ambiguous bare session header instead of exposing thinking', async () => {
    const path = join(archiveRoot, 'ambiguous-window.jsonl');
    const lines = [
      { type: 'session', id: 'ambiguous-session', cwd: '/work/ambiguous', version: 'unknown' },
      {
        type: 'message', id: 'user', parentId: null,
        message: { role: 'user', content: [{ type: 'text', text: 'Ambiguous user text.' }] },
      },
      {
        type: 'message', id: 'assistant', parentId: 'user',
        message: { role: 'assistant', content: [
          { type: 'thinking', thinking: 'PRIVATE_AMBIGUOUS_THINKING_MARKER' },
          { type: 'text', text: 'Ambiguous assistant text.' },
        ] },
      },
    ];
    writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n'));

    const reader = createConversationReader(archiveRoot);
    const result = await reader.readConversation({ path, startLine: 2, endLine: 3 });

    expect(result.markdown).toContain('Ambiguous user text.');
    expect(result.markdown).toContain('Ambiguous assistant text.');
    expect(result.markdown).not.toContain('PRIVATE_AMBIGUOUS_THINKING_MARKER');
  });

  it('keeps trusted header metadata within the fixed 64 KiB formatter input limit', async () => {
    const path = join(archiveRoot, 'bounded-header-window.jsonl');
    const header = JSON.stringify({ type: 'session', id: 'omp-bounded-header' });
    const message = {
      type: 'message', id: 'assistant', parentId: null,
      message: { role: 'assistant', content: [{ type: 'text', text: '' }] },
    };
    const emptyMessage = JSON.stringify(message);
    message.message.content[0].text = 'x'.repeat(64 * 1024 - Buffer.byteLength(emptyMessage));
    expect(Buffer.byteLength(JSON.stringify(message))).toBe(64 * 1024);
    writeFileSync(path, `${header}\n${JSON.stringify(message)}`);

    const reader = createConversationReader(archiveRoot);
    await expectReadError(reader, { path, startLine: 2, endLine: 2 }, 'selected_input_too_large');
  });

  it('formats a valid bounded archive JSONL window without reading adjacent messages', async () => {
    const path = join(archiveRoot, 'valid.jsonl');
    writeFileSync(path, [
      claudeLine('first message', 'first'),
      claudeLine('selected message', 'selected'),
      claudeLine('third message', 'third'),
    ].join('\n'));

    const reader = createConversationReader(archiveRoot);
    const result = await reader.readConversation({ path, startLine: 2, endLine: 2 });

    expect(result.markdown).toContain('# Conversation');
    expect(result.markdown).toContain('selected message');
    expect(result.markdown).not.toContain('first message');
    expect(result.markdown).not.toContain('third message');
    expect(result.path).toBe(path);
    expect(lstatSync(path).isFile()).toBe(true);
  });
});
