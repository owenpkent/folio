# Contributing to Folio

First off, thank you for taking the time to contribute! Folio is a
community-driven, MIT-licensed PDF viewer that aims for Adobe Acrobat-caliber
quality on the desktop. Whether you are fixing a typo, filing a bug, building a
plugin, or landing a major feature, you are welcome here.

This guide explains how to set up your environment, how we work, and what we
expect from a pull request. If anything is unclear, open a
[Discussion](https://github.com/owenpkent/folio/discussions) and we will help.

---

## Table of contents

- [Code of Conduct](#code-of-conduct)
- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Branching and pull request workflow](#branching-and-pull-request-workflow)
- [Commit messages (Conventional Commits)](#commit-messages-conventional-commits)
- [Developer Certificate of Origin (DCO sign-off)](#developer-certificate-of-origin-dco-sign-off)
- [Code style](#code-style)
- [Testing expectations](#testing-expectations)
- [Proposing plugins and AI features](#proposing-plugins-and-ai-features)
- [Good first issues](#good-first-issues)
- [Review process](#review-process)
- [License](#license)

---

## Code of Conduct

This project and everyone participating in it is governed by the
[Folio Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are
expected to uphold this code. Please report unacceptable behavior to
Owenpkent@gmail.com.

---

## Ways to contribute

You do not have to write code to make a difference:

- **Report bugs** using the bug report issue form.
- **Request features** using the feature request issue form.
- **Improve documentation**, examples, or tutorials.
- **Triage issues**: reproduce reports, add detail, suggest labels.
- **Review pull requests** and try out branches.
- **Build plugins** or prototype AI-assisted features (see below).
- **Fix code**: start with a [good first issue](#good-first-issues).

---

## Development setup

Folio is a [Tauri 2](https://tauri.app) desktop app: a Rust backend with a
React 18 + TypeScript 5 frontend built by Vite 5, rendering PDFs with
[PDF.js](https://mozilla.github.io/pdf.js/) and managing state with
[Zustand](https://github.com/pmndrs/zustand).

For the complete, step-by-step setup (including platform prerequisites and the
Rust/Tauri toolchain), follow **[docs/getting-started.md](./docs/getting-started.md)**.
The short version:

### Prerequisites

- **Node.js >= 20** (CI runs on 20 and 22) and **npm**.
- **Rust (stable)** via [rustup](https://rustup.rs/).
- Tauri's OS prerequisites. On Debian/Ubuntu Linux:

  ```bash
  sudo apt-get update
  sudo apt-get install -y \
    libwebkit2gtk-4.1-dev \
    libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    patchelf \
    build-essential \
    curl wget file \
    libssl-dev \
    libgtk-3-dev
  ```

  See the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)
  for macOS and Windows.

### Install and run

```bash
git clone https://github.com/owenpkent/folio.git
cd folio
npm ci                 # install exact dependencies from the lockfile
npm run tauri dev      # launch the desktop app with hot reload
```

Other useful scripts:

| Script                 | What it does                              |
| ---------------------- | ----------------------------------------- |
| `npm run dev`          | Vite dev server (frontend only)           |
| `npm run build`        | Production frontend build                 |
| `npm run preview`      | Preview the production build              |
| `npm run tauri`        | Run the Tauri CLI                         |
| `npm run lint`         | ESLint over the codebase                  |
| `npm run format`       | Prettier formatting                       |
| `npm run typecheck`    | TypeScript type checking                  |
| `npm run test`         | Vitest unit tests                         |
| `npm run test:e2e`     | Playwright end-to-end tests               |

---

## Project layout

A quick map so you know where things live:

- `src/` - React + TypeScript frontend (components, Zustand stores, PDF.js glue).
- `src-tauri/` - Rust backend, Tauri commands, and app configuration.
- `docs/` - documentation, including `getting-started.md`.
- `.github/` - issue forms, PR template, CI workflows, and automation.

---

## Branching and pull request workflow

1. **Fork** the repository and clone your fork.
2. **Create a branch** off `main` with a descriptive name. We like the
   `type/short-description` convention, which mirrors our commit types:

   ```bash
   git switch -c feat/thumbnail-sidebar
   git switch -c fix/text-selection-offset
   git switch -c docs/contributing-typos
   ```

3. **Make your change.** Keep pull requests focused: one logical change per PR is
   much easier to review than a grab bag.
4. **Keep up to date** by rebasing on the latest `main` when needed:

   ```bash
   git fetch origin
   git rebase origin/main
   ```

5. **Run the checks locally** before pushing (see
   [Testing expectations](#testing-expectations)):

   ```bash
   npm run lint
   npm run typecheck
   npm run test
   ```

6. **Push** and open a pull request against `owenpkent/folio:main`. Fill in the
   PR template completely, and link the issue your PR addresses (for example,
   `Closes #123`).
7. Mark the PR as a **draft** if it is still a work in progress.

---

## Commit messages (Conventional Commits)

Folio uses [Conventional Commits](https://www.conventionalcommits.org/). This
keeps history readable and lets us automate changelogs and releases.

Format:

```
<type>(<optional scope>): <short summary>

<optional body>

<optional footer(s)>
```

Common types:

- `feat` - a new feature
- `fix` - a bug fix
- `docs` - documentation only
- `style` - formatting, no code change
- `refactor` - code change that neither fixes a bug nor adds a feature
- `perf` - a performance improvement
- `test` - adding or fixing tests
- `build` - build system or dependencies
- `ci` - CI configuration
- `chore` - other changes that do not modify src or test files

Examples:

```
feat(viewer): add continuous scroll mode
fix(annotations): correct highlight offset on rotated pages
docs(contributing): document the DCO sign-off flow
perf(render): cache rasterized pages across zoom changes
refactor(store): split viewer state into focused Zustand slices
```

Breaking changes use a `!` after the type/scope and a `BREAKING CHANGE:`
footer:

```
feat(plugins)!: change the plugin manifest schema

BREAKING CHANGE: `permissions` is now an array of scoped strings.
```

---

## Developer Certificate of Origin (DCO sign-off)

Folio requires every commit to be signed off under the
[Developer Certificate of Origin](https://developercertificate.org/). The
sign-off is a simple line at the end of each commit message that certifies you
wrote the patch or otherwise have the right to submit it under the project's
license:

```
Signed-off-by: Jane Developer <jane@example.com>
```

The name and email must match your Git identity. Git adds this line for you
when you pass `-s`:

```bash
git commit -s -m "feat(viewer): add continuous scroll mode"
```

To sign off work you already committed:

```bash
git commit --amend -s          # for the most recent commit
git rebase --signoff origin/main   # to sign off a range of commits
```

Set your identity once so the sign-off is correct:

```bash
git config user.name "Jane Developer"
git config user.email "jane@example.com"
```

A DCO check runs on every pull request. PRs with unsigned commits cannot be
merged until every commit is signed off.

---

## Code style

- **TypeScript / React**: linted with **ESLint** and formatted with
  **Prettier**. Run:

  ```bash
  npm run lint      # report problems (add -- --fix locally to autofix)
  npm run format    # apply Prettier formatting
  ```

- **Rust**: format with `cargo fmt` and lint with `cargo clippy` in
  `src-tauri/`. Please keep Clippy warning-free.
- Prefer clear names and small, focused modules. Match the style of the
  surrounding code.
- Do not commit formatting-only churn mixed into a feature PR; keep it separate.

CI enforces linting, formatting, and type checks, so running them locally saves
a round trip.

---

## Testing expectations

- **Unit tests (Vitest):** add or update tests for the behavior you change.

  ```bash
  npm run test
  ```

- **End-to-end tests (Playwright):** for user-facing flows and regressions.

  ```bash
  npm run test:e2e
  ```

- Bug fixes should include a test that fails before the fix and passes after.
- New features should include unit tests, plus e2e coverage when they touch the
  UI or a full workflow.
- Keep tests deterministic and fast. Prefer generating small fixtures at runtime
  (the e2e suite builds its sample PDF with pdf-lib in `e2e/global-setup.ts`)
  rather than committing binaries.

See [docs/testing.md](docs/testing.md) for how the unit and e2e suites are
organized and what is covered. All tests must pass in CI before a PR can merge.

---

## Proposing plugins and AI features

Folio is designed to be extensible, and we welcome plugin and AI-assisted
feature proposals. Because these touch security, privacy, and the trust model,
we ask you to start with a proposal rather than a large surprise PR:

1. **Open a feature request** using the feature request issue form, and select
   the **plugins** or **AI** area. Describe the use case, the data the feature
   would access, and any external services involved.
2. For anything that reads document contents, calls a network service, or uses
   an AI/MCP integration, describe the **data-handling and permissions** model:
   what leaves the user's machine, when, and with what consent. See
   [SECURITY.md](./SECURITY.md) for our plugin trust model and AI/MCP
   data-handling scope.
3. Discuss the design in the issue or a
   [Discussion](https://github.com/owenpkent/folio/discussions) before writing
   significant code. A short design note saves everyone time.
4. Once there is rough agreement, open a draft PR and iterate.

Plugins should be least-privilege by default and must never exfiltrate document
data without explicit user action.

---

## Good first issues

New to the project? Look for issues labeled
[`good first issue`](https://github.com/owenpkent/folio/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
and [`help wanted`](https://github.com/owenpkent/folio/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).
These are scoped to be approachable and usually include pointers to the
relevant files.

Tips for a smooth first contribution:

- Comment on the issue to let others know you are working on it.
- Ask questions early; a small clarification beats a large rewrite.
- Keep the PR small and focused on the linked issue.

---

## Review process

- A maintainer will review your PR as soon as they can. Please be patient; this
  is a community project.
- Expect feedback. Reviews are about the code, not the person, and iteration is
  normal and healthy.
- Address comments by pushing additional commits (we squash on merge, so you do
  not need to rewrite history for every round). Re-request review when ready.
- CI must be green: lint, typecheck, unit tests, the Tauri build matrix, and the
  DCO check all need to pass.
- At least one maintainer approval is required to merge. Maintainers may merge
  with a squash commit that preserves a Conventional Commit summary.

Thank you for helping build Folio. We are glad you are here.

---

## License

By contributing to Folio, you agree that your contributions will be licensed
under the [MIT License](./LICENSE) that covers the project.
