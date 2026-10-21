// Prompt text for every AI request codelearn makes. Pure, so prompts can be read
// and tested in one place.

import type { Area, Concept, Depth, Flow, LearnerProfile, RepoMap } from '../store/types';
import type { Occurrence } from '../scan/digest';

const EXPERIENCE: Record<LearnerProfile['experience'], string> = {
  new: 'is new to programming',
  some: 'has some programming experience',
  professional: 'is a professional software developer',
};

export function learnerText(profile: LearnerProfile | undefined): string {
  if (!profile) {
    return 'The learner has not said what they know. Assume general programming basics only, and draw no comparisons to specific technologies.';
  }
  const known = profile.known.length ? profile.known.join(', ') : 'nothing specific';
  return [
    `The learner ${EXPERIENCE[profile.experience]} and already knows: ${known}.`,
    'Compare new ideas only to things on that list, and only when the comparison is accurate; say where the comparison breaks down.',
    'Never assume knowledge that is not on the list.',
  ].join(' ');
}

const TEACHER = [
  'You are codelearn, a patient expert who teaches people an unfamiliar codebase from inside their editor.',
  'Write plain, specific English: short sentences, concrete examples, no filler, no hype.',
  'Accuracy matters more than coverage. Only state facts about THIS repository that the provided code supports.',
  'When you refer to repository code, cite it with the workspace-relative file path, the 1-based line number, and a short EXACT quote copied from that line (10-60 characters). Never invent quotes.',
  'If you are unsure about something, say so plainly instead of guessing.',
  'Never invent URLs.',
].join('\n');

const JSON_ONLY = 'Reply with ONLY a JSON object matching the schema. No prose before or after it.';

const CITATION_SCHEMA = '{ "file": string, "line": number, "quote": string }';

const CONCEPT_SCHEMA = `{
    "id": string,                // kebab-case
    "name": string,              // e.g. "LINQ", "Dependency injection", "MediatR", "Knockout bindings", "Clean architecture"
    "kind": "language" | "library" | "pattern" | "architecture" | "domain" | "tooling",
    "summary": string,           // one sentence
    "match": string[],           // identifiers or tokens in the code that signal this concept, exactly as written in code (e.g. "IMediator", "Send", "Where", "AbstractValidator"); avoid words so common they'd match unrelated code
    "patterns": string[],        // 0-4 short pieces of code that show it in use, exactly as they appear in this repo's files, including templates (e.g. "data-bind=\\"", "ko.observable(", "[Authorize"); used to search for examples
    "prereqs": string[],         // names of concepts that help to know first
    "docsSite": string,          // official documentation domain, e.g. "learn.microsoft.com", "knockoutjs.com"; "" if none
    "searchQuery": string        // good search words for docs and videos, e.g. "C# LINQ Where"
  }`;

const ARCHITECTURE_SCHEMA = `{
    "summary": string,           // Markdown, 3-8 sentences: the moving parts, how a user's action travels through them, and how the software is built and deployed
    "parts": [{
      "id": string,              // kebab-case
      "name": string,            // e.g. "Designer app", "Publisher", "Runtime widgets", "Payments API", "Identity provider"
      "summary": string,         // 1-3 sentences: its job
      "paths": string[],         // folders or files it is made of; [] for outside services
      "entry": ${CITATION_SCHEMA},  // where it starts (omit for outside services)
      "runs": string,            // where it runs, in a few words, from the code and the deployment files: e.g. "browser, Azure Static Web Apps", "Azure Function (HTTP trigger)", "Node script at build time"; "" if the repo doesn't say. Put how it is built and served in "summary"
      "external": boolean        // true for services outside this repo that the code talks to (identity providers, storage, other APIs)
    }],
    "links": [{
      "from": string, "to": string,  // part ids
      "how": string,             // e.g. "calls its REST API at /users", "writes the static files it serves", "signs users in"
      "evidence": ${CITATION_SCHEMA}  // code that shows the connection; omit if you inferred it
    }]
  }`;

