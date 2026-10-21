import { describe, expect, it } from 'vitest';
import { claudeArgs, claudeCandidates, ClaudeCliError, claudeInput, claudeModelFor, parseClaudeOutput } from '../src/ai/claudeCli';
import { chooseProvider } from '../src/ai/providerChoice';

const ok = (result: string, usage: Record<string, { outputTokens: number }> = { 'claude-sonnet-5-5': { outputTokens: 10 } }) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, modelUsage: usage });

describe('claudeModelFor', () => {
  it('maps the slots to opus, sonnet and haiku', () => {
    expect(claudeModelFor('deep').id).toBe('opus');
    expect(claudeModelFor('standard').id).toBe('sonnet');
    expect(claudeModelFor('fast').id).toBe('haiku');
  });

  it('honours an alias, and passes a full Claude model name through', () => {
    expect(claudeModelFor('fast', 'sonnet').id).toBe('sonnet');
    expect(claudeModelFor('deep', 'claude-opus-5-5').id).toBe('claude-opus-5-5');
  });

  it("ignores another provider's model id", () => {
    expect(claudeModelFor('deep', 'gpt-4o').id).toBe('opus');
  });
});

describe('claudeArgs / claudeInput', () => {
  it('runs headless with JSON output, no tools and no saved session', () => {
    const args = claudeArgs('haiku');
    expect(args.slice(0, 5)).toEqual(['-p', '--output-format', 'json', '--model', 'haiku']);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--effort');
    expect(claudeArgs('opus', 'high').slice(-2)).toEqual(['--effort', 'high']);
  });

  it('sends the instructions ahead of the content on stdin', () => {
    expect(claudeInput('Do X.', 'code')).toBe('Do X.\n\n---\n\ncode');
  });
});

describe('parseClaudeOutput', () => {
  it('returns the text and the model that wrote it', () => {
    const usage = { 'claude-haiku-5-5': { outputTokens: 3 }, 'claude-opus-5-5': { outputTokens: 900 } };
    expect(parseClaudeOutput(`${ok('{"a":1}', usage)}\n`)).toMatchObject({ text: '{"a":1}', model: 'claude-opus-5-5' });
  });

  it('adds up tokens across models, cached prompt tokens included', () => {
    const out = JSON.stringify({
      is_error: false,
      result: 'x',
      total_cost_usd: 0.013,
      modelUsage: {
        'claude-haiku-5-5': { inputTokens: 2000, outputTokens: 100 },
        'claude-sonnet-5-5': { inputTokens: 2, cacheReadInputTokens: 4000, cacheCreationInputTokens: 300, outputTokens: 1200 },
      },
    });
    expect(parseClaudeOutput(out).usage).toEqual({ input: 6302, output: 1300, exact: true, costUSD: 0.013 });
  });

  it('ignores log lines before the result', () => {
    expect(parseClaudeOutput(`warming up\n${ok('hi')}`).text).toBe('hi');
  });

  it('asks the learner to log in when Claude Code is signed out', () => {
    const out = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' });
    expect(() => parseClaudeOutput(out)).toThrowError(/not signed in/);
    try {
      parseClaudeOutput(out);
    } catch (e) {
      expect((e as ClaudeCliError).needsSetup).toBe(true);
    }
  });

  it('reports a usage limit plainly', () => {
    const out = JSON.stringify({ is_error: true, result: 'Claude usage limit reached. Your limit will reset at 5pm.' });
    expect(() => parseClaudeOutput(out)).toThrowError(/usage limit/);
  });

  it('falls back to stderr when there is no JSON at all', () => {
    expect(() => parseClaudeOutput('', 'error: unknown option --tools', 1)).toThrowError(/unknown option --tools/);
  });
});

describe('claudeCandidates', () => {
  it('checks PATH first, then the usual install folders', () => {
    const c = claudeCandidates({ PATH: '/usr/bin:/opt/x' }, 'linux', '/home/fred');
    expect(c[0]).toBe('/usr/bin/claude');
    expect(c).toContain('/home/fred/.local/bin/claude');
    expect(c).toContain('/home/fred/.claude/local/claude');
    expect(new Set(c).size).toBe(c.length);
  });

  it('looks for .exe and .cmd on Windows', () => {
    const c = claudeCandidates({ Path: 'C:\\tools', APPDATA: 'C:\\Users\\f\\AppData\\Roaming' }, 'win32', 'C:\\Users\\f');
    expect(c).toContain('C:\\tools\\claude.exe');
    expect(c).toContain('C:\\Users\\f\\AppData\\Roaming\\npm\\claude.cmd');
  });
});

describe('chooseProvider', () => {
  it('uses the explicit setting', () => {
    expect(chooseProvider('claude-code', true, false)).toBe('claude-code');
    expect(chooseProvider('copilot', false, true)).toBe('copilot');
  });

  it('prefers Copilot automatically, then Claude Code', () => {
    expect(chooseProvider('auto', true, true)).toBe('copilot');
    expect(chooseProvider('auto', false, true)).toBe('claude-code');
    expect(chooseProvider('auto', false, false)).toBeUndefined();
  });
});
