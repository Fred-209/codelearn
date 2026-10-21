// Shapes of everything codelearn saves. All of it lives in VS Code's private
// extension storage on this machine; nothing is written into the repo.

export const MAP_VERSION = 1;

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
}

export interface Area {
  id: string;
  name: string;
  summary: string;
  paths: string[]; // folder or file globs, workspace-relative
}

export interface Flow {
  id: string;
  name: string;
  summary: string;
  /** Files involved, in rough order of execution. */
  files: string[];
  entry?: Citation;
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
