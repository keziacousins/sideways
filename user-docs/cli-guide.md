# CLI Guide

The Sideways CLI lets you push, pull, and manage documentation from your terminal.

## Installation

See [[setup|Setup]] for installation instructions.

## Commands

### Tracking & Sync

| Command | Description |
|---------|-------------|
| `sideways add <paths...>` | Track files or directories for sync |
| `sideways add .` | Track everything (default behavior) |
| `sideways remove <paths...>` | Stop tracking files |
| `sideways push [path]` | Push tracked local changes to remote, with the images and PDFs they reference |
| `sideways pull [path]` | Pull remote changes to local, images and PDFs included |
| `sideways sync` | Bidirectional: pull remote + push local |
| `sideways status` | Show sync status + open comment counts |
| `sideways diff <file>` | Show content differences with remote |

### Documents

| Command | Description |
|---------|-------------|
| `sideways search <query>` | Search documents by title and content |
| `sideways rename <file> <title>` | Rename a document |
| `sideways move <file> <space>` | Move to another space |
| `sideways duplicate <file>` | Create a copy |
| `sideways delete <file>` | Delete from server |
| `sideways export <file>` | Download as PDF |

### Comments

| Command | Description |
|---------|-------------|
| `sideways comments <file>` | List comments (threaded) |
| `sideways comment <file> <body>` | Add a comment |
| `sideways resolve <comment-id>` | Toggle resolve/reopen (looked up by ID — no file path) |

Comment options:
- `--anchor <text>` — anchor to specific text
- `--section <path>` — section heading path
- `--reply <id>` — reply to a comment

### Spaces & Members

| Command | Description |
|---------|-------------|
| `sideways space-set <field> <value>` | Update space settings |
| `sideways members` | List space members |
| `sideways member-add <email> [role]` | Add a member |
| `sideways member-remove <id>` | Remove a member |

### Auth

| Command | Description |
|---------|-------------|
| `sideways login` | Authenticate with API key |
| `sideways logout` | Clear credentials |
| `sideways whoami` | Show current user |
| `sideways keys` | List API keys |

### Misc

| Command | Description |
|---------|-------------|
| `sideways version` | Show CLI and configured-remote API versions (warns on drift) |
| `sideways themes` | List print themes available on the configured remote |
| `sideways section <file> <slug>` | Move a doc to a different section within the space |
| `sideways migrate-config` | One-shot rewrite of a legacy `.sideways.yml` to the current schema |

### Global Options

| Option | Description |
|--------|-------------|
| `--as <name>` | Act as a named agent (e.g. `--as Claude`) |
| `--version` | Show version |

Most subcommands also accept `--space <slug>` to override the space configured in `.sideways.yml` (pass it to the subcommand, not the program: `sideways status --space other-space`).

## File Identifiers

All commands that take a document take a **filesystem path**. The path must fall under one of your declared section mounts (see [Configuration](#configuration)):

```bash
sideways diff docs/api-design.md       # relative to cwd
sideways diff ./docs/api-design.md     # explicit relative
sideways diff /abs/path/api-design.md  # absolute
```

Internally the CLI resolves the path to a `(section, path)` pair — the canonical identity of a document — and the server URL becomes `/s/<space>/<section>/<path-without-md>`.

## Selective Tracking

By default, all markdown files are synced. If you only want to sync specific files, use `add`:

```bash
sideways add docs/api-design.md     # track one file
sideways add docs/                  # track a directory
```

After this, only tracked files are included in `push`, `pull`, `sync`, and `status`. Untracked files are listed separately in `status`.

To go back to tracking everything:

```bash
sideways add .
```

To stop tracking a file:

```bash
sideways remove docs/old-draft.md
```

The tracking list is stored in `.sideways/tracked.json`.

## Images and Files

`push`, `pull`, `sync` and `status` carry the images and PDFs your documents use, as well as the documents themselves.

A file is included because a tracked document **references it** with a relative link — `![flow](./img/flow.png)` or `[spec](./spec.pdf)` — not because it sits in a synced directory. Other files in the directory are left alone.

```
$ sideways push
  pushed: docs/auth.md → default/auth.md (local-modified)
  pushed: docs/img/flow.png → default/img/flow.png (new-local)
```

- **push** uploads referenced files that are new or have changed locally. A file is checked on every push, whether or not the document that references it changed.
- **pull** downloads every file the server holds for the sections this repo owns, so a pulled document arrives with its images. Pulling a single document brings the files it references.
- **status** lists them alongside documents, with the same labels.
- A file changed both locally and on the server is a **conflict**; resolve it with `push --force` or `pull --force`, as for a document.

Hosted types are PNG, JPEG, GIF, WebP, SVG and PDF. File names may contain only letters, digits, `.`, `_` and `-`; a push reports any file the server refuses and carries on with the rest:

```
  failed: docs/img/my diagram.png — Path segment "my diagram.png" contains invalid characters
warning: docs/auth.md references docs/img/missing.png, which doesn't exist
```

Deleting a file locally does not delete it from the server, and a file no document references any more stays there until it is replaced.

## Links Between Documents

`push` and `sync` warn about a relative link to another markdown file that Sideways won't be able to resolve:

```
warning: docs/auth.md links to gone.md, which doesn't exist
warning: docs/auth.md links to drafts/plan.md, which exists but isn't synced
warning: docs/auth.md links to ../../other-repo/x.md, which is outside every section
```

The push still goes ahead; the link renders as unresolved until its target is on the server. "Exists but isn't synced" means the file is on disk but untracked or ignored — track it with `sideways add`, or expect the link to stay unresolved.

## Status with Comments

`sideways status` shows open (unresolved) comment counts on remote files:

```
  local-modified   docs/api-design.md [3 comments]
                   docs/roadmap.md [1 comment]
  new-local        docs/new-feature.md
```

Files with no changes but open comments are still shown.

## Dry Run

Preview what would happen without making changes:

```bash
sideways push --dry-run
sideways sync --dry-run
```

Dry run is truly read-only — no spaces, sections, or files are created.

## Reconcile

After a fresh `init` or lost sync state, reconcile compares actual content to resolve status:

```bash
sideways sync --reconcile
```

This fetches remote content for files with mismatched hashes and aligns sync state if the content is identical.

## Configuration

### .sideways.yml

```yaml
space: my-project
name: My Project
api: https://your-sideways-instance
sections:
  default: .
ignore:
  - reference-code
  - tmp
```

`sections:` is a map of **section slug → local directory**. At least one entry is required; `default` is conventional for the top-level mount but you can name it anything. Sections not listed are skipped — sync operations leave them alone.

### Multiple sections

When your docs live alongside code in different subtrees, declare each one:

```yaml
sections:
  default: docs
  api: src/packages/api/docs
  web: src/packages/web/docs
```

This maps three on-disk directories to three sections (`default`, `api`, `web`) in the space. A doc at `src/packages/api/docs/architecture/overview.md` syncs to section `api`, path `architecture/overview.md`, and is reachable at `/s/<space>/api/architecture/overview`.

### ~/.sideways/token.json

Created by `sideways login`. Contains your API key and server URL.
