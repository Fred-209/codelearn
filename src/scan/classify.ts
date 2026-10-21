// Decides which files matter for learning a repo. Pure.

/** AI instruction files and other places a team writes down its conventions. */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)CLAUDE\.md$/i,
  /(^|\/)GEMINI\.md$/i,
  /^\.github\/copilot-instructions\.md$/i,
  /^\.github\/instructions\/.+\.instructions\.md$/i,
  /^\.github\/prompts\/.+\.prompt\.md$/i,
  /^\.github\/chatmodes\/.+\.md$/i,
  /^\.cursorrules$/i,
  /^\.cursor\/rules\/.+\.(mdc|md)$/i,
  /^\.windsurfrules$/i,
  /^\.clinerules(\/.+)?$/i,
  /^\.claude\/skills\/[^/]+\/SKILL\.md$/i,
  /^\.claude\/commands\/.+\.md$/i,
  /(^|\/)CONTRIBUTING\.md$/i,
  /^docs\/(adr|adrs|decisions|architecture)\/.+\.md$/i,
  /(^|\/)ARCHITECTURE\.md$/i,
  /^README(\.md)?$/i,
  /^[^/]+\/README\.md$/i,
  /^\.editorconfig$/i,
];

/** Files that list dependencies, frameworks and build settings. */
const MANIFEST_PATTERNS: RegExp[] = [
  /(^|\/)package\.json$/i,
  /\.(csproj|fsproj|vbproj)$/i,
  /(^|\/)Directory\.(Build|Packages)\.props$/i,
  /(^|\/)global\.json$/i,
  /\.sln$/i,
  /(^|\/)go\.mod$/i,
  /(^|\/)Cargo\.toml$/i,
  /(^|\/)pyproject\.toml$/i,
  /(^|\/)requirements(-\w+)?\.txt$/i,
  /(^|\/)Pipfile$/i,
  /(^|\/)Gemfile$/i,
  /(^|\/)pom\.xml$/i,
  /(^|\/)build\.gradle(\.kts)?$/i,
  /(^|\/)composer\.json$/i,
  /(^|\/)pubspec\.yaml$/i,
  /(^|\/)mix\.exs$/i,
  /(^|\/)tsconfig\.json$/i,
  /(^|\/)(\.eslintrc(\.\w+)?|eslint\.config\.\w+)$/i,
  /(^|\/)appsettings(\.\w+)?\.json$/i,
];

/**
 * How the software is built, deployed and hosted: CI/CD pipelines, infrastructure as code,
 * containers and hosting-platform config. These say where each part runs (a static web app,
 * a function app, a container), which the code alone often doesn't.
 */
const DEPLOY_PATTERNS: RegExp[] = [
  /^\.github\/workflows\/[^/]+\.ya?ml$/i,
  /(^|\/)azure-pipelines[\w.-]*\.ya?ml$/i,
  /(^|\/)\.?(pipelines?|azure-pipelines|azure|azuredevops|devops|ci|cd|deploy|deployment|deployments)\/(.+\/)?[^/]+\.ya?ml$/i,
  /(^|\/)\.gitlab-ci\.ya?ml$/i,
  /(^|\/)bitbucket-pipelines\.ya?ml$/i,
  /(^|\/)\.circleci\/config\.ya?ml$/i,
  /(^|\/)Jenkinsfile$/i,
  /(^|\/)(cloudbuild|buildspec|appveyor|\.travis|skaffold|serverless|render|azure|app)\.ya?ml$/i,
  /\.(bicep|bicepparam|tf|tfvars)$/i,
  /(^|\/)(azuredeploy|mainTemplate)(\.parameters)?\.json$/i,
  /(^|\/)(staticwebapp\.config|swa-cli\.config|host|function|proxies|vercel|firebase)\.json$/i,
  /(^|\/)(netlify|fly|wrangler)\.toml$/i,
  /(^|\/)(Procfile|Dockerfile|Containerfile)(\.[\w-]+)?$/i,
  /(^|\/)docker-compose[\w.-]*\.ya?ml$/i,
  /(^|\/)(k8s|kubernetes|helm|charts?|manifests|infra|infrastructure|iac|terraform|bicep)\/(.+\/)?[^/]+\.(ya?ml|json)$/i,
];

const CODE_EXTENSIONS = new Set([
  'cs', 'fs', 'vb', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'rb',
  'php', 'swift', 'm', 'mm', 'c', 'h', 'cpp', 'cc', 'hpp', 'dart', 'ex', 'exs', 'erl', 'clj', 'lua', 'r', 'jl',
  'sql', 'sh', 'ps1', 'vue', 'svelte', 'razor', 'cshtml', 'graphql', 'proto', 'tf', 'hs', 'ml', 'elm', 'zig',
]);

