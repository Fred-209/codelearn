// Finds which concept or glossary term a hovered word belongs to. Pure.

import type { Concept, GlossaryTerm } from '../store/types';

/** "IRequestHandler<" -> ["IRequestHandler"], ".Where(" -> ["Where"], "async/await" -> ["async", "await"] */
export function matchTokens(pattern: string): string[] {
  return (pattern.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).filter((t) => t.length >= 2);
}

export class ConceptIndex {
  private byToken = new Map<string, Concept[]>();

  constructor(concepts: Concept[]) {
    for (const c of concepts) {
      for (const pattern of c.match) {
        for (const token of matchTokens(pattern)) {
          const list = this.byToken.get(token) ?? [];
          if (!list.includes(c)) list.push(c);
          this.byToken.set(token, list);
        }
      }
    }
  }

  /** Concepts whose match tokens include this exact word. Most specific (fewest tokens) first. */
  lookup(word: string): Concept[] {
    const found = this.byToken.get(word) ?? [];
    return [...found].sort((a, b) => a.match.length - b.match.length);
  }

  get size(): number {
    return this.byToken.size;
  }
}

/** Splits an identifier into lower-case words: "SettlementBatchId" -> ["settlement", "batch", "id"]. */
export function identifierWords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/** A glossary term matches when all its words appear in order inside the identifier's words. */
export function matchGlossary(identifier: string, glossary: GlossaryTerm[]): GlossaryTerm | undefined {
  const words = identifierWords(identifier);
  let best: GlossaryTerm | undefined;
  let bestLen = 0;
  for (const g of glossary) {
    const termWords = identifierWords(g.term);
    if (termWords.length === 0) continue;
    if (containsRun(words, termWords) && termWords.length > bestLen) {
      best = g;
      bestLen = termWords.length;
    }
  }
  return best;
}

function containsRun(words: string[], run: string[]): boolean {
  outer: for (let i = 0; i + run.length <= words.length; i++) {
    for (let j = 0; j < run.length; j++) {
      // allow simple plurals: "payments" matches term "payment"
      if (words[i + j] !== run[j] && words[i + j] !== `${run[j]}s`) continue outer;
    }
    return true;
  }
  return false;
}
