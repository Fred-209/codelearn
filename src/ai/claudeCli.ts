// Talks to the Claude Code command line (`claude -p`) in headless mode. Uses the learner's
// existing Claude login, so there is no API key to manage.
// Pure: no vscode imports, so it can be unit tested.

import * as path from 'path';
import type { ModelInfo, Slot } from './modelPick';
import { pickModel } from './modelPick';
import type { TokenUsage } from './provider';

/** Aliases the CLI resolves to the newest model of each tier. */
export const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'opus', name: 'Claude Opus (latest)', family: 'opus', vendor: 'claude-code', maxInputTokens: 200_000 },
  { id: 'sonnet', name: 'Claude Sonnet (latest)', family: 'sonnet', vendor: 'claude-code', maxInputTokens: 200_000 },
  { id: 'haiku', name: 'Claude Haiku (latest)', family: 'haiku', vendor: 'claude-code', maxInputTokens: 200_000 },
];

/**
 * The model to pass to `--model`. A setting that names one of the aliases picks it;
 * any other non-auto value (e.g. a full model name) goes to the CLI as written.
 */
export function claudeModelFor(slot: Slot, setting = 'auto'): ModelInfo {
  const wanted = setting.trim();
  const picked = pickModel(CLAUDE_MODELS, slot, wanted)!;
  if (!wanted || wanted === 'auto' || picked.id.toLowerCase() === wanted.toLowerCase()) return picked;
  if (CLAUDE_MODELS.some((m) => wanted.toLowerCase().includes(m.family))) {
    // e.g. "claude-opus-5-5": a specific version the CLI understands.
    return { ...picked, id: wanted, name: wanted };
  }
  // Probably a model id from another provider (e.g. Copilot's); use the automatic choice.
  return pickModel(CLAUDE_MODELS, slot, 'auto')!;
}

/** Replaces Claude Code's own agent instructions; the real instructions travel with the prompt. */
const SYSTEM = 'You are a careful teacher of code. Follow the instructions at the start of the user message exactly.';

/**
 * Arguments for one headless request. No tools, no MCP servers, no saved session: a plain
 * question and answer. The prompt goes on stdin (see claudeInput), which has no length
 * limit and needs no shell quoting.
 */
export function claudeArgs(model: string): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--system-prompt',
    SYSTEM,
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
}

/** What to write to the CLI's stdin. */
export function claudeInput(system: string, user: string): string {
  return `${system}\n\n---\n\n${user}`;
}

export interface ClaudeReply {
  text: string;
  model: string;
  usage?: TokenUsage;
}

/** Thrown when the CLI ran but needs the learner to do something (log in, wait for a limit). */
export class ClaudeCliError extends Error {
  constructor(
    message: string,
    readonly needsSetup = false,
  ) {
    super(message);
  }
}

/** Reads the single JSON result `claude -p --output-format json` prints. */
export function parseClaudeOutput(stdout: string, stderr = '', exitCode: number | null = 0): ClaudeReply {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop();
  let result: Record<string, unknown> | undefined;
  try {
    result = line ? (JSON.parse(line) as Record<string, unknown>) : undefined;
  } catch {
    result = undefined;
  }

  const detail = (typeof result?.result === 'string' && result.result) || stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
  if (!result || result.is_error === true || (result.subtype && result.subtype !== 'success')) {
    if (/log ?in|logged in|authenticat|unauthori[sz]ed|invalid api key|oauth/i.test(detail)) {
      throw new ClaudeCliError('Claude Code is not signed in. Run `claude` in a terminal, log in, then try again.', true);
    }
    if (/usage limit|rate limit|quota|credit/i.test(detail)) {
      throw new ClaudeCliError(`Claude Code hit a usage limit: ${firstLine(detail)}`);
    }
    throw new ClaudeCliError(`Claude Code failed: ${firstLine(detail)}`);
  }

  return { text: typeof result.result === 'string' ? result.result : '', model: modelUsed(result), usage: usageOf(result) };
}

type ModelUsage = { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number };

/** Tokens across every model the CLI called, cached prompt tokens included. */
function usageOf(result: Record<string, unknown>): TokenUsage | undefined {
  const usage = result.modelUsage;
  if (!usage || typeof usage !== 'object') return undefined;
  let input = 0;
  let output = 0;
  for (const u of Object.values(usage as Record<string, ModelUsage>)) {
    input += (u?.inputTokens ?? 0) + (u?.cacheReadInputTokens ?? 0) + (u?.cacheCreationInputTokens ?? 0);
    output += u?.outputTokens ?? 0;
  }
  const cost = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined;
  return { input, output, exact: true, costUSD: cost };
}

/** The model that wrote most of the answer, from the result's per-model usage. */
function modelUsed(result: Record<string, unknown>): string {
  const usage = result.modelUsage;
  if (!usage || typeof usage !== 'object') return 'Claude';
  const entries = Object.entries(usage as Record<string, { outputTokens?: number }>);
  if (entries.length === 0) return 'Claude';
  entries.sort((a, b) => (b[1]?.outputTokens ?? 0) - (a[1]?.outputTokens ?? 0));
  return entries[0][0];
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).find((l) => l.trim()) ?? s;
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/**
 * Places the `claude` executable usually lives, in the order to try them. VS Code started
 * from a desktop launcher often has a shorter PATH than a terminal, so the usual install
 * folders are listed explicitly.
 */
export function claudeCandidates(env: Record<string, string | undefined>, platform: string, home: string): string[] {
  const win = platform === 'win32';
  const names = win ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const sep = win ? ';' : ':';
  const join = win ? path.win32.join : path.posix.join;
  const dirs = [
    ...(env.PATH ?? env.Path ?? '').split(sep).filter(Boolean),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    ...(win
      ? [join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm')]
      : ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin']),
  ];
  const out: string[] = [];
  for (const dir of dirs) for (const name of names) out.push(join(dir, name));
  return [...new Set(out)];
}
