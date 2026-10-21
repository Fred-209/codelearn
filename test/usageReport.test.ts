import { describe, expect, it } from 'vitest';
import { kindOf, UsageEntry, usageReport } from '../src/store/usageReport';

const now = new Date('2026-10-21T15:00:00');
const e = (at: string, over: Partial<UsageEntry> = {}): UsageEntry => ({
  at: new Date(at).toISOString(),
  provider: 'Claude Code',
  model: 'claude-sonnet-5-5',
  slot: 'standard',
  purpose: 'lesson: LINQ (standard)',
  repo: 'payments',
  input: 4000,
  output: 1200,
  exact: true,
  costUSD: 0.013,
  ...over,
});

describe('usageReport', () => {
  it('says so when nothing has been used', () => {
    expect(usageReport([], now)).toMatch(/hasn't made any AI requests/);
  });

  it('totals today, the last week and all time', () => {
    const report = usageReport(
      [e('2026-09-01T10:00:00'), e('2026-10-18T10:00:00'), e('2026-10-21T09:00:00'), e('2026-10-21T10:00:00', { input: 30_000, output: 5000 })],
      now,
    );
    expect(report).toMatch(/\| Today \| 2 \| 34k \| 6\.2k \| \$0\.03 \|/);
    expect(report).toMatch(/\| Last 7 days \| 3 \|/);
    expect(report).toMatch(/\| All time \| 4 \|/);
  });

  it('groups by model and by kind, and marks estimated tokens', () => {
    const report = usageReport(
      [
        e('2026-10-21T09:00:00'),
        e('2026-10-21T09:05:00', { provider: 'GitHub Copilot', model: 'Claude Haiku 5.5', slot: 'fast', purpose: 'quick explain: Where', input: 900, output: 300, exact: false, costUSD: undefined }),
      ],
      now,
    );
    expect(report).toMatch(/\| Claude Haiku 5\.5 \| GitHub Copilot \| fast \| 1 \| ~900 \| ~300 \|/);
    expect(report).toMatch(/\| quick explain \| 1 \|/);
    expect(report).toMatch(/\| lesson \| 1 \|/);
  });

  it('keeps table cells intact when a purpose contains a pipe', () => {
    expect(usageReport([e('2026-10-21T09:00:00', { purpose: 'explain code: a|b.ts' })], now)).toContain('a\\|b.ts');
  });
});

describe('kindOf', () => {
  it('takes the part before the colon', () => {
    expect(kindOf('walkthrough: Getting payments')).toBe('walkthrough');
    expect(kindOf('build map')).toBe('build map');
  });
});
