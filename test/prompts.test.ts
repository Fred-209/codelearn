import { describe, expect, it } from 'vitest';
import { divePrompt, learnerText, lessonPrompt, mapContext, mapPrompt } from '../src/ai/prompts';

describe('prompts', () => {
  it('describes the learner without assuming anything when there is no profile', () => {
    expect(learnerText(undefined)).toContain('draw no comparisons');
  });

  it('lists what the learner knows', () => {
    const t = learnerText({ known: ['TypeScript', 'React'], experience: 'professional', updatedAt: '' });
    expect(t).toContain('TypeScript, React');
    expect(t).toContain('professional');
  });

  it('asks for citations with exact quotes and treats instruction files as intent', () => {
    const p = mapPrompt('DIGEST', undefined);
    expect(p.system).toContain('EXACT quote');
    expect(p.user).toContain('DIGEST');
    expect(p.user).toContain('contradicted');
  });

  it('passes learner feedback into lesson rewrites', () => {
    const p = lessonPrompt({ name: 'LINQ', kind: 'library', summary: '' }, 'scratch', undefined, { general: true, feedback: 'the example is wrong' });
    expect(p.user).toContain('the example is wrong');
    expect(p.user).toContain('from-scratch');
  });

  it('asks general lessons for search patterns and official docs, and repo lessons to teach with repo code', () => {
    const general = lessonPrompt({ name: 'Knockout bindings', kind: 'library', summary: '' }, 'standard', undefined, { general: true, docsSite: 'knockoutjs.com' });
    expect(general.user).toContain('"patterns"');
    expect(general.user).toContain('OFFICIAL documentation');
    expect(general.user).toContain('knockoutjs.com');
    const repo = lessonPrompt({ name: 'Publishing', kind: 'architecture', summary: '' }, 'standard', undefined, { general: false, repo: 'src/publishing/publisher.ts:12' });
    expect(repo.user).toContain('src/publishing/publisher.ts:12');
    expect(repo.user).toContain('"docs": []');
  });

  it('asks a thorough survey for flows per part, the architecture and where things run', () => {
    const p = mapPrompt('DIGEST', undefined, 'thorough');
    expect(p.user).toContain('at least one for each part');
    expect(p.user).toContain('"runs"');
    expect(p.user).toContain('Static Web Apps');
    expect(mapPrompt('DIGEST', undefined).user).not.toContain('at least one for each part');
  });

  it('gives a deep dive the map so far and the code with line numbers', () => {
    const ctx = mapContext({
      overview: 'A portal.',
      areas: [],
      flows: [],
      architecture: { summary: '', parts: [{ id: 'runtime', name: 'Runtime', summary: 'Widgets.', paths: ['src'], runs: 'browser' }], links: [] },
    });
    expect(ctx).toContain('- runtime: Runtime, browser. Widgets.');
    const p = divePrompt({ name: 'Signing in', summary: '', files: ['a.ts'] }, [{ file: 'a.ts', code: '1| x' }], ctx, [{ id: 'knockout', name: 'Knockout' }], undefined);
    expect(p.user).toContain('### a.ts');
    expect(p.user).toContain('knockout (Knockout)');
  });
});
