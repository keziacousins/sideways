# MCP & AI Agents

Sideways includes a built-in MCP (Model Context Protocol) server that lets AI agents like Claude read, write, search, and comment on documentation.

## Setting Up Claude Desktop

Add to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "sideways": {
      "url": "https://your-sideways-instance/api/mcp",
      "headers": {
        "Authorization": "Bearer sk-your-api-key"
      }
    }
  }
}
```

The API key must be passed in the `Authorization` header — Sideways no longer accepts keys via `?key=` query parameter (they would leak through browser history, server logs, and the `Referer` header).

Create an API key with an agent name (e.g. "Claude") in the web UI under API Keys. This ensures comments and edits are attributed to the agent.

## Setting Up Claude Code

Add to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "sideways": {
      "command": "node",
      "args": ["/path/to/sideways-mcp.cjs"],
      "env": {
        "SIDEWAYS_API_URL": "https://your-sideways-instance",
        "SIDEWAYS_API_KEY": "sk-your-api-key"
      }
    }
  }
}
```

The installer drops `sideways-mcp.cjs` alongside `sideways.cjs` in `~/.local/bin/` — point `args` at that file (not the CLI bundle).

## Available Tools

Tools are namespaced by entity: `space_*`, `doc_*`, `comment_*`, plus `search`.

### Document refs

Every doc has a single-string canonical ref: `<space>:<section>/<path>.md` — e.g. `engineering:architecture/api-design.md`. `search` and `doc_list` emit refs you can copy verbatim into `doc_read`, `doc_edit`, `comment_add`, etc.

### Spaces
| Tool | Description |
|------|-------------|
| `space_list` | List all accessible spaces |
| `space_create` | Create a new space |

### Documents

| Tool | Description |
|------|-------------|
| `doc_list` | List documents in a space |
| `doc_read` | Read a document's markdown (optionally with comments) |
| `doc_write` | Create or update a document (upsert) |
| `doc_edit` | Search-and-replace edits without rewriting |
| `doc_rename` | Rename a document's title (path-changing renames go through `doc_move`) |
| `doc_move` | Move to another space, section, or path |
| `doc_duplicate` | Create a copy |
| `doc_delete` | Delete a document |
| `doc_versions` | List version history |

### Comments
| Tool | Description |
|------|-------------|
| `comment_add` | Add a comment (with optional anchor text) |
| `comment_list` | List comments (threaded display) |
| `comment_resolve` | Toggle resolve/reopen |

### Search
| Tool | Description |
|------|-------------|
| `search` | Full-text search across documents |

## The doc_edit Tool

`doc_edit` is particularly useful for AI agents — it applies search-and-replace edits without needing to rewrite the entire document:

```
doc_edit(ref="engineering:architecture/api-design.md", edits=[
  { old: "Status: Draft", new: "Status: Approved" },
  { old: "## Next Steps\n\n1. Review", new: "## Next Steps\n\n1. ~~Review~~ Done" }
])
```

Edits are applied sequentially. If any `old` string isn't found, the operation fails with no changes saved.

## Agent Identity

API keys can have an **actor name** — set this to "Claude" or your agent's name when creating the key. This ensures:

- Comments show as "Claude via Your Name"
- You receive notifications when the agent replies to your comments
- You receive notifications when the agent updates watched documents

For CLI usage, set the environment variable:

```bash
SIDEWAYS_ACTOR="Claude" sideways push
```

## Server Instructions

The MCP server provides context instructions to the AI agent explaining the Sideways data model, common workflows, and how to use wiki-links and document hierarchy. Agents can immediately start working with documentation without additional prompting.
