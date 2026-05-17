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
| `sideways push [path]` | Push tracked local changes to remote |
| `sideways pull [path]` | Pull remote changes to local |
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
