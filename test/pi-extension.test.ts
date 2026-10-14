import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import extension from '../extensions/episodic-memory.js';

function conversationLine(content: string): string {
  return JSON.stringify({
    uuid: 'pi-extension-test',
    parentUuid: null,
    timestamp: '2026-10-13T12:00:00.000Z',
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content },
  });
}

describe('Pi native extension', () => {
  let registeredTools: Map<string, any>;
  let eventHandlers: Map<string, any>;
  let mockPi: any;

  beforeEach(() => {
    registeredTools = new Map();
    eventHandlers = new Map();
    mockPi = {
      on: vi.fn((event: string, handler: any) => {
        eventHandlers.set(event, handler);
      }),
      registerTool: vi.fn((tool: any) => {
        registeredTools.set(tool.name, tool);
      }),
    };
    extension(mockPi);
  });

  it('subscribes to session_start event for background sync', () => {
    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(eventHandlers.has('session_start')).toBe(true);
  });

  it('registers search_conversations native tool with full schema', () => {
    expect(registeredTools.has('search_conversations')).toBe(true);
    const tool = registeredTools.get('search_conversations');
    expect(tool.name).toBe('search_conversations');
    expect(tool.description).toContain('Search episodic memory');
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('registers read_conversation as a required, bounded archive-window tool', () => {
    expect(registeredTools.has('read_conversation')).toBe(true);
    const tool = registeredTools.get('read_conversation');
    expect(tool.name).toBe('read_conversation');
    expect(tool.description).toContain('up to 40 lines');
    expect(tool.description).not.toContain('full conversations');
    expect(tool.parameters.required).toEqual(expect.arrayContaining(['path', 'startLine', 'endLine']));
    expect(tool.parameters.properties.startLine.minimum).toBe(1);
    expect(tool.parameters.properties.endLine.minimum).toBe(1);
    expect(typeof tool.execute).toBe('function');
  });

  it('routes native reads through the archive-bounded reader captured at registration', async () => {
    const originalArchive = join(process.env.EPISODIC_MEMORY_CONFIG_DIR!, 'conversation-archive');
    const changedArchive = join(process.env.EPISODIC_MEMORY_CONFIG_DIR!, 'changed-after-registration');
    mkdirSync(originalArchive, { recursive: true });
    mkdirSync(changedArchive, { recursive: true });
    const approvedPath = join(originalArchive, 'approved.jsonl');
    const changedPath = join(changedArchive, 'not-approved.jsonl');
    writeFileSync(approvedPath, conversationLine('approved archive content'));
    writeFileSync(changedPath, conversationLine('changed environment content'));

    process.env.TEST_ARCHIVE_DIR = changedArchive;
    try {
      const tool = registeredTools.get('read_conversation');
      const valid = await tool.execute(
        'read-valid',
        { path: approvedPath, startLine: 1, endLine: 1 },
        new AbortController().signal,
        vi.fn(),
        {},
      );
      expect(valid.content[0].text).toContain('approved archive content');

      const rejected = await tool.execute(
        'read-rejected',
        { path: changedPath, startLine: 1, endLine: 1 },
        new AbortController().signal,
        vi.fn(),
        {},
      );
      expect(rejected.details.error).toBe('path_outside_archive');
      expect(rejected.content[0].text).not.toContain('changed environment content');
    } finally {
      delete process.env.TEST_ARCHIVE_DIR;
    }
  });
});
