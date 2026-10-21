// Official documentation links for lessons. The AI names up to three pages; codelearn shows a
// page only when it is on the expected documentation site and actually loads, so a made-up or
// moved URL never reaches the learner. Search links stay as the fallback.

import type { DocLink } from '../store/types';

/** Documentation sites trusted for any concept, besides the concept's own docs site. */
const KNOWN_DOC_HOSTS = [
  'developer.mozilla.org',
  'learn.microsoft.com',
  'docs.microsoft.com',
  'www.typescriptlang.org',
  'nodejs.org',
  'react.dev',
  'angular.dev',
  'angular.io',
  'vuejs.org',
  'svelte.dev',
  'docs.python.org',
  'go.dev',
  'pkg.go.dev',
  'doc.rust-lang.org',
  'docs.rs',
  'docs.oracle.com',
  'kotlinlang.org',
  'docs.github.com',
  'git-scm.com',
  'webpack.js.org',
  'vite.dev',
  'vitejs.dev',
  'jestjs.io',
  'vitest.dev',
  'playwright.dev',
  'eslint.org',
  'docs.docker.com',
  'kubernetes.io',
  'developer.hashicorp.com',
  'docs.npmjs.com',
  'knockoutjs.com',
  'docs.fluentvalidation.net',
  'expressjs.com',
  'nextjs.org',
  'graphql.org',
  'tailwindcss.com',
  'getbootstrap.com',
  'sass-lang.com',
  'docs.spring.io',
  'docs.djangoproject.com',
  'fastapi.tiangolo.com',
  'flask.palletsprojects.com',
  'rxjs.dev',
  'lodash.com',
];

function hostMatches(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const s = site.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return !!s && (h === s || h.endsWith(`.${s}`));
}

/** The links worth checking: https, on one of `sites` or a well-known docs site, at most three. */
export function candidateDocs(docs: { title?: unknown; url?: unknown }[], sites: (string | undefined)[]): DocLink[] {
  const allowed = [...sites.filter((s): s is string => !!s), ...KNOWN_DOC_HOSTS];
  const out: DocLink[] = [];
  for (const d of docs) {
    if (typeof d?.url !== 'string') continue;
    let url: URL;
    try {
      url = new URL(d.url.trim());
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.username || url.password || !allowed.some((s) => hostMatches(url.hostname, s))) continue;
    if (out.some((o) => o.url === url.toString())) continue;
    const title = typeof d.title === 'string' && d.title.trim() ? d.title.trim().slice(0, 120) : url.hostname + url.pathname;
    out.push({ title, url: url.toString() });
    if (out.length === 3) break;
  }
  return out;
}

type Fetch = (url: string, init: { redirect: 'follow'; signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  url: string;
  text(): Promise<string>;
}>;

const NOT_FOUND = /<title>[^<]*(not found|404|page not found|does not exist|no longer available)[^<]*<\/title>/i;

/** Whether the page loads, stays on a documentation site, and isn't a "not found" page. */
export async function pageLoads(link: DocLink, sites: (string | undefined)[], fetchImpl: Fetch, timeoutMs = 6000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(link.url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'codelearn VS Code extension (link check)' } });
    if (!res.ok) return false;
    const final = new URL(res.url || link.url);
    const asked = new URL(link.url);
    // Redirected off the docs site, or to its home page: the page itself is gone.
    if (candidateDocs([{ url: final.toString() }], sites).length === 0) return false;
    if (final.pathname.replace(/\/+$/, '') === '' && asked.pathname.replace(/\/+$/, '') !== '') return false;
    const head = (await res.text()).slice(0, 65_536);
    return !NOT_FOUND.test(head);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The links to show. With checking on, only pages that load. With it off (for networks that
 * block these sites), the candidates as they are, marked unchecked.
 */
export async function checkedDocs(docs: { title?: unknown; url?: unknown }[], sites: (string | undefined)[], check: boolean, fetchImpl?: Fetch): Promise<DocLink[]> {
  const candidates = candidateDocs(docs, sites);
  if (!check || !fetchImpl) return candidates.map((d) => ({ ...d, checked: false }));
  const ok = await Promise.all(candidates.map((d) => pageLoads(d, sites, fetchImpl)));
  return candidates.filter((_, i) => ok[i]).map((d) => ({ ...d, checked: true }));
}
