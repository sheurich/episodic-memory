import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

const { spawn, unref } = vi.hoisted(() => {
  const unref = vi.fn();
  return { spawn: vi.fn(() => ({ unref })), unref };
});
vi.mock('node:child_process', () => ({ spawn }));

import registerSync from '../extensions/episodic-memory-sync.js';

describe('Pi sync extension registration (mocked host, not a Pi loader test)', () => {
  it('should register only session_start and launch detached sync when it fires', async () => {
    const on = vi.fn();
    // The host type is erased at runtime; no Pi installation or real subprocess is needed.
    registerSync({ on } as unknown as Parameters<typeof registerSync>[0]);

    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(spawn).not.toHaveBeenCalled();

    await on.mock.calls[0][1]({}, {});

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('node', [
      path.resolve(import.meta.dirname, '..', 'dist', 'index-cli.js'),
      'index-all-sources',
      '--no-summaries',
    ], { stdio: 'ignore', detached: true });
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
