// Pulls a JSON object out of a model reply. Models wrap JSON in prose or code
// fences often enough that a plain JSON.parse is not reliable.

export class JsonExtractError extends Error {}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/i);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]);

  const balanced = firstBalancedObject(text);
  if (balanced) candidates.push(balanced);
  candidates.push(text.trim());

  let lastError: unknown;
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (e) {
      lastError = e;
      try {
        return JSON.parse(stripTrailingCommas(c));
      } catch {
        // try the next candidate
      }
    }
  }
  throw new JsonExtractError(`The AI reply was not valid JSON (${(lastError as Error)?.message ?? 'no JSON found'}).`);
}

/** True when the reply starts a JSON object but never finishes it: it was cut off, usually at the output limit. */
export function looksCutOff(text: string): boolean {
  return text.includes('{') && !firstBalancedObject(text);
}

/** Finds the first {...} block with balanced braces, ignoring braces inside strings. */
export function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function stripTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, '$1');
}
