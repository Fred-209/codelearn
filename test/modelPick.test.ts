import { describe, expect, it } from 'vitest';
import { effortFor, ModelInfo, pickModel, versionOf } from '../src/ai/modelPick';

const m = (name: string, family = name.toLowerCase().replace(/\s+/g, '-'), maxInputTokens = 128_000): ModelInfo => ({
  id: family,
  name,
  family,
  vendor: 'copilot',
  maxInputTokens,
});

const copilot = [m('GPT-4o'), m('GPT-5 mini'), m('Claude Sonnet 5.5'), m('Claude Opus 5.5'), m('Claude Haiku 5.5'), m('Claude Opus 4.5')];

describe('pickModel', () => {
  it('picks the strongest model for deep work, newest version first', () => {
    expect(pickModel(copilot, 'deep')?.name).toBe('Claude Opus 5.5');
  });

  it('picks a mid-tier model for standard work', () => {
    expect(pickModel(copilot, 'standard')?.name).toBe('Claude Sonnet 5.5');
  });

  it('picks a small model for fast work', () => {
    expect(pickModel(copilot, 'fast')?.name).toBe('Claude Haiku 5.5');
  });

  it('honours an explicit choice by id, family or name fragment', () => {
    expect(pickModel(copilot, 'deep', 'gpt-4o')?.name).toBe('GPT-4o');
    expect(pickModel(copilot, 'fast', 'sonnet')?.name).toBe('Claude Sonnet 5.5');
  });

  it('falls back to auto when the chosen model is gone', () => {
    expect(pickModel(copilot, 'deep', 'some-retired-model')?.name).toBe('Claude Opus 5.5');
  });

  it('treats GPT Luna as a fast model and GPT Sol as a deep one', () => {
    const gpt = [m('GPT-5.6 Luna'), m('GPT-6 Luna'), m('GPT-6 Sol'), m('GPT-6.1 Sol')];
    expect(pickModel(gpt, 'fast')?.name).toBe('GPT-6 Luna');
    expect(pickModel(gpt, 'deep')?.name).toBe('GPT-6.1 Sol');
    expect(pickModel(gpt, 'standard')?.name).toBe('GPT-6.1 Sol');
  });

  it('recommends Opus, Sonnet and Haiku when Copilot offers both families', () => {
    const both = [...copilot, m('GPT-6.1 Sol'), m('GPT-6 Luna')];
    expect(pickModel(both, 'deep')?.name).toBe('Claude Opus 5.5');
    expect(pickModel(both, 'standard')?.name).toBe('Claude Sonnet 5.5');
    expect(pickModel(both, 'fast')?.name).toBe('Claude Haiku 5.5');
  });

  it('recommends high effort for deep work, medium for standard and low for fast', () => {
    expect(effortFor('deep')).toBe('high');
    expect(effortFor('standard')).toBe('medium');
    expect(effortFor('fast')).toBe('low');
    expect(effortFor('fast', 'max')).toBe('max');
    expect(effortFor('deep', 'nonsense')).toBe('high');
  });

  it('falls back to the largest context window for deep when nothing matches', () => {
    const others = [m('Alpha', 'alpha', 32_000), m('Beta', 'beta', 200_000)];
    expect(pickModel(others, 'deep')?.name).toBe('Beta');
    expect(pickModel(others, 'fast')?.name).toBe('Alpha');
  });

  it('returns undefined with no models', () => {
    expect(pickModel([], 'deep')).toBeUndefined();
  });

  it('reads version numbers from names', () => {
    expect(versionOf(m('Claude Opus 4.5'))).toBe(4.5);
    expect(versionOf(m('GPT-5'))).toBe(5);
  });
});