const COVERAGE = [
  'Cover every part of the system: front ends (pages, components, templates and bindings), back ends (APIs, handlers, data access), functions, workers, scripts, and how it is built and deployed. Don\'t let the largest part crowd out smaller ones.',
  'Use the deployment section (pipelines, infrastructure as code, hosting config) to say where each part runs, and name the hosting service when the files show it (e.g. Azure Static Web Apps, App Service, Functions, a container).',
  'Each cross-cutting topic listed in the digest (sign-in, configuration, routing, data access and so on) must show up in an area, a flow or a concept.',
].join('\n');

/**
 * The big-picture map. `quick` is the whole map from one request; `thorough` is the survey that
 * picks the flows codelearn then follows one by one.
 */
export function mapPrompt(digest: string, profile: LearnerProfile | undefined, depth: 'quick' | 'thorough' = 'quick') {
  const flows =
    depth === 'thorough'
      ? `8-14 main paths through the code, at least one for each part in the architecture that has code (e.g. "Signing in", "Publishing the site", "Handling an HTTP request"). These are followed one by one next, so "files" lists up to 8 files to read for each, in execution order`
      : '3-10 main paths through the code (e.g. "Handling an HTTP request", "Signing in", "Saving a payment"), covering the different parts; files in execution order';
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `Study this repository digest and produce a map that helps the learner find their way around: what the moving parts are, how they connect, where each runs, and the paths through the code.

${digest}

---

${COVERAGE}

Produce JSON with this schema:
{
  "overview": string,            // 4-8 sentences: what this software does, who uses it, its main technologies, and how it is organised
  "architecture": ${ARCHITECTURE_SCHEMA},  // 3-12 parts, including outside services the code talks to
  "areas": [{ "id": string, "name": string, "summary": string, "paths": string[] }],      // 4-12 major areas of the code; paths are folders or files from the digest
  "flows": [{ "id": string, "name": string, "summary": string, "part": string, "files": string[], "entry": ${CITATION_SCHEMA} }],  // ${flows}; "part" is an architecture part id
  "concepts": [${CONCEPT_SCHEMA}],                            // 20-60 concepts actually used in this repo: language features, libraries, design patterns, architecture, tooling, front end and back end alike
  "glossary": [{ "term": string, "meaning": string, "citations": [${CITATION_SCHEMA}] }],  // business/domain terms found in names (e.g. "Settlement", "Ledger"), explained for this software
  "conventions": [{
    "rule": string,              // a convention the team follows, e.g. "Every command has a matching validator"
    "source": string,            // the instruction file that states it (e.g. "AGENTS.md"), or "code" if you inferred it from the code
    "status": "confirmed" | "contradicted" | "unchecked",  // does the sampled code follow it?
    "note": string,              // if contradicted: what the code actually does
    "evidence": [${CITATION_SCHEMA}]
  }]
}

Treat instruction files (AGENTS.md, CLAUDE.md, copilot-instructions and similar) as statements of intent, and check them against the code samples. Mark a rule "contradicted" when the samples disagree, and "unchecked" when the samples don't show it either way.
${JSON_ONLY}`,
  };
}

/** The map so far, for prompts that work on one part of it. */
export function mapContext(map: Pick<RepoMap, 'overview' | 'architecture' | 'areas' | 'flows'>): string {
  const lines = [`Repository overview: ${map.overview}`];
  const a = map.architecture;
  if (a?.parts.length) {
    lines.push('Parts of the system (id: name, where it runs):');
    for (const p of a.parts) lines.push(`- ${p.id}: ${p.name}${p.runs ? `, ${p.runs}` : ''}${p.external ? ' (outside this repo)' : ''}. ${p.summary}`);
  }
  if (map.areas.length) lines.push(`Areas: ${map.areas.map((x) => `${x.name} (${x.paths.slice(0, 3).join(', ')})`).join('; ')}`);
  if (map.flows.length) lines.push(`Flows already mapped: ${map.flows.map((f) => f.name).join('; ')}`);
  return lines.join('\n');
}

