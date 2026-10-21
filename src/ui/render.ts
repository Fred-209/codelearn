// HTML for the codelearn panel. Pure (no vscode import) so it can be tested.
// Everything model-written goes through markdown-it with raw HTML disabled, or esc().

import MarkdownIt from 'markdown-it';
import { trustLevel } from '../learn/anchor';
import type { Zoom } from '../ai/prompts';
import type {
  Citation,
  Concept,
  ConceptStatus,
  Depth,
  Explanation,
  Lesson,
  RepoMap,
  Walkthrough,
} from '../store/types';
import { searchUrl, videoSearchUrl } from './links';

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function markdown(s: string): string {
  return md.render(s);
}

export type View =
  | { kind: 'loading'; title: string; message: string }
  | { kind: 'error'; title: string; message: string }
  | {
      kind: 'lesson';
      concept: Concept;
      depth: Depth;
      status: ConceptStatus;
      lesson?: Lesson;
      generating?: string;
      answers: { question: string; answer?: string }[];
      names: Record<string, string>;
    }
  | {
      kind: 'explain';
      file: string;
      lines: string;
      zoom: Zoom;
      explanation?: Explanation;
      generating?: string;
      names: Record<string, string>;
    }
  | { kind: 'walkthrough'; walkthrough: Walkthrough; index: number; names: Record<string, string> }
  | { kind: 'mapItem'; map: RepoMap; type: 'overview' | 'area' | 'flow' | 'term' | 'convention'; id: string }
  | { kind: 'usage'; report: string };

export function renderView(v: View): string {
  switch (v.kind) {
    case 'loading':
      return `<header><h1>${esc(v.title)}</h1></header><p class="muted"><span class="spinner"></span>${esc(v.message)}</p>`;
    case 'error':
      return `<header><h1>${esc(v.title)}</h1></header><div class="callout warn">${esc(v.message)}</div>`;
    case 'lesson':
      return renderLesson(v);
    case 'explain':
      return renderExplain(v);
    case 'walkthrough':
      return renderWalkthrough(v.walkthrough, v.index, v.names);
    case 'mapItem':
      return renderMapItem(v);
    case 'usage':
      return `<div class="usage">${markdown(v.report)}</div>`;
  }
}

const DEPTHS: [Depth, string][] = [
  ['refresher', 'Refresher'],
  ['standard', 'Standard'],
  ['scratch', 'From scratch'],
];

const STATUS_LABEL: Record<ConceptStatus, string> = { new: 'New to you', learning: 'Learning', known: 'You know this' };

function renderLesson(v: Extract<View, { kind: 'lesson' }>): string {
  const c = v.concept;
  const query = c.searchQuery || c.name;
  const parts: string[] = [];

  parts.push(`<header>
    <div class="eyebrow">${esc(c.kind)} · <span class="pill ${v.status}">${STATUS_LABEL[v.status]}</span></div>
    <h1>${esc(c.name)}</h1>
    ${c.summary ? `<p class="lead">${esc(c.summary)}</p>` : ''}
  </header>`);

  parts.push(`<div class="toolbar">
    <div class="seg" role="group" aria-label="Depth">${DEPTHS.map(
      ([d, label]) => `<button data-action="depth" data-depth="${d}" class="${d === v.depth ? 'sel' : ''}" aria-pressed="${d === v.depth}">${label}</button>`,
    ).join('')}</div>
    <div class="actions">
      ${v.status !== 'known' ? '<button data-action="status" data-status="known">I know this</button>' : '<button data-action="status" data-status="learning">I\'m rusty on this</button>'}
    </div>
  </div>`);

  if (v.generating) {
    parts.push(`<p class="muted"><span class="spinner"></span>${esc(v.generating)}</p>`);
  } else if (v.lesson) {
    const l = v.lesson;
    parts.push(`<section class="body">${markdown(l.body)}</section>`);
    if (l.comparisons.length) {
      parts.push(`<section class="box"><h2>Compared with what you know</h2><table>${l.comparisons
        .map((k) => `<tr><td><strong>${esc(k.here)}</strong></td><td>≈ ${esc(k.known)}</td><td class="muted">${esc(k.note)}</td></tr>`)
        .join('')}</table></section>`);
    }
    if (l.pitfalls.length) {
      parts.push(`<section><h2>Watch out for</h2><ul>${l.pitfalls.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></section>`);
    }
  }

  if (c.prereqs.length) {
    parts.push(`<section><h2>Helps to know first</h2><div class="chips">${c.prereqs
      .map((p) => `<button class="chip" data-action="lesson" data-ref="${esc(p)}">${esc(v.names[p] ?? p)}</button>`)
      .join('')}</div></section>`);
  }

  if (c.usage || c.citations.length) {
    parts.push(`<section><h2>In this repo</h2>${c.usage ? `<p>${esc(c.usage)}</p>` : ''}${renderCitations(c.citations)}</section>`);
  }

  parts.push(`<section><h2>Learn more</h2><p>
    <a href="${esc(searchUrl(c.docsSite, query))}">Search ${esc(c.docsSite || 'the docs')} for “${esc(query)}”</a><br>
    <a href="${esc(videoSearchUrl(query))}">Find videos on YouTube</a>
  </p></section>`);

  if (v.lesson?.check && !v.generating) parts.push(renderCheck(v.lesson.check));

  if (v.answers.length) {
    parts.push(`<section><h2>Your questions</h2>${v.answers
      .map((a) => `<div class="qa"><p class="q">${esc(a.question)}</p>${a.answer ? markdown(a.answer) : '<p class="muted"><span class="spinner"></span>Thinking…</p>'}</div>`)
      .join('')}</section>`);
  }

  if (v.lesson && !v.generating) {
    parts.push(`<footer>
      <button data-action="ask">Ask a question</button>
      <button data-action="wrong">This is wrong</button>
      <span class="muted">Written by ${esc(v.lesson.model)} · ${esc(v.lesson.generatedAt.slice(0, 10))}</span>
    </footer>`);
  }
  return parts.join('\n');
}

