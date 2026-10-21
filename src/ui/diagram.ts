// Draws the map's architecture as an SVG: one box per part, an arrow per link. Rows run top to
// bottom along the links (what starts things at the top, outside services at the bottom), so a
// long chain grows down the panel rather than off its side. Pure; colours come from the theme
// through CSS classes in render.ts.

import type { Architecture } from '../store/types';

const BOX_W = 176;
const BOX_H = 58;
const GAP_X = 28; // between boxes in a row
const ROW_GAP = 46; // between rows, room for the arrows
const LANE_W = 14; // room a link takes in a row it passes through
const PAD = 12;

interface Point {
  x: number;
  y: number;
}

export interface Layout {
  width: number;
  height: number;
  boxes: Map<string, { x: number; y: number; row: number }>;
  /** Each link's path by its index in `links`, from where it starts to the box it points at. */
  routes: Map<number, Point[]>;
}

interface Item {
  key: string;
  width: number;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/**
 * Layered layout: cycles are cut, each part goes one row below the lowest part that points at
 * it, a link that skips rows gets a lane in each row it passes, and rows are reordered a few
 * times to bring linked parts closer together.
 */
export function layout(a: Architecture): Layout {
  const ids = a.parts.map((p) => p.id);
  const known = new Set(ids);
  const links = a.links.map((l, i) => ({ from: l.from, to: l.to, i })).filter((l) => known.has(l.from) && known.has(l.to) && l.from !== l.to);

  // A link that closes a cycle is laid out the other way round, then drawn pointing back up.
  const out = new Map<string, typeof links>();
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const l of links) {
    push(out, l.from, l);
    incoming.set(l.to, incoming.get(l.to)! + 1);
  }
  const reversed = new Set<number>();
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string) => {
    state.set(id, 'open');
    for (const l of out.get(id) ?? []) {
      const s = state.get(l.to);
      if (s === 'open') reversed.add(l.i);
      else if (!s) visit(l.to);
    }
    state.set(id, 'done');
  };
  for (const id of [...ids.filter((id) => incoming.get(id) === 0), ...ids]) if (!state.has(id)) visit(id);
  const edges = links.map((l) => (reversed.has(l.i) ? { i: l.i, from: l.to, to: l.from } : l));

  // Rows by longest path from the top.
  const row = new Map(ids.map((id) => [id, 0]));
  const below = new Map<string, string[]>();
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) {
    push(below, e.from, e.to);
    indeg.set(e.to, indeg.get(e.to)! + 1);
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const to of below.get(id) ?? []) {
      row.set(to, Math.max(row.get(to)!, row.get(id)! + 1));
      indeg.set(to, indeg.get(to)! - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  // Outside services that only get called line up along the bottom.
  const bottom = Math.max(0, ...row.values());
  for (const p of a.parts) if (p.external && !below.has(p.id)) row.set(p.id, bottom);

  const rows: Item[][] = Array.from({ length: bottom + 1 }, () => []);
  for (const id of ids) rows[row.get(id)!].push({ key: id, width: BOX_W });
  // The boxes and lanes each link passes, top to bottom.
  const chain = new Map<number, string[]>();
  for (const e of edges) {
    const keys = [e.from];
    for (let r = row.get(e.from)! + 1; r < row.get(e.to)!; r++) {
      const key = `lane:${e.i}:${r}`;
      rows[r].push({ key, width: LANE_W });
      keys.push(key);
    }
    keys.push(e.to);
    chain.set(e.i, keys);
  }
  const above = new Map<string, string[]>();
  const under = new Map<string, string[]>();
  for (const keys of chain.values()) {
    for (let k = 0; k + 1 < keys.length; k++) {
      push(under, keys[k], keys[k + 1]);
      push(above, keys[k + 1], keys[k]);
    }
  }

  // Centre x of every box and lane, each row centred in the widest.
  const x = new Map<string, number>();
  const rowWidth = (r: Item[]) => r.reduce((s, it) => s + it.width, 0) + Math.max(0, r.length - 1) * GAP_X;
  const place = (): number => {
    const width = Math.max(BOX_W, ...rows.map(rowWidth));
    for (const r of rows) {
      let cur = PAD + (width - rowWidth(r)) / 2;
      for (const it of r) {
        x.set(it.key, cur + it.width / 2);
        cur += it.width + GAP_X;
      }
    }
    return width;
  };
  place();
  // Sweep down then up, moving each row towards the middle of what it links to.
  for (let sweep = 0; sweep < 4; sweep++) {
    const downward = sweep % 2 === 0;
    const order = rows.map((_, r) => r);
    if (!downward) order.reverse();
    for (const r of order.slice(1)) {
      const near = downward ? above : under;
      const centre = (it: Item) => {
        const n = near.get(it.key) ?? [];
        return n.length ? n.reduce((s, k) => s + x.get(k)!, 0) / n.length : x.get(it.key)!;
      };
      const keyed = new Map(rows[r].map((it) => [it, centre(it)]));
      rows[r].sort((p, q) => keyed.get(p)! - keyed.get(q)!);
      place();
    }
  }
  const contentWidth = place();

  const top = (r: number) => PAD + r * (BOX_H + ROW_GAP);
  const boxes = new Map<string, { x: number; y: number; row: number }>();
  for (const id of ids) boxes.set(id, { x: x.get(id)! - BOX_W / 2, y: top(row.get(id)!), row: row.get(id)! });

  // Links leave from the bottom of a box and arrive at the top of the next, each at its own spot.
  const outAt = new Map<number, number>();
  const inAt = new Map<number, number>();
  const leaving = new Map<string, number[]>();
  const arriving = new Map<string, number[]>();
  for (const e of edges) {
    push(leaving, e.from, e.i);
    push(arriving, e.to, e.i);
  }
  const spread = (lists: Map<string, number[]>, at: Map<number, number>, other: (i: number) => number) => {
    for (const [id, list] of lists) {
      list.sort((p, q) => other(p) - other(q));
      list.forEach((i, k) => at.set(i, boxes.get(id)!.x + (BOX_W * (k + 1)) / (list.length + 1)));
    }
  };
  spread(leaving, outAt, (i) => x.get(chain.get(i)![1])!);
  spread(arriving, inAt, (i) => x.get(chain.get(i)!.at(-2)!)!);

  const routes = new Map<number, Point[]>();
  for (const e of edges) {
    const keys = chain.get(e.i)!;
    const points: Point[] = [{ x: outAt.get(e.i)!, y: top(row.get(e.from)!) + BOX_H }];
    for (const key of keys.slice(1, -1)) {
      const r = Number(key.split(':')[2]);
      points.push({ x: x.get(key)!, y: top(r) }, { x: x.get(key)!, y: top(r) + BOX_H });
    }
    points.push({ x: inAt.get(e.i)!, y: top(row.get(e.to)!) });
    routes.set(e.i, reversed.has(e.i) ? points.reverse() : points);
  }

  const height = PAD * 2 + rows.length * BOX_H + (rows.length - 1) * ROW_GAP;
  return { width: PAD * 2 + contentWidth, height, boxes, routes };
}

/** Smooth curves between rows, straight lines through the rows a link passes. */
function pathThrough(points: Point[]): string {
  let d = `M${points[0].x},${points[0].y}`;
  for (let k = 1; k < points.length; k++) {
    const p = points[k - 1];
    const q = points[k];
    if (p.x === q.x) d += ` L${q.x},${q.y}`;
    else {
      const mid = (p.y + q.y) / 2;
      d += ` C${p.x},${mid} ${q.x},${mid} ${q.x},${q.y}`;
    }
  }
  return d;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Up to `lines` lines of about `width` characters, the last one cut with an ellipsis. */
function wrap(text: string, width: number, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = `${kept[lines - 1].slice(0, width - 1)}…`;
    return kept;
  }
  return out.map((l) => (l.length > width ? `${l.slice(0, width - 1)}…` : l));
}

export function renderDiagram(a: Architecture): string {
  if (a.parts.length === 0) return '';
  const { width, height, boxes, routes } = layout(a);
  const name = (id: string) => a.parts.find((p) => p.id === id)?.name ?? id;
  const edges = a.links.flatMap((l, i) => {
    const points = routes.get(i);
    if (!points) return [];
    const inferred = !l.evidence?.verified;
    const tip = `${name(l.from)} → ${name(l.to)}: ${l.how}${inferred ? " (the AI's inference)" : ''}`;
    return [`<path class="edge${inferred ? ' inferred' : ''}" d="${pathThrough(points)}" marker-end="url(#arrow)"><title>${esc(tip)}</title></path>`];
  });
  const nodes = a.parts.map((p) => {
    const b = boxes.get(p.id)!;
    const title = wrap(p.name, 24, 2);
    const runs = p.runs ? wrap(p.runs, 27, 1)[0] : p.external ? 'outside this repo' : '';
    const lines = [
      ...title.map((t, i) => `<text class="name" x="${b.x + 10}" y="${b.y + 20 + i * 15}">${esc(t)}</text>`),
      runs ? `<text class="runs" x="${b.x + 10}" y="${b.y + BOX_H - 9}">${esc(runs)}</text>` : '',
    ];
    return `<g class="part${p.external ? ' external' : ''}" data-action="map" data-type="part" data-id="${esc(p.id)}" tabindex="0" role="button"><title>${esc(`${p.name}: ${p.summary}`)}</title><rect x="${b.x}" y="${b.y}" width="${BOX_W}" height="${BOX_H}" rx="6"/>${lines.join('')}</g>`;
  });
  return `<svg class="diagram" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Diagram of the parts of the system and how they connect">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead"/></marker></defs>
${edges.join('\n')}
${nodes.join('\n')}
</svg>`;
}