const STEP_SCHEMA = `{
    "file": string,              // a repository file
    "line": number,              // 1-based
    "endLine": number,           // optional, for a short range
    "quote": string,             // a short EXACT snippet from that line
    "title": string,             // a few words
    "body": string,              // 2-5 sentences, plain Markdown, no links: what happens here, why, and what comes next
    "concepts": string[]         // ids from the known concepts, or plain names
  }`;

function sourceBlocks(sources: { file: string; code: string }[]): string {
  return sources.map((s) => `### ${s.file}\n\`\`\`\n${s.code}\n\`\`\``).join('\n\n');
}

function conceptIds(concepts: Pick<Concept, 'id' | 'name'>[]): string {
  return concepts.length ? concepts.map((c) => `${c.id} (${c.name})`).join(', ') : '(none yet)';
}

/** One deep dive: follow a flow through the code it touches. */
export function divePrompt(
  flow: Pick<Flow, 'name' | 'summary' | 'files' | 'part'>,
  sources: { file: string; code: string }[],
  context: string,
  concepts: Pick<Concept, 'id' | 'name'>[],
  profile: LearnerProfile | undefined,
) {
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `Follow one flow through this repository, step by step in the order the code runs, so the learner can read along in the editor.

Flow: ${flow.name}
What the first survey said about it: ${flow.summary || '(nothing)'}

${context}

The code this flow touches (each line starts with its 1-based line number; "…|" marks code left out):

${sourceBlocks(sources)}

Known concepts (ids): ${conceptIds(concepts)}

---

Produce JSON with this schema:
{
  "summary": string,             // 2-4 sentences: what starts this flow, what it does, and where it ends
  "details": string,             // Markdown, 100-300 words: how it works, which parts of the system it crosses, and what to watch out for
  "part": string,                // id of the part of the system it mostly runs in, or ""
  "files": string[],             // the files involved, in the order execution reaches them
  "steps": [${STEP_SCHEMA}],     // 5-14 steps, in execution order, following calls across files
  "concepts": string[],          // ids of known concepts at play
  "newConcepts": [${CONCEPT_SCHEMA}],  // concepts this flow uses that are not in the known list; [] if none
  "glossary": [{ "term": string, "meaning": string, "citations": [${CITATION_SCHEMA}] }]  // business terms met along the way; [] if none
}
Steps must point at lines in the code above, or in code you looked up. Don't skip the interesting parts: where the request or event comes in, decisions, calls to other parts, data being read or saved, and errors.
${JSON_ONLY}`,
  };
}

/** After the deep dives: the final overview, architecture and areas. */
export function synthesisPrompt(
  survey: Pick<RepoMap, 'overview' | 'architecture' | 'areas'>,
  flows: Flow[],
  deployment: string,
  profile: LearnerProfile | undefined,
) {
  const flowText = flows
    .map((f) => {
      const steps = (f.steps ?? []).map((st) => `    ${st.file}:${st.line} ${st.title}`).join('\n');
      return `- ${f.name}${f.part ? ` [${f.part}]` : ''}: ${f.summary}${steps ? `\n${steps}` : ''}`;
    })
    .join('\n');
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `A first survey of this repository produced the overview, architecture and areas below. Since then, each main flow was followed through the code step by step. Rewrite the overview, architecture and areas so they are accurate and complete in the light of the flows: fix what the survey got wrong, add parts and connections the flows revealed, and say how a user's action travels through the parts.

Survey overview: ${survey.overview}

Survey architecture (JSON): ${JSON.stringify(survey.architecture ?? { parts: [], links: [] })}

Survey areas (JSON): ${JSON.stringify(survey.areas.map(({ id, name, summary, paths }) => ({ id, name, summary, paths })))}

Flows, as followed through the code:
${flowText || '(none)'}
${deployment ? `\nHow it is built and deployed (from pipelines and hosting config):\n${deployment}\n` : ''}
---

${COVERAGE}

Produce JSON with this schema:
{
  "overview": string,            // 4-8 sentences
  "architecture": ${ARCHITECTURE_SCHEMA},
  "areas": [{ "id": string, "name": string, "summary": string, "paths": string[], "details": string, "keyFiles": [{ "file": string, "role": string }] }]  // keep the survey's ids where an area is the same; details is Markdown, 60-200 words; 3-8 key files each
}
${JSON_ONLY}`,
  };
}

