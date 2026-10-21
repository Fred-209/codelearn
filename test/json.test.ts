import { describe, expect, it } from 'vitest';
import { extractJson, firstBalancedObject, JsonExtractError } from '../src/ai/json';
import { AIEmptyReplyError, AIReplyCutOffError, completeJson, type AIProvider, type AIRequest } from '../src/ai/provider';

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
  const req: AIRequest = { slot: 'standard', system: 's', user: 'u', justification: 'j', purpose: 'test' };

  it('retries once with the parse error when the reply is not JSON', async () => {
    const replies = ['not json at all', '{"ok": true}'];
    const prompts: string[] = [];
    const provider: AIProvider = {
      name: async () => 'fake',
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

  it('does not ask again for JSON when the reply is empty', async () => {
    let calls = 0;
    const provider: AIProvider = {
      name: async () => 'fake',
      listModels: async () => [],
      modelFor: async () => undefined,
      complete: async () => {
        calls++;
        return { text: '  \n', model: 'GPT Sol' };
      },
    };
    await expect(completeJson(provider, req, (v) => v)).rejects.toBeInstanceOf(AIEmptyReplyError);
    expect(calls).toBe(1);
  });

  it('asks for a shorter reply when the first was cut off, and says so if it happens again', async () => {
    const prompts: string[] = [];
    const cutOff = '{"concepts": [{"name": "MediatR", "summary": "Sends requests to handlers"}, ';
    const provider: AIProvider = {
      name: async () => 'fake',
      listModels: async () => [],
      modelFor: async () => undefined,
      complete: async (r) => {
        prompts.push(r.user);
        return { text: cutOff, model: 'GPT Sol' };
      },
    };
    const err = await completeJson(provider, { ...req, slot: 'deep' }, (v) => v).catch((e) => e);
    expect(err).toBeInstanceOf(AIReplyCutOffError);
    expect(err.message).toMatch(/cut off .*twice.*deep slot/);
    expect(prompts[1]).toContain(`cut off after ${cutOff.length} characters`);
  });

  it('accepts a shorter complete reply after a cut-off one', async () => {
    const replies = ['{"items": [1, 2, ', '{"items": [1]}'];
    const provider: AIProvider = {
      name: async () => 'fake',
      listModels: async () => [],
      modelFor: async () => undefined,
      complete: async () => ({ text: replies.shift()!, model: 'm' }),
    };
    const res = await completeJson(provider, req, (v) => v as { items: number[] });
    expect(res.value.items).toEqual([1]);
  });
});
