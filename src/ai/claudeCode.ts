import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CLAUDE_MODELS, claudeArgs, claudeCandidates, ClaudeCliError, claudeInput, claudeModelFor, parseClaudeOutput } from './claudeCli';
import type { ModelInfo, Slot } from './modelPick';
import { AIProvider, AIRequest, AIResult, AIUnavailableError } from './provider';

/** How to start the CLI: a native binary, or the JS entry point run by VS Code's own Node. */
interface Launch {
  command: string;
  prefix: string[];
  env?: Record<string, string>;
  shell?: boolean;
}

const TIMEOUT_MS = 10 * 60 * 1000;
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

/**
 * Uses Claude Code's command line in headless mode (`claude -p`), signed in with the
 * learner's own Claude account. For machines without GitHub Copilot.
 */
export class ClaudeCodeProvider implements AIProvider {
  private launch: Launch | undefined;

  constructor(private readonly workDir: vscode.Uri) {}

  async name(): Promise<string> {
    return 'Claude Code';
  }

  /** Whether the CLI can be found. Doesn't check the login; the first request does. */
  async available(): Promise<boolean> {
    return !!(await this.find());
  }

  async listModels(): Promise<ModelInfo[]> {
    return (await this.find()) ? CLAUDE_MODELS : [];
  }

  async modelFor(slot: Slot): Promise<ModelInfo | undefined> {
    return (await this.find()) ? claudeModelFor(slot, settingFor(slot)) : undefined;
  }

  async complete(req: AIRequest, token?: vscode.CancellationToken): Promise<AIResult> {
    const launch = await this.find();
    if (!launch) {
      throw new AIUnavailableError(
        'Claude Code was not found. Install it (https://claude.com/claude-code) and log in, or set codelearn.claudeCode.path to the `claude` executable.',
      );
    }
    const model = claudeModelFor(req.slot, settingFor(req.slot));
    // Run outside the repo so the CLI doesn't pick up the project's own CLAUDE.md or settings.
    await fs.promises.mkdir(this.workDir.fsPath, { recursive: true });

    const { stdout, stderr, code } = await run(launch, claudeArgs(model.id), claudeInput(req.system, req.user), this.workDir.fsPath, token);
    try {
      const reply = parseClaudeOutput(stdout, stderr, code);
      return { text: reply.text, model: reply.model };
    } catch (e) {
      if (e instanceof ClaudeCliError && e.needsSetup) throw new AIUnavailableError(e.message);
      throw e;
    }
  }

  private async find(): Promise<Launch | undefined> {
    const configured = vscode.workspace.getConfiguration('codelearn').get<string>('claudeCode.path', '').trim();
    if (configured) return launchFor(configured);
    if (this.launch) return this.launch;

    for (const candidate of claudeCandidates(process.env, process.platform, os.homedir())) {
      if (await isFile(candidate)) return (this.launch = launchFor(candidate));
    }
    // Last resort: the copy of the CLI that ships inside the Claude Code VS Code extension.
    const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
    const bundled = ext && (await findBundled(ext.extensionPath));
    return bundled ? (this.launch = launchFor(bundled)) : undefined;
  }
}

function settingFor(slot: Slot): string {
  return vscode.workspace.getConfiguration('codelearn').get<string>(`models.${slot}`, 'auto');
}

function launchFor(file: string): Launch {
  if (/\.(c?js|mjs)$/i.test(file)) {
    return { command: process.execPath, prefix: [file], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { command: file, prefix: [], shell: /\.(cmd|bat)$/i.test(file) };
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Looks a few folders deep for the CLI inside the extension: a native binary, else cli.js. */
async function findBundled(root: string): Promise<string | undefined> {
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
  let script: string | undefined;
  const walk = async (dir: string, depth: number): Promise<string | undefined> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === binary) return full;
      if (e.isFile() && e.name === 'cli.js' && !script) script = full;
    }
    if (depth === 0) return undefined;
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
        const found = await walk(path.join(dir, e.name), depth - 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return (await walk(root, 3)) ?? script;
}

function run(
  launch: Launch,
  args: string[],
  input: string,
  cwd: string,
  token?: vscode.CancellationToken,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.prefix, ...(launch.shell ? args.map(quoteForShell) : args)], {
      cwd,
      env: { ...process.env, ...launch.env },
      shell: launch.shell,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancel?.dispose();
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('Claude Code took longer than 10 minutes and was stopped.')));
    }, TIMEOUT_MS);
    const cancel = token?.onCancellationRequested(() => {
      child.kill();
      finish(() => reject(new vscode.CancellationError()));
    });

    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e) => finish(() => reject(new AIUnavailableError(`Could not start Claude Code (${launch.command}): ${e.message}`))));
    child.on('close', (code) => finish(() => resolve({ stdout, stderr, code })));
    child.stdin.on('error', () => undefined); // the process may exit before reading everything
    child.stdin.end(input, 'utf8');
  });
}

/** Only used for .cmd shims on Windows, which have to go through the shell. */
function quoteForShell(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}
