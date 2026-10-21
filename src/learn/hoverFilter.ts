// Decides whether a hovered word is worth offering to explain. Pure, so it can be unit tested.
// Concept and glossary hovers are not filtered: a known concept is worth showing anywhere.

/** Everyday English words. Offering to explain these is noise. */
const PROSE = new Set(
  (
    'a an the and or but nor so yet if then else when while for of to in on at by from with without into onto ' +
    'out up down over under about above below after before between through during since until than as is are ' +
    'was were be been being am do does did done has have had having can could will would shall should may might ' +
    'must not no yes it its this that these those there here what which who whom whose why how all any each ' +
    'every some such other another more most less least many much few one two three first last next only also ' +
    'just very too even still already again ever never always often sometimes we us our you your he him his she ' +
    'her they them their i me my mine ours yours theirs because though although however therefore thus via per ' +
    'etc eg ie todo note fixme hack see like make made use used uses using get gets got set sets need needs want ' +
    'wants way ways thing things something nothing anything everything same different new old'
  ).split(/\s+/),
);

export function isProseWord(word: string): boolean {
  return PROSE.has(word.toLowerCase());
}

/**
 * Rough check for whether column `col` of a line sits inside a comment or a string literal.
 * Works across most languages without a parser: it tracks quotes from the start of the line
 * and stops at a line-comment marker. Block comments are recognised from their usual
 * continuation lines (` * ...`, `/* ...`).
 */
export function inCommentOrString(line: string, col: number): boolean {
  const trimmed = line.trimStart();
  // `# note` and `#!` are comments; `#include`, `#region` and `#[derive]` are code.
  if (/^(\/\/|\/\*|\*|#(\s|!|#|$)|--(\s|$)|<!--|'''|""")/.test(trimmed)) return true;

  let quote: string | undefined;
  for (let i = 0; i < Math.min(col, line.length); i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === '`' || (ch === "'" && isStringQuote(line, i))) {
      quote = ch;
      continue;
    }
    const prevBlank = i === 0 || /\s/.test(line[i - 1]);
    if (ch === '/' && (line[i + 1] === '/' || line[i + 1] === '*')) return true;
    if (ch === '#' && prevBlank && (i + 1 >= line.length || /\s/.test(line[i + 1]))) return true;
    if (ch === '-' && line[i + 1] === '-' && prevBlank && /\s/.test(line[i + 2] ?? ' ')) return true;
  }
  return quote !== undefined;
}

/** An apostrophe after a letter ("don't") or with no closing quote on the line ('a lifetimes) doesn't open a string. */
function isStringQuote(line: string, i: number): boolean {
  if (/[A-Za-z0-9_]/.test(line[i - 1] ?? ' ')) return false;
  return line.indexOf("'", i + 1) !== -1;
}

/** Whether to offer "explain `word`" for a word the map doesn't know. */
export function worthExplaining(word: string, line: string, col: number): boolean {
  if (word.length < 3 || isProseWord(word)) return false;
  return !inCommentOrString(line, col);
}