/** "Explore deeper" on one area of the map. */
export function areaPrompt(area: Area, sources: { file: string; code: string }[], context: string, concepts: Pick<Concept, 'id' | 'name'>[], profile: LearnerProfile | undefined) {
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `Explain one area of this repository in depth: what it is responsible for, how it is organised, the files that matter most, how it connects to the rest of the system, and the main paths through it.

Area: ${area.name} (${area.paths.join(', ')})
What the map says so far: ${area.summary}

${context}

Code from this area (each line starts with its 1-based line number; "…|" marks code left out):

${sourceBlocks(sources)}

Known concepts (ids): ${conceptIds(concepts)}

---

Produce JSON with this schema:
{
  "summary": string,             // 1-2 sentences
  "details": string,             // Markdown, 200-450 words, with ### headings: responsibilities, how it is organised, how it connects to other parts, things to watch out for
  "keyFiles": [{ "file": string, "role": string }],   // 5-12 files that matter most, each with its job in a few words
  "flows": [{ "id": string, "name": string, "summary": string, "files": string[], "entry": ${CITATION_SCHEMA}, "steps": [${STEP_SCHEMA}] }]  // 0-3 important paths through this area that the map doesn't have yet, each with 4-10 steps
}
${JSON_ONLY}`,
  };
}

/** "Investigate": answer a question about the repo with a path through the code. */
export function investigatePrompt(question: string, sources: { file: string; code: string }[], context: string, concepts: Pick<Concept, 'id' | 'name'>[], profile: LearnerProfile | undefined) {
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `The learner asks about this repository: "${question}"

Answer by finding the code that does it and following it step by step, in the order it runs.

${context}

Code that may be relevant, found by searching the repository (each line starts with its 1-based line number; "…|" marks code left out). It may not be the right code: check, and look further when you can.

${sourceBlocks(sources) || '(nothing found by search)'}

Known concepts (ids): ${conceptIds(concepts)}

---

Produce JSON with this schema:
{
  "name": string,                // the answer as a flow name, e.g. "Signing in with Azure AD B2C"
  "summary": string,             // 1-2 sentences
  "details": string,             // Markdown, 100-350 words: the direct answer, then how it works
  "part": string,                // id of the part of the system it runs in, or ""
  "files": string[],             // files involved, in execution order
  "entry": ${CITATION_SCHEMA},
  "steps": [${STEP_SCHEMA}]      // 3-12 steps in execution order
}
If the repository doesn't contain the answer, say so in "details" and return no steps.
${JSON_ONLY}`,
  };
}

/** For "Update map": find what's new in the files that changed since the map was built. */
export function mapUpdatePrompt(digest: string, map: Pick<RepoMap, 'overview' | 'concepts' | 'glossary' | 'flows'>, profile: LearnerProfile | undefined) {
  const known = (items: string[]) => (items.length ? items.join('; ') : '(none)');
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `Repository overview: ${map.overview}

The repository already has a map. These files changed or were added since it was built:

${digest}

---

The map already covers:
- Concepts: ${known(map.concepts.map((c) => `${c.id} (${c.name})`))}
- Business terms: ${known(map.glossary.map((g) => g.term))}
- Flows: ${known(map.flows.map((f) => `${f.id} (${f.name})`))}

List ONLY what these files introduce that the map does not cover yet. Don't repeat anything already covered, even under a different name. Empty lists are a perfectly good answer.

Produce JSON with this schema:
{
  "concepts": [{ "id": string, "name": string, "kind": "language" | "library" | "pattern" | "architecture" | "domain" | "tooling", "summary": string, "match": string[], "patterns": string[], "prereqs": string[], "docsSite": string, "searchQuery": string }],
  "glossary": [{ "term": string, "meaning": string, "citations": [${CITATION_SCHEMA}] }],
  "flows": [{ "id": string, "name": string, "summary": string, "files": string[], "entry": ${CITATION_SCHEMA} }]
}
Use the same field meanings as a full map: "match" lists identifiers exactly as written in code, "patterns" short pieces of code that show the concept in use, "files" are in execution order.
${JSON_ONLY}`,
  };
}

