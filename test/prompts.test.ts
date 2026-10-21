import { describe, expect, it } from 'vitest';
import { learnerText, lessonPrompt, mapPrompt } from '../src/ai/prompts';

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
    const p = lessonPrompt({ name: 'LINQ', kind: 'library', summary: '' }, 'scratch', undefined, '', 'the example is wrong');
    expect(p.user).toContain('the example is wrong');
    expect(p.user).toContain('from-scratch');
  });
});