function renderCheck(check: NonNullable<Lesson['check']>): string {
  return `<section class="box check"><h2>Check yourself</h2><p>${esc(check.question)}</p>
    <div class="options">${check.options
      .map((o, i) => `<button class="opt" data-action="answer" data-correct="${i === check.answer}">${esc(o)}</button>`)
      .join('')}</div>
    <p class="feedback" hidden data-right="${esc(`Right. ${check.explanation}`)}" data-wrong="Not quite. Have another look, or try the From scratch depth."></p>
  </section>`;
}

export function renderCitations(cs: Citation[]): string {
  if (cs.length === 0) return '<p class="trust guess">No code references: treat this as the AI\'s guess.</p>';
  const level = trustLevel(cs);
  const label = { checked: 'Checked against the code', partly: 'Partly checked against the code', guess: "AI's guess: these references weren't found in the code" }[level];
  return `<p class="trust ${level}">${label}</p><ul class="cites">${cs
    .map(
      (c) => `<li><button class="link" data-action="open" data-file="${esc(c.file)}" data-line="${c.line}">${c.verified ? '✓' : '?'} ${esc(c.file)}:${c.line}</button>${
        c.quote ? ` <code>${esc(c.quote)}</code>` : ''
      }</li>`,
    )
    .join('')}</ul>`;
}

const ZOOMS: [Zoom, string][] = [
  ['line', 'This code'],
  ['file', 'This file'],
  ['flow', 'The bigger flow'],
];

function renderExplain(v: Extract<View, { kind: 'explain' }>): string {
  const parts: string[] = [];
  parts.push(`<header><div class="eyebrow">What's happening here?</div><h1>${esc(v.explanation?.title ?? v.file)}</h1><p class="muted">${esc(v.file)} · ${esc(v.lines)}</p></header>`);
  parts.push(`<div class="toolbar"><div class="seg" role="group" aria-label="Zoom">${ZOOMS.map(
    ([z, label]) => `<button data-action="zoom" data-zoom="${z}" class="${z === v.zoom ? 'sel' : ''}" aria-pressed="${z === v.zoom}">${label}</button>`,
  ).join('')}</div><div class="actions"><button data-action="walk-range">Step through this</button></div></div>`);
  if (v.generating) {
    parts.push(`<p class="muted"><span class="spinner"></span>${esc(v.generating)}</p>`);
  } else if (v.explanation) {
    const e = v.explanation;
    parts.push(`<section class="body">${markdown(e.body)}</section>`);
    if (e.conceptIds.length) {
      parts.push(`<section><h2>Concepts at play</h2><div class="chips">${e.conceptIds
        .map((id) => `<button class="chip" data-action="lesson" data-ref="${esc(id)}">${esc(v.names[id] ?? id)}</button>`)
        .join('')}</div></section>`);
    }
    parts.push(`<section><h2>References</h2>${renderCitations(e.citations)}</section>`);
    parts.push(`<footer><button data-action="wrong">This is wrong</button><span class="muted">Written by ${esc(e.model)}</span></footer>`);
  }
  return parts.join('\n');
}