export function conceptDetailsPrompt(
  concepts: { concept: Concept; occurrences: Occurrence[] }[],
  overview: string,
  profile: LearnerProfile | undefined,
  feedback?: string,
) {
  const blocks = concepts
    .map(({ concept, occurrences }) => {
      const occ = occurrences.length
        ? occurrences.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n')
        : '  (no occurrences found)';
      return `- id: ${concept.id}\n  name: ${concept.name} (${concept.kind})\n  summary: ${concept.summary}\n  occurrences:\n${occ}`;
    })
    .join('\n\n');
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `Repository overview: ${overview}

For each concept below, write a hover (the text shown when the learner points at it in code) and a note on how this repository uses it.

${blocks}
${feedback ? `\nThe learner reported that the previous description was wrong: "${feedback}". Fix it, and be extra careful to be accurate.\n` : ''}
Produce JSON with this schema:
{
  "concepts": [{
    "id": string,                // same id as given
    "hover": string,             // 2-3 short sentences: what it is, in plain words, plus one accurate comparison to something the learner knows if there is one
    "usage": string,             // 1-3 sentences: how and where THIS repo uses it, based on the occurrences
    "citations": [${CITATION_SCHEMA}]   // 1-3, chosen from the occurrences given
  }]
}
${JSON_ONLY}`,
  };
}

const DEPTH_TEXT: Record<Depth, string> = {
  refresher: 'a quick refresher for someone who has used it before: the key facts and gotchas, about 80-150 words',
  standard: 'a solid explanation for someone meeting it for the first time in this language: what it is, how it works, why it is used, about 200-350 words',
  scratch: 'a from-scratch explanation that assumes no background at all: define every term, build up step by step with tiny examples, about 350-600 words',
};

export interface LessonContext {
  /** Lessons on general concepts are shared by every repo, so they get no repo code. */
  general: boolean;
  /** Repo-specific lessons: overview, usage and examples found in this repo. */
  repo?: string;
  /** The official documentation site, when known. */
  docsSite?: string;
  /** What the learner reported wrong about the previous version. */
  feedback?: string;
}

export function lessonPrompt(concept: Pick<Concept, 'name' | 'kind' | 'summary'>, depth: Depth, profile: LearnerProfile | undefined, ctx: LessonContext) {
  const context = ctx.general
    ? 'Real examples from the codebase the learner is reading are shown next to this lesson, found by searching it for the "patterns" you give. So keep your own examples small and general, in the language this concept belongs to.'
    : `Context from the repository the learner is reading. Teach with it: refer to these files and lines.\n${ctx.repo || '(none)'}`;
  const docs = ctx.general
    ? `"docsSite": string,           // the official documentation domain${ctx.docsSite ? ` (probably ${ctx.docsSite})` : ''}, e.g. "learn.microsoft.com", "knockoutjs.com"; "" if there is none
  "docs": [{ "title": string, "url": string }]  // 0-3 pages of the OFFICIAL documentation about exactly this, that you are sure exist (codelearn loads each one before showing it). [] when unsure`
    : `"docsSite": "",
  "docs": []`;
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `Write a lesson about "${concept.name}" (${concept.kind}). ${concept.summary}

Depth: ${DEPTH_TEXT[depth]}.

${context}
${ctx.feedback ? `\nThe learner reported a problem with the previous version of this lesson: "${ctx.feedback}". Fix it, and be extra careful to be accurate.\n` : ''}
Produce JSON with this schema:
{
  "body": string,                // Markdown. Headings (###), short paragraphs, small code examples. No links.
  "comparisons": [{ "known": string, "here": string, "note": string }],  // 0-3 accurate comparisons to things the learner knows; note says where it breaks down. [] if none fit.
  "pitfalls": string[],          // 1-4 common mistakes
  "check": { "question": string, "options": string[], "answer": number, "explanation": string },  // one multiple-choice question testing understanding, not recall of trivia; answer is the 0-based index
  "patterns": string[],          // 2-5 short pieces of code that show this concept in use, exactly as they would appear in source files or templates (e.g. "data-bind=\\"", "ko.computed(", ".Where("), for finding real examples by text search
  ${docs}
}
${JSON_ONLY}`,
  };
}

