// Shapes of everything codelearn saves. All of it lives in VS Code's private
// extension storage on this machine; nothing is written into the repo.

/** Bump when RepoMap changes shape, and add a step to migrateMap so saved maps keep working. */
export const MAP_VERSION = 3;

/** A pointer into the code backing a claim. `quote` lets us re-find the line if it moved. */
export interface Citation {
  file: string; // workspace-relative, forward slashes
  line: number; // 1-based
  quote?: string; // a short exact snippet from that line
  verified?: boolean; // set by codelearn after checking the quote against the file
}

export type ConceptKind = 'language' | 'library' | 'pattern' | 'architecture' | 'domain' | 'tooling';

export interface Concept {
  id: string; // kebab-case, unique within the map
  name: string;
  kind: ConceptKind;
  /** One sentence. */
  summary: string;
  /** 2-3 sentences for the hover, written for this learner. */
  hover: string;
  /** Identifiers or tokens in code that signal this concept, e.g. "IMediator", "Where". */
  match: string[];
  /** Concept ids or plain names that help to know first. */
  prereqs: string[];
  /** How this repo uses it. */
  usage: string;
  citations: Citation[];
  /** Official documentation site for a search link, e.g. "learn.microsoft.com". */
  docsSite?: string;
  /** Search words for docs and videos, e.g. "C# LINQ Where". */
  searchQuery?: string;
  /** Code that shows the concept in use, exactly as written, e.g. `data-bind="`: found by search for examples (v3). */
  patterns?: string[];
}

export interface Area {
  id: string;
  name: string;
  summary: string;
  paths: string[]; // folder or file globs, workspace-relative
  /** A fuller explanation, from a Thorough map or "Explore deeper" (v3). Markdown. */
  details?: string;
  /** The files that matter most here, and the job each does (v3). */
  keyFiles?: KeyFile[];
}

export interface KeyFile {
  file: string;
  role: string;
}

/** One stop along a flow: a line of real code and what happens there (v3). */
export interface FlowStep {
  file: string;
  line: number; // 1-based
  endLine?: number;
  quote?: string;
  title: string;
  /** Markdown. */
  body: string;
  /** Concept ids or names at play in this step. */
  concepts?: string[];
  verified?: boolean;
}

export interface Flow {
  id: string;
  name: string;
  summary: string;
  /** Files involved, in rough order of execution. */
  files: string[];
  entry?: Citation;
  /** The flow step by step through the code, from a deep dive or "Investigate" (v3). */
  steps?: FlowStep[];
  /** Id of the architecture part it mostly runs in (v3). */
  part?: string;
  /** For flows added by "Investigate": what the learner asked (v3). */
  question?: string;
  /** Markdown: how the flow works, or the answer to the question (v3). */
  details?: string;
}

/** A separately built or run piece of the software, e.g. a web app, a worker, a build step (v3). */
export interface ArchitecturePart {
  id: string;
  name: string;
  summary: string;
  /** Folders or files it is made of. */
  paths: string[];
  /** Where it starts. */
  entry?: Citation;
  /** Where and how it runs, e.g. "in the browser", "Azure Function", "at build time". */
  runs?: string;
  /** A service outside this repository that the code talks to, e.g. an identity provider. */
  external?: boolean;
}

export interface ArchitectureLink {
  from: string; // part id
  to: string; // part id
  /** How they connect, e.g. "calls its REST API", "writes the files it serves". */
  how: string;
  /** Code that shows the connection. Without a verified one, the link is the AI's inference. */
  evidence?: Citation;
}

export interface Architecture {
  /** Markdown: how the parts fit together. */
  summary: string;
  parts: ArchitecturePart[];
  links: ArchitectureLink[];
}

export interface GlossaryTerm {
  term: string;
  meaning: string;
  citations: Citation[];
}

export type ConventionStatus = 'confirmed' | 'contradicted' | 'unchecked';

export interface Convention {
  rule: string;
  /** Where the rule is written down, e.g. "AGENTS.md", or "code" when inferred from the code alone. */
  source: string;
  status: ConventionStatus;
  /** When contradicted: what the code actually does. */
  note?: string;
  evidence: Citation[];
}

export interface RepoMap {
  version: number;
  repoName: string;
  generatedAt: string;
  model: string;
  overview: string;
  areas: Area[];
  flows: Flow[];
  concepts: Concept[];
  glossary: GlossaryTerm[];
  conventions: Convention[];
  /** content hash per file read during the scan, for incremental updates */
  fileHashes: Record<string, string>;
  /** The branch and commit the map was last built or updated from (v2). */
  builtFrom?: { branch?: string; commit?: string };
  /** 'quick': one overview request. 'thorough': a survey, a deep dive per flow, then a synthesis (v3). */
  depth?: 'quick' | 'thorough';
  /** How the software's parts fit together and where each runs (v3). */
  architecture?: Architecture;
  /** Set on maps built before codelearn read templates, so their missing hashes don't count as changes (v3). */
  templatesUntracked?: boolean;
}

export type Depth = 'refresher' | 'standard' | 'scratch';

export interface Comparison {
  /** Something the learner already knows, e.g. "TypeScript Array.filter". */
  known: string;
  /** The thing here, e.g. "LINQ Where". */
  here: string;
  note: string;
}

export interface CheckQuestion {
  question: string;
  options: string[];
  answer: number; // index into options
  explanation: string;
}

export interface Lesson {
  conceptId: string;
  conceptName: string;
  depth: Depth;
  /** Markdown body: what it is, how it works. */
  body: string;
  comparisons: Comparison[];
  usage: string;
  citations: Citation[];
  pitfalls: string[];
  check?: CheckQuestion;
  generatedAt: string;
  model: string;
  /** Hash of the cited files' contents when generated; differs -> stale. */
  sourceHash: string;
  /** Code that shows the concept in use, exactly as written, for finding examples in any repo (v3). */
  patterns?: string[];
  /** Pages from the official documentation (v3). */
  docs?: DocLink[];
}

export interface DocLink {
  title: string;
  url: string;
  /** True when codelearn loaded the page and found it on the expected site. */
  checked?: boolean;
}

export interface Explanation {
  title: string;
  /** Markdown. */
  body: string;
  conceptIds: string[];
  citations: Citation[];
  generatedAt: string;
  model: string;
}

export interface WalkthroughStep {
  file: string;
  line: number;
  endLine?: number;
  quote?: string;
  title: string;
  body: string;
  concepts: string[];
  verified?: boolean;
}

export interface Walkthrough {
  id: string;
  title: string;
  summary: string;
  steps: WalkthroughStep[];
  generatedAt: string;
  model: string;
  /** Hash of the source files when generated; differs -> files changed since. */
  sourceHash?: string;
}

export type ConceptStatus = 'new' | 'learning' | 'known';

export interface LearnerProfile {
  /** Languages, frameworks and concepts the learner already knows. */
  known: string[];
  experience: 'new' | 'some' | 'professional';
  updatedAt: string;
}