/** Markup that binds to code: searched for examples, and summarised for the map. */
const TEMPLATE_EXTENSIONS = new Set([
  'html', 'htm', 'liquid', 'hbs', 'handlebars', 'mustache', 'ejs', 'pug', 'njk', 'jinja', 'jinja2', 'j2', 'twig', 'erb', 'xaml', 'aspx', 'ascx',
]);

export type FileRole = 'instruction' | 'manifest' | 'deploy' | 'code' | 'template' | 'other';

/** Secrets and machine-local settings: never read, never sent. */
const SECRET_PATH =
  /(^|\/)(\.env(\.[\w.-]+)?|local\.settings\.json|(secrets?|credentials)([.-][\w-]+)*\.(json|ya?ml|xml|ini|txt|toml|env|config|properties|cfg)|credentials|[^/]*\.(pem|key|pfx|p12|jks|keystore|crt|cer)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc)$/i;

export function isSecretPath(path: string): boolean {
  return SECRET_PATH.test(path);
}

export function classify(path: string): FileRole {
  if (SECRET_PATH.test(path)) return 'other';
  if (INSTRUCTION_PATTERNS.some((p) => p.test(path))) return 'instruction';
  if (MANIFEST_PATTERNS.some((p) => p.test(path))) return 'manifest';
  if (DEPLOY_PATTERNS.some((p) => p.test(path))) return 'deploy';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  return TEMPLATE_EXTENSIONS.has(ext) ? 'template' : 'other';
}

/** Startup-looking names, with an optional qualifier: "Program.cs", "startup.design.ts", "app.module.ts". */
export const ENTRY_NAMES = /(^|\/)(program|main|index|app|startup|server|application|bootstrap|module|routes?|urls|manage|wsgi|asgi)(\.[a-z][\w-]*)?\.[a-z]+$/i;
const TEST_PATH = /(^|\/)(tests?|specs?|__tests__)(\/|$)|\.(test|spec)\.[a-z]+$|Tests?\.[a-z]+$/i;
/** Code that shows how to use the project rather than being it. */
const EXAMPLE_PATH = /(^|\/)(examples?|samples?|scaffolds?|community|demos?|fixtures?|mocks?|__mocks__|stories|storybook|benchmarks?|e2e|playground|sandbox|docs?)(\/|$)|\.(stories|mock|fixture)\.[a-z]+$/i;
const GENERATED_PATH = /\.d\.ts$|\.g\.(cs|dart)$|\.Designer\.cs$|\.generated\.|(^|\/)(generated|gen)\/|\.pb\.go$|_pb2\.py$|(^|\/)migrations?\//i;

export function isTest(path: string): boolean {
  return TEST_PATH.test(path);
}

/** Tests, examples, samples and generated code: read last, if at all. */
export function isLowValue(path: string): boolean {
  return TEST_PATH.test(path) || EXAMPLE_PATH.test(path) || GENERATED_PATH.test(path);
}

/**
 * Cheap importance from the path alone, for repos over the file limit: instruction files and
 * manifests first, then code (startup files first, examples and tests last), then templates.
 */
export function pathPriority(path: string, role: FileRole): number {
  const base = { instruction: 100, manifest: 90, deploy: 80, code: 50, template: 30, other: 0 }[role];
  if (role !== 'code' && role !== 'template') return base;
  const depth = path.split('/').length;
  let p = base - Math.min(depth, 10) * 0.5;
  if (role === 'code' && ENTRY_NAMES.test(path)) p += 10;
  if (isLowValue(path)) p -= 35;
  return p;
}

/**
 * A rough outline for any language: lines that declare things. Used when no
 * language extension provides symbols.
 */
export function regexOutline(text: string, maxLines = 40): string[] {
  const decl =
    /^\s*(export\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|sealed\s+|partial\s+|async\s+|override\s+|virtual\s+|pub(\(crate\))?\s+|default\s+)*(class|interface|struct|record|enum|trait|impl|type|module|namespace|def|fn|func|function|object|protocol|extension)\b/;
  const method = /^\s*(public|private|protected|internal)\s+[^=;]*\(/;
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    const l = lines[i];
    if (decl.test(l) || method.test(l)) out.push(`${i + 1}: ${l.trim().slice(0, 160)}`);
  }
  return out;
}

/** Counts the lines that start with each 2-level folder, to describe repo shape compactly. */
export function folderSummary(paths: string[], maxEntries = 80): string[] {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split('/');
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : '(root)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxEntries)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} (${n} files)`);
}
