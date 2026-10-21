# codelearn

A VS Code extension that teaches you an unfamiliar codebase from inside the editor. Point at code and learn what it is, how this repo uses it, and what you need to know first. It works in any language, and the AI is one you already have: GitHub Copilot, or your Claude login through Claude Code. Neither needs an API key.

## What it does

- **Map of the repo.** A scan finds the parts of the system and how they connect, the main areas, the main flows through the code, the concepts in use (language features, libraries, patterns, architecture), business terms, and the team's conventions. Front end and back end get the same attention, and build and deployment files (pipelines, Bicep, Terraform, Dockerfiles, `staticwebapp.config.json` and the like) say where each part runs. Conventions come from AI instruction files (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, Cursor rules, skills) and are checked against the code: each one is marked confirmed, contradicted or unchecked.
- **Quick or Thorough.** A *Quick* map comes from one look at the code (about 6 requests on a typical repo). A *Thorough* map surveys the repo, then follows up to 12 main flows through the code one by one, then rewrites the overview and architecture from what it found (about 20 requests). You see the estimate for both before choosing.
- **Architecture.** The Architecture page lists each part (a web app, an API, a build step, a function, an outside service), where it runs, and how the parts connect, drawn as a diagram. Each connection either points at the code that shows it (solid arrow, ✓) or is marked as the AI's inference (dashed arrow).
- **Flows step by step.** A followed flow lists its steps, each at a real line of code. *Walk me through this flow* then steps through them in the editor with no further AI request.
- **Investigate a question.** Ask "How does signing in work?" and codelearn follows it through the code (one request) and adds the answer to the map as a new flow. **Explore deeper** on an area does the same for that area: a fuller explanation, its key files and paths through it.
- **Teaching hovers.** Point at code the map knows (`IMediator`, `.Where(`, `SettlementBatch`) to get a short explanation plus a note on how this repo uses it. The hover has links to open the lesson, step through the code, mark it as known, or report it as wrong. Hovers read saved text, so they're instant and use no AI requests.
- **Selections.** Select some code and hover inside it to get a hover for the whole selection. It lists the concepts and business terms in the selection, and has links to *Explain selection* (which focuses on exactly what you selected) and *Step through*. Words the map doesn't know get a one-line *explain* link, except plain English words and anything in comments or strings.
- **Lessons.** A colour-coded tab beside your code covers each concept, with syntax-highlighted examples in your theme's colours. You can switch depth (Refresher, Standard, From scratch), see comparisons to things you already know, common pitfalls, and *In this codebase*: real uses found by searching the repo's code (no AI), shown as snippets with line numbers, plus a list of the other files that use it. Prerequisites are clickable, there are links to official documentation pages (each one opened first to check it exists), docs and video search links, a check question, and *Ask a question*.
- **What's happening here?** (`Ctrl+Alt+/`) explains the code at your cursor at three zoom levels: this code, this file, and the bigger flow it's part of. With a selection it explains exactly that. Otherwise it explains the function or method around the cursor (including arrow functions and lambdas assigned to names), or, inside a very long one, the block around the cursor. It uses your language extension's outline and "Expand selection" ranges, falling back to indentation. The chosen lines are shaded in the editor, the tab names them ("method Handle · lines 9-18"), and **Smaller** / **Larger** step through the statement, block, function and class around the cursor. The page also says which part, area and flows of the map the file belongs to.
- **Quick explains.** The one-line *explain* link on a word sends what your language extension knows along with it: the class and method around it, where it's defined, a few places that use it, and the extension's own hover text. So a property like `LastName` is explained in the context of its class and the code that reads it.
- **Walkthroughs.** These step through a flow or a function. Each step appears as a card under the line it explains. *Open in panel* moves the walkthrough into a side panel at the same step, and codelearn remembers which view you prefer.
- **Trust marks.** Every claim about the repo cites file and line with an exact quote, which codelearn checks against the real file. Results are labelled *Checked against the code* or *AI's guess*. *This is wrong* rewrites the content with a stronger model.
- **Your profile.** A one-minute first-run setup records what you already know. Explanations start from there and compare only to things you know. Nothing is ever hidden: a concept you marked as known still has its full lesson one click away.

## Install

