// Turns the log of AI requests into a readable tally. Pure, so it can be unit tested.

import type { Slot } from '../ai/modelPick';

export interface UsageEntry {
  at: string; // ISO time
  provider: string;
  model: string;
  slot: Slot;
  purpose: string;
  repo: string;
  input?: number;
  output?: number;
  /** false when tokens were estimated (Copilot doesn't report them). */
  exact: boolean;
  costUSD?: number;
  /** Lookups the model made in the repo while answering. */
  lookups?: number;
}

interface Totals {
  requests: number;
  input: number;
  output: number;
  cost: number;
  estimated: boolean;
}

function total(entries: UsageEntry[]): Totals {
  const t: Totals = { requests: 0, input: 0, output: 0, cost: 0, estimated: false };
  for (const e of entries) {
    t.requests++;
    t.input += e.input ?? 0;
    t.output += e.output ?? 0;
    t.cost += e.costUSD ?? 0;
    if (!e.exact) t.estimated = true;
  }
  return t;
}

/** "lesson: LINQ (standard)" -> "lesson" */
export function kindOf(purpose: string): string {
  return purpose.split(':')[0].trim() || 'other';
}

function tokens(n: number, estimated = false): string {
  const s = n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return estimated ? `~${s}` : s;
}

function money(n: number): string {
  return n === 0 ? '–' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function groupBy(entries: UsageEntry[], key: (e: UsageEntry) => string): [string, UsageEntry[]][] {
  const groups = new Map<string, UsageEntry[]>();
  for (const e of entries) groups.set(key(e), [...(groups.get(key(e)) ?? []), e]);
  return [...groups].sort((a, b) => b[1].length - a[1].length);
}

export function usageReport(entries: UsageEntry[], now: Date): string {
  if (entries.length === 0) {
    return '# AI usage\n\ncodelearn hasn\'t made any AI requests on this machine yet. Hovers and saved lessons never make requests.';
  }
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000;
  const today = entries.filter((e) => Date.parse(e.at) >= startOfDay);
  const week = entries.filter((e) => Date.parse(e.at) >= weekAgo);
  const hasCost = entries.some((e) => e.costUSD !== undefined);

  const out: string[] = ['# AI usage', ''];
  out.push(`| | Requests | Tokens in | Tokens out |${hasCost ? ' API list price |' : ''}`);
  out.push(`| --- | ---: | ---: | ---: |${hasCost ? ' ---: |' : ''}`);
  for (const [label, list] of [['Today', today], ['Last 7 days', week], ['All time', entries]] as const) {
    const t = total(list);
    out.push(`| ${label} | ${t.requests} | ${tokens(t.input, t.estimated)} | ${tokens(t.output, t.estimated)} |${hasCost ? ` ${money(t.cost)} |` : ''}`);
  }

  out.push('', '## By model, last 7 days', '', '| Model | Through | Used for | Requests | Tokens in | Tokens out |', '| --- | --- | --- | ---: | ---: | ---: |');
  for (const [, list] of groupBy(week, (e) => `${e.provider}\u0000${e.model}`)) {
    const t = total(list);
    const slots = [...new Set(list.map((e) => e.slot))].join(', ');
    out.push(`| ${cell(list[0].model)} | ${cell(list[0].provider)} | ${slots} | ${t.requests} | ${tokens(t.input, t.estimated)} | ${tokens(t.output, t.estimated)} |`);
  }

  out.push('', '## By kind of request, last 7 days', '', '| Kind | Requests | Tokens in | Tokens out |', '| --- | ---: | ---: | ---: |');
  for (const [kind, list] of groupBy(week, (e) => kindOf(e.purpose))) {
    const t = total(list);
    out.push(`| ${cell(kind)} | ${t.requests} | ${tokens(t.input, t.estimated)} | ${tokens(t.output, t.estimated)} |`);
  }

  out.push('', '## Latest requests', '', '| When | What | Repo | Model | In | Out |', '| --- | --- | --- | --- | ---: | ---: |');
  for (const e of [...entries].reverse().slice(0, 30)) {
    const when = new Date(e.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const what = `${e.purpose}${e.lookups ? ` (${e.lookups} ${e.lookups === 1 ? 'lookup' : 'lookups'})` : ''}`;
    out.push(`| ${when} | ${cell(what)} | ${cell(e.repo)} | ${cell(e.model)} | ${tokens(e.input ?? 0, !e.exact)} | ${tokens(e.output ?? 0, !e.exact)} |`);
  }

  out.push(
    '',
    '---',
    '',
    'A retry after an unreadable reply counts as its own request. When the AI looks things up in the repo, each round of lookups sends the conversation again, and the tokens of every round are counted. Token counts marked ~ are estimates from the model\'s tokenizer, because Copilot doesn\'t report them to extensions. Copilot charges AI credits by tokens at each model\'s rate, so the cheapest way to cut usage is a cheaper model in a busy slot (see codelearn: Choose AI models). ' +
      (hasCost ? 'Claude Code reports exact tokens. "API list price" is what the same tokens would cost on the Claude API; a Claude subscription counts them against its usage limits instead.' : ''),
  );
  return out.join('\n');
}