export function renderWalkthrough(w: Walkthrough, index: number, names: Record<string, string>): string {
  const total = w.steps.length;
  const steps = w.steps
    .map((s, i) => {
      const state = i < index ? 'done' : i === index ? 'cur' : '';
      const concepts = s.concepts.length
        ? `<div class="chips">${s.concepts.map((c) => `<button class="chip" data-action="lesson" data-ref="${esc(c)}">${esc(names[c] ?? c)}</button>`).join('')}</div>`
        : '';
      const body =
        i === index
          ? `<div class="step-body">${markdown(s.body)}${concepts}${s.verified ? '' : '<p class="trust guess">This step\'s location is the AI\'s guess.</p>'}</div>`
          : '';
      return `<li class="step ${state}"><button class="step-head" data-action="walk-goto" data-index="${i}" ${i === index ? 'aria-current="step"' : ''}>
        <span class="num">${i < index ? '✓' : i + 1}</span>
        <span><strong>${esc(s.title)}</strong> <span class="muted">${esc(s.file)}:${s.line}</span></span>
      </button>${body}</li>`;
    })
    .join('');
  return `<header><div class="eyebrow">Walkthrough · step ${index + 1} of ${total}</div><h1>${esc(w.title)}</h1>${
    w.summary ? `<p class="lead">${esc(w.summary)}</p>` : ''
  }</header>
  <progress value="${index + 1}" max="${total}" aria-label="Progress"></progress>
  <ol class="steps">${steps}</ol>
  <footer class="walk-nav">
    <button data-action="walk-back" ${index === 0 ? 'disabled' : ''}>Back</button>
    <button class="primary" data-action="walk-next">${index === total - 1 ? 'Finish' : 'Next'}</button>
    <button data-action="walk-inline">Back to inline</button>
    <button data-action="walk-end">End</button>
  </footer>`;
}

function renderMapItem(v: Extract<View, { kind: 'mapItem' }>): string {
  const m = v.map;
  if (v.type === 'overview') {
    return `<header><div class="eyebrow">Overview</div><h1>${esc(m.repoName)}</h1></header>
      <section class="body"><p>${esc(m.overview)}</p></section>
      <section><h2>Areas</h2><ul>${m.areas.map((a) => `<li><button class="link" data-action="map" data-type="area" data-id="${esc(a.id)}">${esc(a.name)}</button>: ${esc(a.summary)}</li>`).join('')}</ul></section>
      <section><h2>Main flows</h2><ul>${m.flows.map((f) => `<li><button class="link" data-action="map" data-type="flow" data-id="${esc(f.id)}">${esc(f.name)}</button>: ${esc(f.summary)}</li>`).join('')}</ul></section>
      <p class="muted">Map built ${esc(m.generatedAt.slice(0, 10))} by ${esc(m.model)}.</p>`;
  }
  if (v.type === 'area') {
    const a = m.areas.find((x) => x.id === v.id);
    if (!a) return notFound();
    return `<header><div class="eyebrow">Area</div><h1>${esc(a.name)}</h1></header><section class="body"><p>${esc(a.summary)}</p></section>
      <section><h2>Where it lives</h2><ul>${a.paths.map((p) => `<li><code>${esc(p)}</code></li>`).join('')}</ul></section>`;
  }
  if (v.type === 'flow') {
    const f = m.flows.find((x) => x.id === v.id);
    if (!f) return notFound();
    return `<header><div class="eyebrow">Flow</div><h1>${esc(f.name)}</h1></header><section class="body"><p>${esc(f.summary)}</p></section>
      <div class="toolbar"><button class="primary" data-action="walk-flow" data-id="${esc(f.id)}">Walk me through this flow</button></div>
      <section><h2>Files, in order</h2><ol>${f.files.map((p) => `<li><button class="link" data-action="open" data-file="${esc(p)}" data-line="1">${esc(p)}</button></li>`).join('')}</ol></section>
      ${f.entry ? `<section><h2>Starts at</h2>${renderCitations([f.entry])}</section>` : ''}`;
  }
  if (v.type === 'term') {
    const t = m.glossary.find((x) => x.term === v.id);
    if (!t) return notFound();
    return `<header><div class="eyebrow">Business term</div><h1>${esc(t.term)}</h1></header><section class="body"><p>${esc(t.meaning)}</p></section>
      <section><h2>In the code</h2>${renderCitations(t.citations)}</section>`;
  }
  const c = m.conventions[Number(v.id)];
  if (!c) return notFound();
  const statusText = {
    confirmed: 'The code follows this.',
    contradicted: 'The code does not consistently follow this.',
    unchecked: "Not checked: the code codelearn read didn't show it either way.",
  }[c.status];
  return `<header><div class="eyebrow">Convention · from ${esc(c.source)}</div><h1>${esc(c.rule)}</h1></header>
    <div class="callout ${c.status === 'contradicted' ? 'warn' : ''}">${statusText}${c.note ? ` ${esc(c.note)}` : ''}</div>
    <section><h2>Evidence</h2>${renderCitations(c.evidence)}</section>`;
}

