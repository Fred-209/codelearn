# codelearn

A VS Code extension that teaches you an unfamiliar codebase from inside the editor. Point at code and learn what it is, how this repo uses it, and what you need to know first. It works in any language, and the AI is the GitHub Copilot you already have.

## What it does

- **Map of the repo.** One scan finds the main areas, the main flows through the code, the concepts in use (language features, libraries, patterns, architecture), business terms, and the team's conventions. Conventions come from AI instruction files (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, Cursor rules, skills) and are checked against the code: each one is marked confirmed, contradicted or unchecked.
- **Teaching hovers.** Point at code the map knows (`IMediator`, `.Where(`, `SettlementBatch`) to get a short explanation plus a note on how this repo uses it. The hover has links to open the lesson, step through the code, mark it as known, or report it as wrong. Hovers read saved text, so they're instant and use no AI requests.
- **Lessons.** A tab beside your code covers each concept. You can switch depth (Refresher, Standard, From scratch), see comparisons to things you already know, common pitfalls, and where the repo uses it. Prerequisites are clickable, there are docs and video search links, a check question, and *Ask a question*.
- **What's happening here?** (`Ctrl+Alt+/`) explains the code at your cursor at three zoom levels: this code, this file, and the bigger flow it's part of.
- **Walkthroughs.** These step through a flow or a function. Each step appears as a card under the line it explains. *Open in panel* moves the walkthrough into a side panel at the same step, and codelearn remembers which view you prefer.
- **Trust marks.** Every claim about the repo cites file and line with an exact quote, which codelearn checks against the real file. Results are labelled *Checked against the code* or *AI's guess*. *This is wrong* rewrites the content with a stronger model.
- **Your profile.** A one-minute first-run setup records what you already know. Explanations start from there and compare only to things you know. Nothing is ever hidden: a concept you marked as known still has its full lesson one click away.

## Install

1. Download `codelearn-<version>.vsix` from the [Releases page](https://github.com/Fred-209/codelearn/releases). Each CI run also uploads the `.vsix` as an artifact.
2. In VS Code, run **Extensions: Install from VSIX…** and pick the file.
3. Make sure GitHub Copilot Chat is installed and signed in.
4. Open a repo, open the **codelearn** sidebar (book icon), and click **Build map**. Before anything is sent, you'll see how many files were read and roughly how many AI requests the scan will make.

## AI models and usage

codelearn uses the models VS Code exposes to extensions, which normally means GitHub Copilot's models. It needs no API key, and code goes only where Copilot already sends it. VS Code asks once for permission to use the models.

Jobs are split across three model slots, each set to **Automatic** by default. You can change them with **codelearn: Choose AI models**.

| Slot | Used for | Automatic choice |
| --- | --- | --- |
| Deep | building the map, flow walkthroughs, rewrites after "This is wrong" | strongest available (Opus-class) |
| Standard | concept descriptions, lessons, explanations | mid-tier (Sonnet-class) |
| Fast | quick explanations of words the map doesn't know | smallest (Haiku-class) |

Most usage happens once per repo, during the first scan: one big request plus about one request per eight concepts. After that:

- Hovers read saved text and make no requests.
- Lessons, explanations and walkthroughs are written the first time you open them, then saved.
- Lessons on general concepts (a language feature, a library) are shared across all your repos.
- **Update map** re-describes only concepts touched by files that changed.

## Privacy

- Everything codelearn generates is saved in VS Code's private storage on your machine. Nothing is written into the repo.
- The extension sends no telemetry and makes no network calls of its own. All AI requests go through VS Code's Language Model API.
- **codelearn: Delete saved lessons for this repo** removes everything saved for the current repo.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `codelearn.models.deep` / `.standard` / `.fast` | `auto` | Model per slot (id, family or a name fragment). |
| `codelearn.hover.enabled` | `true` | Teaching hovers on mapped concepts. |
| `codelearn.hover.showForUnknown` | `true` | One-line "explain" link on symbols the map doesn't know. |
| `codelearn.hover.autoGenerate` | `false` | Explain unknown symbols automatically on hover (one request per new symbol, saved). |
| `codelearn.walkthrough.defaultView` | `inline` | Where walkthroughs first appear; after that your last choice is remembered. |
| `codelearn.scan.maxFiles` | `1500` | Files read when building the map. |
| `codelearn.scan.exclude` | build output, dependencies, lock files | Globs skipped by the scan. |

## Development

```sh
npm install
npm run build        # bundle to dist/
npm test             # unit tests (vitest)
npm run test:e2e     # integration tests in a real VS Code (needs a display; CI uses xvfb)
npm run package      # build codelearn-<version>.vsix
```

Press F5 in VS Code to run the extension in a development host.

To publish a release, push a tag such as `v0.1.0`. The Release workflow attaches the `.vsix` to a GitHub release.

### Layout

| Path | What's there |
| --- | --- |
| `src/ai/` | Provider interface, VS Code Language Model provider, model slots, prompts, JSON parsing and validation |
| `src/scan/` | Choosing files, building the repo digest, the map scan and incremental updates |
| `src/learn/` | Hovers, lessons, explanations, citation checking, concept matching |
| `src/walkthrough/` | Walkthrough generation, inline cards (Comments API), shared step state |
| `src/ui/` | Lesson/explanation panel (webview), map sidebar, HTML rendering |
| `src/store/` | Saved data and its types |

## Roadmap

- **Explain this error**: paste a log line or stack trace from anywhere, then walk from the error to its likely cause. It will strip sensitive values before sending and warn when the deployed version differs from your checkout.
- **Explain a diff or PR**, flagging changes that break the repo's conventions.
- **Active recall**: predict-before-reveal in walkthroughs, short refreshers on concepts you studied, and explain-it-back with feedback.
- **Personal notes** on lines and concepts, exportable to Markdown.
- **Practice tasks** in the real repo, with a review of your attempt.
- Other AI providers (an API key, or a local model) behind the same provider interface.
