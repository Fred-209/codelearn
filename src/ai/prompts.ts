// Prompt text for every AI request codelearn makes. Pure, so prompts can be read
// and tested in one place.

import type { Concept, Depth, LearnerProfile, RepoMap } from '../store/types';
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

export function mapPrompt(digest: string, profile: LearnerProfile | undefined) {
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `Study this repository digest and produce a map that helps the learner find their way around.

${digest}

---

Produce JSON with this schema:
{
  "overview": string,            // 3-6 sentences: what this software does, its main technologies, and how it is organised
  "areas": [{ "id": string, "name": string, "summary": string, "paths": string[] }],      // 3-10 major parts; paths are folders or files from the digest
  "flows": [{ "id": string, "name": string, "summary": string, "files": string[], "entry": ${CITATION_SCHEMA} }],  // 2-8 main paths through the code (e.g. "Handling an HTTP request", "Saving a payment"); files in execution order
  "concepts": [{
    "id": string,                // kebab-case
    "name": string,              // e.g. "LINQ", "Dependency injection", "MediatR", "Records", "Clean architecture"
    "kind": "language" | "library" | "pattern" | "architecture" | "domain" | "tooling",
    "summary": string,           // one sentence
    "match": string[],           // identifiers or tokens in the code that signal this concept, exactly as written in code (e.g. "IMediator", "Send", "Where", "AbstractValidator"); avoid words so common they'd match unrelated code
    "prereqs": string[],         // names of concepts that help to know first
    "docsSite": string,          // official documentation domain, e.g. "learn.microsoft.com", "developer.mozilla.org"; "" if none
    "searchQuery": string        // good search words for docs and videos, e.g. "C# LINQ Where"
  }],                            // 15-60 concepts actually used in this repo: language features, libraries, design patterns, architecture, tooling
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

export function lessonPrompt(
  concept: Pick<Concept, 'name' | 'kind' | 'summary'>,
  depth: Depth,
  profile: LearnerProfile | undefined,
  repoContext: string,
  feedback?: string,
) {
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `Write a lesson about "${concept.name}" (${concept.kind}). ${concept.summary}

Depth: ${DEPTH_TEXT[depth]}.

Context from the repository the learner is reading (use it for examples where it fits):
${repoContext || '(none)'}
${feedback ? `\nThe learner reported a problem with the previous version of this lesson: "${feedback}". Fix it, and be extra careful to be accurate.\n` : ''}
Produce JSON with this schema:
{
  "body": string,                // Markdown. Headings (###), short paragraphs, small code examples in the repository's language. No links.
  "comparisons": [{ "known": string, "here": string, "note": string }],  // 0-3 accurate comparisons to things the learner knows; note says where it breaks down. [] if none fit.
  "pitfalls": string[],          // 1-4 common mistakes
  "check": { "question": string, "options": string[], "answer": number, "explanation": string }  // one multiple-choice question testing understanding, not recall of trivia; answer is the 0-based index
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

export function quickExplainPrompt(word: string, file: string, context: string, profile: LearnerProfile | undefined) {
  return {
    system: `${TEACHER}\n\n${learnerText(profile)}`,
    user: `The learner is pointing at "${word}" in ${file}:
\`\`\`
${context}
\`\`\`
Explain what "${word}" is here.

Produce JSON with this schema:
{
  "title": string,               // the name of the thing
  "body": string,                // 2-4 sentences of Markdown: what it is, what it does here
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
