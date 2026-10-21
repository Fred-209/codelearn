import { describe, expect, it } from 'vitest';
import { candidateDocs, checkedDocs } from '../src/learn/docLinks';

type Page = { status: number; url?: string; body?: string };

function fakeFetch(pages: Record<string, Page>) {
  return async (url: string) => {
    const p = pages[url] ?? { status: 404 };
    return { ok: p.status >= 200 && p.status < 300, url: p.url ?? url, text: async () => p.body ?? '<title>Docs</title>' };
  };
}

describe('candidateDocs', () => {
  it('keeps https links on the docs site or a known docs site, three at most', () => {
    const docs = candidateDocs(
      [
        { title: 'Bindings', url: 'https://knockoutjs.com/documentation/binding-syntax.html' },
        { title: 'Blog', url: 'https://someblog.example/knockout' },
        { title: 'Plain http', url: 'http://knockoutjs.com/documentation/observables.html' },
        { title: 'MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/data-*' },
        { url: 'https://knockoutjs.com/documentation/computed-observables.html' },
        { title: 'Fourth', url: 'https://knockoutjs.com/documentation/observableArrays.html' },
        { title: 'Not a URL', url: 'knockoutjs.com/x' },
      ],
      ['knockoutjs.com'],
    );
    expect(docs.map((d) => d.title)).toEqual(['Bindings', 'MDN', 'knockoutjs.com/documentation/computed-observables.html']);
  });

  it('accepts subdomains of the docs site', () => {
    expect(candidateDocs([{ title: 'x', url: 'https://docs.example.dev/guide' }], ['example.dev'])).toHaveLength(1);
  });
});

describe('checkedDocs', () => {
  const docs = [
    { title: 'Real', url: 'https://learn.microsoft.com/dotnet/csharp/linq/' },
    { title: 'Moved', url: 'https://learn.microsoft.com/dotnet/old-page' },
    { title: 'Gone', url: 'https://learn.microsoft.com/dotnet/gone' },
    { title: 'Soft 404', url: 'https://developer.mozilla.org/en-US/docs/Nope' },
  ];
  const fetch = fakeFetch({
    'https://learn.microsoft.com/dotnet/csharp/linq/': { status: 200 },
    'https://learn.microsoft.com/dotnet/old-page': { status: 200, url: 'https://learn.microsoft.com/' },
    'https://developer.mozilla.org/en-US/docs/Nope': { status: 200, body: '<html><title>Page not found | MDN</title>' },
  });

  it('shows only pages that load on the docs site', async () => {
    const shown = await checkedDocs(docs, ['learn.microsoft.com'], true, fetch);
    expect(shown).toEqual([{ title: 'Real', url: 'https://learn.microsoft.com/dotnet/csharp/linq/', checked: true }]);
  });

  it('shows the candidates unchecked when checking is off', async () => {
    const shown = await checkedDocs(docs.slice(0, 1), ['learn.microsoft.com'], false);
    expect(shown).toEqual([{ title: 'Real', url: 'https://learn.microsoft.com/dotnet/csharp/linq/', checked: false }]);
  });

  it('treats a network failure as not loading', async () => {
    const failing = async () => {
      throw new Error('blocked by proxy');
    };
    expect(await checkedDocs(docs.slice(0, 1), ['learn.microsoft.com'], true, failing)).toEqual([]);
  });
});