export type Zoom = 'line' | 'file' | 'flow';

export function explainPrompt(
  zoom: Zoom,
  file: string,
  code: string,
  extra: string,
  map: RepoMap | undefined,
  profile: LearnerProfile | undefined,
) {
  const focus: Record<Zoom, string> = {
    line: 'Explain what this specific code does, piece by piece, and which language features, libraries or patterns are at play.',
    file: "Explain this file's job: what it is responsible for, which part of the system it belongs to, what calls it and what it calls, and the patterns it follows.",
    flow: 'Explain the bigger flow this file takes part in: where execution starts, how it reaches this file, where it goes next, and where it ends. Name the files along the way.',
  };
  const conceptList = map ? map.concepts.map((c) => `${c.id} (${c.name})`).join(', ') : '';
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `${focus[zoom]}

File: ${file}
\`\`\`
${code}
\`\`\`
${extra ? `\n${extra}\n` : ''}${map ? `\nRepository overview: ${map.overview}\nKnown concepts (ids): ${conceptList}\n` : ''}
Produce JSON with this schema:
{
  "title": string,               // a few words
  "body": string,                // Markdown, 100-400 words. Refer to line numbers. No links.
  "conceptIds": string[],        // ids from the known concepts list that this code uses
  "citations": [${CITATION_SCHEMA}]
}
${JSON_ONLY}`,
  };
}

export function quickExplainPrompt(word: string, file: string, context: string, profile: LearnerProfile | undefined, extra = '') {
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `The learner is pointing at "${word}" in ${file}:
\`\`\`
${context}
\`\`\`
${extra ? `${extra}\n` : ''}Explain what "${word}" is here.

Produce JSON with this schema:
{
  "title": string,               // the name of the thing
  "body": string,                // 2-5 sentences of Markdown: what it is, what it does here, and what uses it, using everything above
  "conceptIds": string[],        // []
  "citations": [${CITATION_SCHEMA}]  // 0-1
}
${JSON_ONLY}`,
  };
}

export function walkthroughPrompt(
  goal: string,
  sources: { file: string; code: string }[],
  map: RepoMap | undefined,
  profile: LearnerProfile | undefined,
) {
  const files = sources.map((s) => `### ${s.file}\n\`\`\`\n${s.code}\n\`\`\``).join('\n\n');
  const conceptList = map ? map.concepts.map((c) => `${c.id} (${c.name})`).join(', ') : '';
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `Create a step-by-step walkthrough: ${goal}

Each step points at one line (or a few lines) of real code, in the order execution reaches them, and explains what happens there and why. Teach the concepts at play as they come up.

Source files (each line is prefixed with its 1-based line number):
${files}
${map ? `\nKnown concepts (ids): ${conceptList}\n` : ''}
Produce JSON with this schema:
{
  "title": string,
  "summary": string,             // one or two sentences
  "steps": [{
    "file": string,              // one of the files above
    "line": number,              // 1-based
    "endLine": number,           // optional, for a short range
    "quote": string,             // a short EXACT snippet from that line
    "title": string,             // a few words
    "body": string,              // 2-5 sentences, plain Markdown, no links
    "concepts": string[]         // ids from the known concepts list, or plain names
  }]                             // 3-12 steps
}
${JSON_ONLY}`,
  };
}

export function askPrompt(question: string, topic: string, context: string, profile: LearnerProfile | undefined) {
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `The learner is studying "${topic}" and asks: ${question}

${context ? `Context:\n${context}\n` : ''}
Answer in Markdown, 50-250 words. Be direct.`,
  };
}
