import { describe, expect, it } from 'vitest';
import { esc, page, renderCitations, renderView } from '../src/ui/render';
import type { Concept, Lesson } from '../src/store/types';

const concept: Concept = {
  id: 'linq',
  name: 'LINQ',
  kind: 'library',
  summary: 'Query methods for collections.',
  hover: '',
  match: ['Where'],
  prereqs: ['lambdas'],
  usage: 'Handlers filter lists.',
  citations: [{ file: 'src/Handler.cs', line: 14, quote: '.Where(', verified: true }],
  docsSite: 'learn.microsoft.com',
  searchQuery: 'C# LINQ',
};

const lesson: Lesson = {
  conceptId: 'linq',
  conceptName: 'C# LINQ',
  depth: 'standard',
  body: '### What it is\n\n<script>alert(1)</script> LINQ adds `Where`.',
  comparisons: [{ known: 'Array.filter', here: 'Where', note: 'LINQ is lazy' }],
  usage: '',
  citations: [],
  pitfalls: ['Enumerating twice runs the query twice'],
  check: { question: 'What runs the query?', options: ['Where', 'ToList'], answer: 1, explanation: 'ToList enumerates.' },
  generatedAt: '2026-10-21T00:00:00Z',
  model: 'Claude Sonnet 5.5',
  sourceHash: '',
};

describe('renderView', () => {
  it('renders a lesson without letting model HTML through', () => {
    const html = renderView({ kind: 'lesson', concept, depth: 'standard', status: 'new', lesson, answers: [], names: { lambdas: 'Lambdas' } });
    expect(html).toContain('<h1>LINQ</h1>');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('data-depth="standard" class="sel"');
    expect(html).toContain('>Lambdas<');
    expect(html).toContain('Checked against the code');
    expect(html).toContain('data-correct="true">ToList');
    expect(html).toContain('site%3Alearn.microsoft.com%20C%23%20LINQ');
    expect(html).toContain('I know this');
  });

  it('offers "rusty" instead of "I know this" for known concepts', () => {
    const html = renderView({ kind: 'lesson', concept, depth: 'refresher', status: 'known', lesson, answers: [], names: {} });
    expect(html).toContain("I'm rusty on this");
  });

  it('renders a walkthrough with the current step expanded', () => {
    const html = renderView({
      kind: 'walkthrough',
      index: 1,
      names: {},
      walkthrough: {
        id: 'w',
        title: 'Create payment',
        summary: '',
        generatedAt: '',
        model: '',
        steps: [
          { file: 'a.cs', line: 1, title: 'First', body: 'one', concepts: [], verified: true },
          { file: 'b.cs', line: 2, title: 'Second', body: 'two', concepts: ['linq'], verified: false },
        ],
      },
    });
    expect(html).toContain('step 2 of 2');
    expect(html).toContain('<p>two</p>');
    expect(html).not.toContain('<p>one</p>');
    expect(html).toContain('Finish');
    expect(html).toContain("AI's guess");
  });
});

describe('helpers', () => {
  it('escapes HTML', () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('labels unverified citations as guesses', () => {
    expect(renderCitations([{ file: 'a.cs', line: 1, verified: false }])).toContain("AI's guess");
    expect(renderCitations([])).toContain("AI's guess");
  });

  it('wraps pages in a strict CSP with a nonce', () => {
    const html = page('<p>x</p>', 'abc', 'vscode-resource:');
    expect(html).toContain("script-src 'nonce-abc'");
    expect(html).toContain("default-src 'none'");
  });
});
