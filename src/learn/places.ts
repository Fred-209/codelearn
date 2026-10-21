// Where a file sits in the map: the part of the system, the area and the flows it belongs to.
// Pure.

import type { RepoMap } from '../store/types';

export interface Place {
  type: 'part' | 'area' | 'flow';
  id: string;
  name: string;
}

/** Whether a folder, file or glob from the map covers this file. */
export function covers(pattern: string, file: string): boolean {
  const p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!p) return false;
  if (/[*?]/.test(p)) {
    const re = new RegExp(
      `^${p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '.*')}(/.*)?$`,
    );
    return re.test(file);
  }
  const dir = p.replace(/\/+$/, '');
  return file === dir || file.startsWith(`${dir}/`);
}

/** How much of the path a pattern pins down, so the most specific match comes first. */
function specificity(paths: string[], file: string): number {
  return Math.max(0, ...paths.filter((p) => covers(p, file)).map((p) => p.replace(/\*.*$/, '').length));
}

export function placesFor(map: Pick<RepoMap, 'areas' | 'flows' | 'architecture'>, file: string): Place[] {
  const out: Place[] = [];
  const parts = (map.architecture?.parts ?? [])
    .filter((p) => !p.external && p.paths.some((x) => covers(x, file)))
    .sort((a, b) => specificity(b.paths, file) - specificity(a.paths, file))
    .slice(0, 2);
  for (const p of parts) out.push({ type: 'part', id: p.id, name: p.name });
  const areas = map.areas
    .filter((a) => a.paths.some((x) => covers(x, file)))
    .sort((a, b) => specificity(b.paths, file) - specificity(a.paths, file))
    .slice(0, 2);
  for (const a of areas) out.push({ type: 'area', id: a.id, name: a.name });
  const flows = map.flows.filter((f) => f.files.includes(file) || f.steps?.some((s) => s.file === file)).slice(0, 4);
  for (const f of flows) out.push({ type: 'flow', id: f.id, name: f.name });
  return out;
}

/** The places as one line for a prompt, e.g. "Part of: Runtime (part of the system); Users (area)". */
export function placesText(places: Place[]): string {
  if (places.length === 0) return '';
  const label = { part: 'part of the system', area: 'area', flow: 'flow' };
  return `Where this file sits in the repo map: ${places.map((p) => `${p.name} (${label[p.type]})`).join('; ')}.`;
}
