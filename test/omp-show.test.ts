import { describe, it, expect } from 'vitest';
import { formatConversationAsHTML, formatConversationAsMarkdown } from '../src/show.js';

function ompJsonl(): string {
  const lines = [
    { type: 'session', id: 'omp_sess_show', timestamp: '2026-04-01T00:00:00Z', cwd: '/work/show-project' },
    {
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: '2026-04-01T00:00:01Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Please render an OMP transcript.' }] },
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: '2026-04-01T00:00:02Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'HIDDEN chain of thought.' },
          { type: 'text', text: 'OMP transcripts render as markdown.' },
        ],
      },
    },
  ];
  return lines.map(line => JSON.stringify(line)).join('\n');
}

describe('show command - OMP markdown formatting', () => {
  it('detects an OMP transcript from structured session metadata and renders user + assistant text, excluding thinking', () => {
    const markdown = formatConversationAsMarkdown(ompJsonl());

    expect(markdown).toContain('**Harness:** Oh My Pi (OMP)');
    expect(markdown).toContain('omp_sess_show');
    expect(markdown).toContain('Please render an OMP transcript.');
    expect(markdown).toContain('OMP transcripts render as markdown.');
    expect(markdown).not.toContain('HIDDEN chain of thought');
  });

  it.each([
    ['Markdown', formatConversationAsMarkdown],
    ['HTML', formatConversationAsHTML],
  ])('does not render system messages from an OMP transcript in %s', (_label, format) => {
    const entries = ompJsonl().split('\n').map(line => JSON.parse(line));
    entries.splice(1, 0, {
      type: 'message',
      id: 'system-1',
      parentId: null,
      timestamp: '2026-04-01T00:00:00.500Z',
      message: { role: 'system', content: 'SYNTHETIC PRIVATE OMP SYSTEM CONTEXT' },
    });
    entries[2].parentId = 'system-1';

    const rendered = format(entries.map(entry => JSON.stringify(entry)).join('\n'));

    expect(rendered).toContain('Please render an OMP transcript.');
    expect(rendered).toContain('OMP transcripts render as markdown.');
    expect(rendered).not.toContain('SYNTHETIC PRIVATE OMP SYSTEM CONTEXT');
  });
});