1. Download `codelearn-<version>.vsix` from the [Releases page](https://github.com/Fred-209/codelearn/releases). Each CI run also uploads the `.vsix` as an artifact.
2. In VS Code, run **Extensions: Install from VSIX…** and pick the file.
3. Have one AI ready: GitHub Copilot Chat signed in, or [Claude Code](https://claude.com/claude-code) installed and logged in once (run `claude` in a terminal).
4. Open a repo, open the **codelearn** sidebar (book icon), and click **Build map**. Before anything is sent, you'll see how many files were read and roughly how many AI requests the scan will make.

## AI models and usage

codelearn can use either of two AIs. Neither needs an API key. Pick one with **codelearn: Choose AI models**, or leave it on **Automatic**, which uses Copilot when VS Code offers its models and Claude Code otherwise.

- **GitHub Copilot**: the models VS Code exposes to extensions. Code goes only where Copilot already sends it. VS Code asks once for permission to use the models.
- **Claude Code**: codelearn runs the `claude` command line in headless mode (`claude -p`) with your existing Claude login. Requests run with no MCP servers and no saved session, from a folder in codelearn's storage, so the repo's own `CLAUDE.md` and settings aren't loaded. The only tools are the read-only Read, Grep and Glob on the repo folder (see *Lookups* below), or none when lookups are off. codelearn finds `claude` on your PATH, in the usual install folders, or inside the Claude Code VS Code extension; set `codelearn.claudeCode.path` if it's somewhere else.

The provider, model and effort settings are kept per machine and aren't synced, so a work machine can stay on Copilot while a personal one uses Claude Code. The sidebar's last line shows which AI and models are in use; click it to change them. With the defaults there is nothing to set up.

Jobs are split across three model slots. Each uses a recommended model by default, picked from the models your AI actually offers, so a newer version is used once it appears. **codelearn: Choose AI models** (also in the sidebar's ... menu) lets you keep the recommendations or pick any available model per slot.

| Slot | Used for | Recommended model | Recommended effort |
| --- | --- | --- | --- |
| Deep | building the map, flow walkthroughs, rewrites after "This is wrong" | Opus-class, else GPT Sol (`opus` on Claude Code) | high |
| Standard | concept descriptions, lessons, explanations | Sonnet-class, else GPT Sol (`sonnet`) | medium |
| Fast | quick explanations of words the map doesn't know | Haiku-class, else GPT Luna (`haiku`) | low |

On Claude Code, effort is passed with `--effort`. On Copilot, codelearn asks for the effort with each request (`low`, `medium` or `high`), which recent VS Code builds pass on to Copilot's models. Older builds ignore it and use the effort chosen for that model in the chat model picker. If a model rejects the setting, codelearn asks again without it.

**Lookups.** While it builds the map, explains code or writes a lesson about this repo, the AI can search the repo, read lines of a file, list a folder or find where a name is defined, so it isn't limited to the code codelearn picked for it. Lookups are read only and capped per request (12 when following a flow, 6 for an explanation, none for lessons on general concepts), and come in at most 3 rounds, since each round sends the request again. The first survey of a Thorough map, the largest request, makes none. Files that usually hold secrets (`.env` files, keys, `local.settings.json`) are kept out of reach. Turn lookups off with `codelearn.ai.lookups`.

**codelearn: Show AI usage** (also in the sidebar's ... menu) lists every request codelearn has made, by model and kind, with token counts and lookups. Claude Code reports exact tokens; for Copilot they are estimated with the model's tokenizer.

Most usage happens once per repo, during the first scan: for a Quick map, one big request plus about one request per eight concepts; a Thorough map adds one request per followed flow and a final one to put it together. After that:

- Hovers read saved text and make no requests.
- Lessons, explanations and walkthroughs are written the first time you open them, then saved.
- Lessons on general concepts (a language feature, a library) are shared across all your repos.
- **Update map** works from the files that changed since the map was built. It finds new concepts, business terms and flows in them (one request), drops ones whose code is gone, and re-describes only the concepts the changes touch. When most of the repo changed, it suggests a full rebuild instead.

### Branches, worktrees and updates

- One map per repository, not per folder. Every git worktree and clone of a repo shares it, along with its lessons and walkthroughs. A repo is recognised by its origin URL, or by its shared `.git` folder when it has no remote.
- When VS Code opens, codelearn compares the files on disk with the map. This makes no AI requests. If anything differs (after a pull, a branch switch, or in a worktree), the sidebar shows "N files changed: update the map", and the overview says which branch and commit the map came from. Updating is always your call.
- Saved maps and lessons are upgraded when you install a newer codelearn, never thrown away, so an extension update doesn't mean a rebuild.

## Privacy

- Everything codelearn generates is saved in VS Code's private storage on your machine (`<VS Code user folder>/globalStorage/fred-209.codelearn/`, under `repos/` per repository and `library/` for shared lessons). Nothing is written into the repo.
- The extension sends no telemetry. AI requests go through VS Code's Language Model API (Copilot) or the `claude` command line (Claude Code). Its only network calls of its own open the documentation pages a lesson links to, to check they exist (no code or repo data is sent); turn that off with `codelearn.lessons.checkDocLinks`.
- In code codelearn sends to the AI, values that look like passwords, keys, tokens or connection strings are masked first, and files that usually hold secrets are never read. (When Claude Code looks files up itself, it reads them directly, so only the second rule applies there.)
- **codelearn: Delete saved lessons for this repo** removes everything saved for the current repo.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `codelearn.provider` | `auto` | `copilot`, `claude-code`, or `auto`. Per machine. |
| `codelearn.claudeCode.path` | empty | Path to `claude`, if codelearn can't find it. |
| `codelearn.models.deep` / `.standard` / `.fast` | `auto` | Model per slot (id, family or a name fragment; for Claude Code, `opus`/`sonnet`/`haiku` or a full model name). Per machine. |
| `codelearn.effort.deep` / `.standard` / `.fast` | `auto` | Effort per slot (`low` to `max`; Copilot takes up to `high`). Per machine. |
| `codelearn.ai.lookups` | `true` | Let the AI search and read the repo's files while it works (read only, capped). |
| `codelearn.lessons.checkDocLinks` | `true` | Open each documentation link before a lesson shows it, to check it exists. |
| `codelearn.hover.enabled` | `true` | Teaching hovers on mapped concepts. |
| `codelearn.hover.showForUnknown` | `true` | One-line "explain" link on code the map doesn't know (not on plain words, comments or strings). |
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

To publish a release, push a tag such as `v0.1.0`, or run the Release workflow from the Actions tab with the version. It attaches the `.vsix` to a GitHub release.

### Layout

| Path | What's there |
| --- | --- |
| `src/ai/` | Provider interface, Copilot (VS Code Language Model) and Claude Code providers, model slots, prompts, JSON parsing and validation |
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
- More AI providers (an API key, or a local model) behind the same provider interface.
