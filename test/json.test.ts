import { describe, expect, it } from 'vitest';
import { extractJson, firstBalancedObject, JsonExtractError } from '../src/ai/json';
import { completeJson, type AIProvider, type AIRequest } from '../src/ai/provider';

describe('extractJson', () => {
  it('reads plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads JSON in a code fence with prose around it', () => {
    expect(extractJson('Here you go:\n```json\n{"a": [1, 2]}\n```\nHope that helps')).toEqual({ a: [1, 2] });
  });

  it('reads the first balanced object, ignoring braces in strings', () => {
    expect(extractJson('Sure! {"code": "if (x) { y }", "n": 2} trailing')).toEqual({ code: 'if (x) { y }', n: 2 });
  });

  it('tolerates trailing commas', () => {
    expect(extractJson('{"a": [1, 2,],}')).toEqual({ a: [1, 2] });
  });

  it('throws a JsonExtractError when there is no JSON', () => {
    expect(() => extractJson('no json here')).toThrow(JsonExtractError);
  });

  it('finds balanced objects', () => {
    expect(firstBalancedObject('x {"a": {"b": "}"}} y')).toBe('{"a": {"b": "}"}}');
  });
});

describe('completeJson', () => {
  const req: AIRequest = { slot: 'standard', system: 's', user: 'u', justification: 'j' };

  it('retries once with the parse error when the reply is not JSON', async () => {
    const replies = ['not json at all', '{"ok": true}'];
    const prompts: string[] = [];
    const provider: AIProvider = {
      listModels: async () => [],
      modelFor: async () => undefined,
      complete: async (r) => {
        prompts.push(r.user);
        return { text: replies.shift()!, model: 'm' };
      },
    };
    const res = await completeJson(provider, req, (v) => v as { ok: boolean });
    expect(res.value.ok).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('could not be parsed');
  });
});
