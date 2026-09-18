import { describe, it, expect, vi, beforeEach } from 'vitest';
import extension from '../extensions/episodic-memory.js';

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

  it('registers read_conversation native tool with full schema', () => {
    expect(registeredTools.has('read_conversation')).toBe(true);
    const tool = registeredTools.get('read_conversation');
    expect(tool.name).toBe('read_conversation');
    expect(tool.description).toContain('Read full conversations');
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });
});
