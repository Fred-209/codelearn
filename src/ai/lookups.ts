// Read-only lookups the AI can make while it answers: search the repo, read lines, list a folder,
// find where a symbol is defined. They run over the files codelearn already read (so never
// secret files or excluded folders), with values that look like secrets masked. Pure.

import { classify, isLowValue } from '../scan/classify';
import type { RepoFile } from '../scan/digest';
import { redactSecrets } from '../scan/redact';

/** What a provider needs to let its model look things up. */
export interface Lookups {
  /** Most lookups (tool calls) allowed for the request. */
  max: number;
  /** Runs one lookup, for providers whose models call tools through codelearn (VS Code models). */
  run: (name: string, input: unknown) => Promise<string>;
  /** The workspace folder on disk, for providers that read files themselves (Claude Code). */
  root?: string;
}

export interface LookupTool {
  name: string;
  description: string;
  inputSchema: object;
}

export const LOOKUP_TOOLS: LookupTool[] = [
  {
    name: 'search',
    description:
      'Search the repository for text. Returns matching lines as "file:line: text". Use a short literal string such as a function name, a route or "data-bind=", or set regex to true. Optionally limit it to a folder.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to find (case-insensitive), or a regular expression when regex is true.' },
        regex: { type: 'boolean' },
        folder: { type: 'string', description: 'Workspace-relative folder to search in. Omit for the whole repository.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_lines',
    description: 'Read lines of a repository file, each prefixed with its 1-based line number. At most 150 lines per lookup.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Workspace-relative path.' },
        start: { type: 'number', description: 'First line, 1-based. Default 1.' },
        end: { type: 'number', description: 'Last line. Default start + 149.' },
      },
      required: ['file'],
    },
  },
  {
    name: 'list_folder',
    description: 'List the files and subfolders of a repository folder, with sizes. Use "" for the root.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string' } }, required: ['folder'] },
  },
  {
    name: 'find_symbol',
    description: 'Find where a class, function, method, type or variable is defined, and a sample of the places that use it.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The exact name, e.g. "UsersService" or "signIn".' } }, required: ['name'] },
  },
];

const MAX_MATCHES = 40;
const PER_FILE = 5;
const MAX_READ = 150;

/** Runs lookups over an in-memory copy of the repo's readable files. */
export class RepoLookup {
  private readonly byPath: Map<string, RepoFile>;
  private readonly ordered: RepoFile[];

  constructor(files: RepoFile[]) {
    this.byPath = new Map(files.map((f) => [f.path, f]));
    // Real code first; tests, examples and generated files last.
    this.ordered = [...files].sort((a, b) => Number(isLowValue(a.path)) - Number(isLowValue(b.path)) || a.path.localeCompare(b.path));
  }

