import { describe, expect, it } from 'vitest';
import { esc, highlightLines, markdown, page, renderBackBar, renderCitations, renderView } from '../src/ui/render';
import type { Concept, Lesson, RepoMap } from '../src/store/types';

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

describe('code highlighting', () => {
  it('colours code blocks by language and still escapes the code', () => {
    const html = markdown('```csharp\nvar s = "<script>"; // hi\n```');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('hljs-string');
    expect(html).toContain('hljs-comment');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('guesses the language when the block has none', () => {
    expect(markdown('```\nfunction add(a, b) { return a + b; }\n```')).toContain('hljs-');
  });
});

describe('renderBackBar', () => {
  it('links back to the previous page, escaping its title', () => {
    const html = renderBackBar('<LINQ>');
    expect(html).toContain('data-action="back"');
    expect(html).toContain('&lt;LINQ&gt;');
  });
});

describe('lessons tied to the code', () => {
  const examples = {
    terms: ['.Where(', 'Where'],
    searched: 120,
    matched: 4,
    examples: [{ file: 'src/Orders/List.cs', line: 12, start: 10, lines: ['var open = orders', '    // only open ones', '    .Where(o => o.Open)', '    .ToList();'] }],
    more: [{ file: 'src/Users/List.cs', line: 7, text: 'users.Where(u => u.Active)' }],
  };

  it('shows real examples with line numbers, the matching line marked', () => {
    const html = renderView({ kind: 'lesson', concept, depth: 'standard', status: 'new', lesson, answers: [], names: {}, examples });
    expect(html).toContain('<h2>In this codebase</h2>');
    expect(html).toContain('Searched 120 files for <code>.Where(</code>, <code>Where</code>: used in 4.');
    expect(html).toContain('data-file="src/Orders/List.cs" data-line="12">src/Orders/List.cs:12');
    expect(html).toMatch(/<span class="cl hit"><span class="ln">12<\/span>/);
    expect(html).toContain('<span class="ln">10</span>');
    expect(html).toContain('3 more files, first 1 shown');
    expect(html).toContain('id="codebase"');
  });

  it('says it is still looking, then what it searched for when nothing turned up', () => {
    const searching = renderView({ kind: 'lesson', concept, depth: 'standard', status: 'new', lesson, answers: [], names: {}, searching: true });
    expect(searching).toContain('Looking for examples');
    const none = renderView({
      kind: 'lesson',
      concept,
      depth: 'standard',
      status: 'new',
      lesson,
      answers: [],
      names: {},
      examples: { ...examples, matched: 0, examples: [], more: [] },
    });
    expect(none).toContain('No uses found: searched 120 files for');
  });

  it('lists the official docs pages, never a link that isn\'t https', () => {
    const docs = [
      { title: 'LINQ overview', url: 'https://learn.microsoft.com/dotnet/csharp/linq/', checked: true },
      { title: 'Sneaky', url: 'javascript:alert(1)' },
    ];
    const html = renderView({ kind: 'lesson', concept, depth: 'standard', status: 'new', lesson: { ...lesson, docs }, answers: [], names: {} });
    expect(html).toContain('<a href="https://learn.microsoft.com/dotnet/csharp/linq/">LINQ overview</a>');
    expect(html).toContain('✓ checked');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Find videos on YouTube');
  });

  it('keeps each highlighted line whole when a comment spans lines', () => {
    const lines = highlightLines('/* one\n two */\nconst x = 1;', 'typescript');
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l.match(/<span/g)?.length ?? 0).toBe(l.match(/<\/span>/g)?.length ?? 0);
    expect(lines[1]).toContain('hljs-comment');
    expect(lines[2]).toContain('hljs-keyword');
  });
});

describe('map pages', () => {
  const map: RepoMap = {
    version: 3,
    repoName: 'portal',
    generatedAt: '2026-10-21T00:00:00Z',
    model: 'Claude Opus 5.5',
    overview: 'A developer portal.',
    depth: 'quick',
    areas: [
      { id: 'users', name: 'Users', summary: 'Accounts.', paths: ['src/users'], keyFiles: [{ file: 'src/users/service.ts', role: 'Signs users in' }] },
    ],
    flows: [
      {
        id: 'sign-in',
        name: 'Signing in',
        summary: 'From the form to a token.',
        files: ['src/users/service.ts'],
        part: 'site',
        steps: [
          { file: 'src/users/service.ts', line: 4, title: 'Form posts', body: 'The form calls **signIn**.', concepts: ['oauth'], verified: true },
          { file: 'src/users/token.ts', line: 9, title: 'Token kept', body: 'Saved for later calls.', verified: false },
        ],
      },
      { id: 'q-emails', name: 'Where emails are sent', summary: 'They are not.', files: [], question: 'Where are emails sent?' },
    ],
    concepts: [{ ...concept, id: 'oauth', name: 'OAuth' }],
    glossary: [],
    conventions: [],
    fileHashes: {},
    architecture: {
      summary: 'A static site that calls **API Management**.',
      parts: [
        { id: 'site', name: 'Published site', summary: 'What visitors see.', paths: ['src'], runs: 'Azure Static Web Apps' },
        { id: 'apim', name: 'API Management', summary: 'The API.', paths: [], external: true },
      ],
      links: [
        { from: 'site', to: 'apim', how: 'calls its REST API', evidence: { file: 'src/api.ts', line: 3, verified: true } },
        { from: 'apim', to: 'site', how: 'sends events back' },
      ],
    },
  };

  it('draws the architecture and says which connections are inferred', () => {
    const html = renderView({ kind: 'mapItem', map, type: 'architecture', id: '' });
    expect(html).toContain('<svg class="diagram"');
    expect(html).toContain('<strong>API Management</strong>');
    expect(html).toContain('data-file="src/api.ts" data-line="3">✓ src/api.ts:3');
    expect(html).toContain('<span class="tag inferred"');
    expect(html).toContain('Azure Static Web Apps');
  });

  it('offers to rebuild when the map has no architecture', () => {
    const html = renderView({ kind: 'mapItem', map: { ...map, architecture: undefined }, type: 'architecture', id: '' });
    expect(html).toContain('data-action="build-map"');
  });

  it('shows a part with its connections and flows', () => {
    const html = renderView({ kind: 'mapItem', map, type: 'part', id: 'site' });
    expect(html).toContain('Runs: Azure Static Web Apps');
    expect(html).toContain('calls its REST API');
    expect(html).toContain('data-type="flow" data-id="sign-in"');
    expect(html).toContain('data-type="area" data-id="users"');
  });

  it('shows a followed flow step by step, flagging steps that were not found', () => {
    const html = renderView({ kind: 'mapItem', map, type: 'flow', id: 'sign-in' });
    expect(html).toContain('<h2>Step by step</h2>');
    expect(html).toContain('✓ src/users/service.ts:4');
    expect(html).toContain('? src/users/token.ts:9');
    expect(html).toContain('<strong>signIn</strong>');
    expect(html).toContain('data-ref="oauth">OAuth');
    expect(html).toContain('Runs in');
    expect(html).toContain('no AI request');
  });

  it('shows an investigated question with what was asked', () => {
    const html = renderView({ kind: 'mapItem', map, type: 'flow', id: 'q-emails' });
    expect(html).toContain('Your question');
    expect(html).toContain('You asked: “Where are emails sent?”');
  });

  it('offers Explore deeper on an area, with its key files and flows', () => {
    const html = renderView({ kind: 'mapItem', map, type: 'area', id: 'users' });
    expect(html).toContain('data-action="explore" data-id="users"');
    expect(html).toContain('Explore deeper');
    expect(html).toContain('Signs users in');
    expect(html).toContain('data-type="flow" data-id="sign-in"');
  });

  it('suggests a Thorough map only on a quick one, and keeps questions apart', () => {
    const quick = renderView({ kind: 'mapItem', map, type: 'overview', id: '' });
    expect(quick).toContain('Build a Thorough map');
    expect(quick).toContain('<h2>Your questions</h2>');
    expect(quick).toContain('How the parts fit together');
    const thorough = renderView({ kind: 'mapItem', map: { ...map, depth: 'thorough' }, type: 'overview', id: '' });
    expect(thorough).not.toContain('Build a Thorough map');
  });

  it('links an explanation to the parts of the map its file belongs to', () => {
    const html = renderView({
      kind: 'explain',
      file: 'src/users/service.ts',
      lines: 'line 4',
      zoom: 'line',
      names: {},
      places: [
        { type: 'part', id: 'site', name: 'Published site' },
        { type: 'area', id: 'users', name: 'Users' },
      ],
    });
    expect(html).toContain('data-action="map" data-type="part" data-id="site"');
    expect(html).toContain('<span class="chip-kind">area</span>Users');
  });
});
