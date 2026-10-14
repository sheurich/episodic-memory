import { describe, expect, it } from 'vitest';
import { formatConversationAsHTML, formatConversationAsMarkdown } from '../src/show.js';

const PRIVATE_SYSTEM_TEXT = 'SYNTHETIC PRIVATE PI SYSTEM CONTEXT';

function piJsonl(userContent: string, nestedOmpMarker = false): string {
  const toolArguments = nestedOmpMarker
    ? { path: 'config.ts', metadata: { renderer: 'omp_nested_marker' } }
    : { path: 'config.ts' };

  return [
    {
      type: 'session',
      version: 3,
      id: 'pi-classification-session',
      timestamp: '2026-10-13T12:00:00.000Z',
      cwd: '/work/pi-classification',
    },
    {
      type: 'message',
      id: 's',
      parentId: null,
      timestamp: '2026-10-13T12:00:00.500Z',
      message: {
        role: 'system',
        content: PRIVATE_SYSTEM_TEXT,
        sections: { private: 'SYNTHETIC PRIVATE SECTION' },
      },
    },
    {
      type: 'message',
      id: 'u',
      parentId: 's',
      timestamp: '2026-10-13T12:00:01.000Z',
      message: { role: 'user', content: userContent },
    },
    {
      type: 'message',
      id: 'a',
      parentId: 'u',
      timestamp: '2026-10-13T12:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Pi thinking remains rendered.' },
          { type: 'text', text: 'Pi assistant response.' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: toolArguments },
        ],
      },
    },
    {
      type: 'message',
      id: 't',
      parentId: 'a',
      timestamp: '2026-10-13T12:00:03.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'Synthetic tool output.' }],
      },
    },
  ].map(entry => JSON.stringify(entry)).join('\n');
}

function expectPiRendering(rendered: string, userContent: string): void {
  expect(rendered).toContain('Pi');
  expect(rendered).not.toContain('Oh My Pi');
  expect(rendered).toContain(userContent);
  expect(rendered).toContain('Pi assistant response.');
  expect(rendered).toContain('Pi thinking remains rendered.');
  expect(rendered).toContain('read');
  expect(rendered).toContain('Synthetic tool output.');
  expect(rendered).not.toContain(PRIVATE_SYSTEM_TEXT);
  expect(rendered).not.toContain('SYNTHETIC PRIVATE SECTION');
}

describe('Pi show renderer classification', () => {
  it.each([
    ['Markdown', formatConversationAsMarkdown],
    ['HTML', formatConversationAsHTML],
  ])('keeps a valid version 3 Pi session in the Pi renderer when user text starts with omp_ in %s', (_label, format) => {
    const userContent = 'omp_example';
    expectPiRendering(format(piJsonl(userContent)), userContent);
  });

  it('ignores nested omp_ strings in message data when choosing the renderer', () => {
    const rendered = formatConversationAsMarkdown(piJsonl('ordinary-example', true));

    expectPiRendering(rendered, 'ordinary-example');
    expect(rendered).toContain('omp_nested_marker');
  });

  it.each([
    ['Markdown', (jsonl: string) => formatConversationAsMarkdown(jsonl, 2, 5)],
    ['HTML', (jsonl: string) => formatConversationAsHTML(jsonl.split('\n').slice(1, 5).join('\n'))],
  ])('recognizes a headerless Pi line window from its structured system marker in %s', (_label, format) => {
    const userContent = 'ordinary-example';
    expectPiRendering(format(piJsonl(userContent)), userContent);
  });
});