  /** Never throws: a bad lookup comes back as a message the model can act on. */
  run(name: string, input: unknown): string {
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    try {
      switch (name) {
        case 'search':
          return redactSecrets(this.search(text(o.query), o.regex === true, text(o.folder)));
        case 'read_lines':
          return redactSecrets(this.readLines(text(o.file), Number(o.start) || 1, Number(o.end) || undefined));
        case 'list_folder':
          return this.listFolder(text(o.folder));
        case 'find_symbol':
          return redactSecrets(this.findSymbol(text(o.name)));
        default:
          return `Unknown lookup "${name}". Use one of: ${LOOKUP_TOOLS.map((t) => t.name).join(', ')}.`;
      }
    } catch (e) {
      return `The lookup failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  search(query: string, regex = false, folder = ''): string {
    if (!query.trim()) return 'Give some text to search for.';
    let re: RegExp;
    try {
      re = regex ? new RegExp(query, 'i') : new RegExp(escapeRe(query), 'i');
    } catch (e) {
      return `Not a valid regular expression: ${e instanceof Error ? e.message : e}`;
    }
    const prefix = cleanPath(folder);
    const lines: string[] = [];
    let total = 0;
    let files = 0;
    for (const f of this.ordered) {
      if (prefix && !f.path.startsWith(`${prefix}/`) && f.path !== prefix) continue;
      const text = f.text.split(/\r?\n/);
      let inFile = 0;
      for (let i = 0; i < text.length; i++) {
        if (text[i].length > 2000 || !re.test(text[i])) continue;
        total++;
        if (inFile === 0) files++;
        inFile++;
        if (inFile <= PER_FILE && lines.length < MAX_MATCHES) lines.push(`${f.path}:${i + 1}: ${text[i].trim().slice(0, 200)}`);
      }
    }
    if (total === 0) return `No matches for "${query}"${prefix ? ` in ${prefix}` : ''}.`;
    const head = `${total} matching lines in ${files} files${lines.length < total ? ` (showing ${lines.length}, at most ${PER_FILE} per file)` : ''}:`;
    return [head, ...lines].join('\n');
  }

  readLines(file: string, start = 1, end?: number): string {
    const f = this.resolve(file);
    if (typeof f === 'string') return f;
    const text = f.text.split(/\r?\n/);
    const from = Math.max(1, Math.floor(start));
    const to = Math.min(text.length, Math.floor(end ?? from + MAX_READ - 1), from + MAX_READ - 1);
    if (from > text.length) return `${f.path} has only ${text.length} lines.`;
    const out = text.slice(from - 1, to).map((l, i) => `${from + i}| ${l.slice(0, 300)}`);
    return `${f.path}, lines ${from}-${to} of ${text.length}:\n${out.join('\n')}`;
  }

  listFolder(folder: string): string {
    const prefix = cleanPath(folder);
    const folders = new Map<string, number>();
    const files: string[] = [];
    for (const f of this.byPath.values()) {
      if (prefix && !f.path.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? f.path.slice(prefix.length + 1) : f.path;
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        const name = rest.slice(0, slash);
        folders.set(name, (folders.get(name) ?? 0) + 1);
      } else {
        files.push(`${rest} (${f.text.split('\n').length} lines)`);
      }
    }
    if (folders.size === 0 && files.length === 0) return `No folder "${prefix}" among the files codelearn reads.`;
    const lines = [
      ...[...folders].sort((a, b) => a[0].localeCompare(b[0])).map(([name, n]) => `${name}/ (${n} files)`),
      ...files.sort(),
    ];
    const shown = lines.slice(0, 150);
    return `${prefix || '(repository root)'}:\n${shown.join('\n')}${lines.length > shown.length ? `\n… and ${lines.length - shown.length} more` : ''}`;
  }

  findSymbol(name: string): string {
    const n = name.trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(n)) return 'Give a single name, such as UsersService or signIn.';
    const word = new RegExp(`(^|[^\\w$])${escapeRe(n)}(?![\\w$])`);
    const defs = definitionPatterns(n);
    const definitions: string[] = [];
    const uses: string[] = [];
    let useCount = 0;
    for (const f of this.ordered) {
      const role = classify(f.path);
      if (role !== 'code' && role !== 'template') continue;
      const text = f.text.split(/\r?\n/);
      let usesHere = 0;
      for (let i = 0; i < text.length; i++) {
        const l = text[i];
        if (l.length > 2000 || !word.test(l)) continue;
        if (defs.some((re) => re.test(l))) {
          if (definitions.length < 8) definitions.push(`${f.path}:${i + 1}: ${l.trim().slice(0, 200)}`);
        } else {
          useCount++;
          if (usesHere++ < 2 && uses.length < 15) uses.push(`${f.path}:${i + 1}: ${l.trim().slice(0, 200)}`);
        }
      }
    }
    if (definitions.length === 0 && useCount === 0) return `"${n}" isn't in the files codelearn reads. It may come from a library.`;
    return [
      definitions.length ? `Defined at:\n${definitions.join('\n')}` : `No definition found for "${n}" in the repository; it may come from a library.`,
      useCount ? `Used on ${useCount} lines${uses.length < useCount ? `, for example` : ''}:\n${uses.join('\n')}` : 'No uses found.',
    ].join('\n\n');
  }

  /** A file by path, tolerating "./", leading slashes and a missing folder; else a hint. */
  private resolve(file: string): RepoFile | string {
    const p = cleanPath(file);
    const exact = this.byPath.get(p);
    if (exact) return exact;
    const tail = p.split('/').slice(-2).join('/');
    const similar = [...this.byPath.keys()].filter((k) => k.endsWith(`/${tail}`) || k === tail);
    if (similar.length === 1) return this.byPath.get(similar[0])!;
    const base = p.split('/').pop() ?? p;
    const named = similar.length ? similar : [...this.byPath.keys()].filter((k) => k.endsWith(`/${base}`) || k === base);
    return named.length ? `No file "${p}". Did you mean: ${named.slice(0, 5).join(', ')}?` : `No file "${p}" among the files codelearn reads.`;
  }
}

/** Lines that declare `name` in common languages. */
function definitionPatterns(name: string): RegExp[] {
  const n = escapeRe(name);
  return [
    new RegExp(`\\b(class|interface|enum|struct|record|trait|type|function|def|func|fn|module|namespace|object|protocol|typealias|delegate)\\s+${n}\\b`),
    new RegExp(`\\b(const|let|var|val)\\s+${n}\\s*(:[^=]*)?=`),
    new RegExp(`^\\s*(export\\s+)?(default\\s+)?(async\\s+)?${n}\\s*[:=]\\s*(async\\s+)?(function\\b|\\([^)]*\\)\\s*=>|[\\w$]+\\s*=>)`),
    new RegExp(`^\\s*((public|private|protected|internal|static|async|override|virtual|abstract|sealed|readonly|export|get|set)\\s+)*([\\w$.<>\\[\\],?]+\\s+)?${n}\\s*(<[^>]*>)?\\s*\\([^;]*\\)\\s*(:[^{;]*)?\\s*(\\{|=>|$)`),
    new RegExp(`^func\\s+(\\([^)]*\\)\\s*)?${n}\\s*\\(`),
  ];
}

function cleanPath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The note added to a prompt when the model can look things up. Paths in its answer must stay
 * workspace-relative, so citations can be checked.
 */
/**
 * Rounds of lookups for a request allowed `max` lookups. Every round sends the whole
 * conversation again, so lookups are asked for in batches and rounds stay few.
 */
export function lookupRounds(max: number): number {
  return Math.max(1, Math.min(3, Math.ceil(max / 4)));
}

export function lookupNote(max: number, how: string): string {
  const rounds = lookupRounds(max);
  return `\n\nYou can look things up in the repository before you answer: ${how} You have at most ${max} lookups in ${rounds} ${rounds === 1 ? 'round' : 'rounds'}, so ask for several at once, and only look up what the code above doesn't show. In your answer, file paths must be relative to the repository root, and quotes must be copied exactly from the files.`;
}
