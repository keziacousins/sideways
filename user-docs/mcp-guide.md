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
      "args": ["/path/to/sideways.cjs"],
      "env": {
        "SIDEWAYS_API_URL": "https://your-sideways-instance",
        "SIDEWAYS_API_KEY": "sk-your-api-key"
      }
    }
  }
}
```

## Available Tools

### Spaces
| Tool | Description |
|------|-------------|
| `list_spaces` | List all accessible spaces |
| `create_space` | Create a new space |

### Documents

Document tools take `(space, path)`. `path` is the filesystem-shaped doc path with `.md` and includes the section as the first segment — e.g. `architecture/overview.md` lives in section `architecture`.

| Tool | Description |
|------|-------------|
| `list_docs` | List documents in a space |
| `read_doc` | Read a document's markdown (optionally with comments) |
| `write_doc` | Create or update a document (upsert) |
| `edit_doc` | Search-and-replace edits without rewriting |
| `rename_doc` | Rename a document's title (path-changing renames go through `move_doc`) |
| `move_doc` | Move to another space, section, or path |
| `duplicate_doc` | Create a copy |
| `delete_doc` | Delete a document |
| `doc_versions` | List version history |

### Comments
| Tool | Description |
|------|-------------|
| `add_comment` | Add a comment (with optional anchor text) |
| `list_comments` | List comments (threaded display) |
| `resolve_comment` | Toggle resolve/reopen |

### Search
| Tool | Description |
|------|-------------|
| `search_docs` | Full-text search across documents |

## The edit_doc Tool

`edit_doc` is particularly useful for AI agents — it applies search-and-replace edits without needing to rewrite the entire document:

```
edit_doc(space="engineering", path="architecture/api-design.md", edits=[
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