function notFound(): string {
  return '<p class="muted">This item is no longer in the map. Try rebuilding the map.</p>';
}

export const STYLES = `
:root { color-scheme: light dark; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 4px 20px 32px; line-height: 1.55; max-width: 820px; }
h1 { font-size: 1.6em; margin: 4px 0 6px; line-height: 1.25; }
h2 { font-size: .8em; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 22px 0 8px; }
.eyebrow { font-size: .85em; color: var(--vscode-descriptionForeground); text-transform: capitalize; }
.lead { font-size: 1.05em; margin: 0; }
.muted { color: var(--vscode-descriptionForeground); }
code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
pre { background: var(--vscode-textCodeBlock-background); padding: 10px 12px; border-radius: 4px; overflow-x: auto; }
pre code { padding: 0; background: none; }
button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 4px 11px; cursor: pointer; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.primary, .seg button.sel { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
button.link { background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); text-align: left; }
button.link:hover { text-decoration: underline; background: none; }
a { color: var(--vscode-textLink-foreground); }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin: 14px 0 6px; }
.seg { display: flex; }
.seg button { border-radius: 0; }
.seg button:first-child { border-radius: 3px 0 0 3px; }
.seg button:last-child { border-radius: 0 3px 3px 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.chip { border-radius: 12px; padding: 2px 10px; font-size: .92em; }
.pill { font-size: .85em; padding: 1px 8px; border-radius: 9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); text-transform: none; }
.box { border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #8884)); border-radius: 4px; padding: 4px 14px 12px; margin-top: 18px; }
table { border-collapse: collapse; width: 100%; }
td { padding: 4px 8px 4px 0; vertical-align: top; }
.trust { font-size: .9em; margin: 4px 0; }
.trust.checked { color: var(--vscode-testing-iconPassed, #3fa266); }
.trust.partly, .trust.guess { color: var(--vscode-editorWarning-foreground); }
.cites { list-style: none; padding: 0; margin: 4px 0; }
.cites li { margin: 3px 0; }
.callout { border-left: 3px solid var(--vscode-focusBorder); padding: 8px 12px; background: var(--vscode-textBlockQuote-background); margin: 12px 0; }
.callout.warn { border-left-color: var(--vscode-editorWarning-foreground); }
.options { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.opt.right { outline: 2px solid var(--vscode-testing-iconPassed, #3fa266); }
.opt.wrong { outline: 2px solid var(--vscode-errorForeground); }
footer { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 26px; padding-top: 12px; border-top: 1px solid var(--vscode-panel-border, #8884); }
.qa { margin-bottom: 14px; }
.qa .q { font-weight: 600; margin-bottom: 4px; }
.steps { list-style: none; padding: 0; margin: 10px 0; }
.step { border: 1px solid transparent; border-radius: 4px; margin-bottom: 4px; }
.step.cur { border-color: var(--vscode-focusBorder); }
.step-head { display: flex; gap: 10px; align-items: flex-start; width: 100%; text-align: left; background: none; border: none; padding: 8px 10px; color: var(--vscode-foreground); }
.step-head:hover { background: var(--vscode-list-hoverBackground); }
.step-body { padding: 0 12px 10px 42px; }
.num { flex: none; width: 22px; height: 22px; border-radius: 11px; display: inline-flex; align-items: center; justify-content: center; font-size: .8em; font-weight: 700; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.step.cur .num { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
progress { width: 100%; height: 4px; margin-top: 10px; appearance: none; border: none; background: var(--vscode-editorWidget-background, #8883); border-radius: 2px; }
progress::-webkit-progress-bar { background: var(--vscode-editorWidget-background, #8883); border-radius: 2px; }
progress::-webkit-progress-value { background: var(--vscode-progressBar-background, #0e70c0); border-radius: 2px; }
.spinner { display: inline-block; width: 10px; height: 10px; margin-right: 8px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; vertical-align: -1px; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`;

export const SCRIPT = `
const vscode = acquireVsCodeApi();
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'answer') {
    const box = el.closest('.check');
    box.querySelectorAll('.opt').forEach((o) => o.classList.remove('right', 'wrong'));
    const right = el.dataset.correct === 'true';
    el.classList.add(right ? 'right' : 'wrong');
    const fb = box.querySelector('.feedback');
    fb.textContent = right ? fb.dataset.right : fb.dataset.wrong;
    fb.hidden = false;
    return;
  }
  vscode.postMessage({ action, ...el.dataset });
});
`;

export function page(body: string, nonce: string, cspSource: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${cspSource} https: data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">${STYLES}</style></head>
<body>${body}<script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
