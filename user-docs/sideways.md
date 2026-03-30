# Sideways

Sideways is a documentation sharing platform built for teams that care about beautiful rendered output, LLM-assisted editing, and programmatic access.

Documents are written in markdown. Sideways renders them with proper typography, supports comments anchored to specific text, exports to PDF with themed cover pages, and integrates with AI agents via MCP.

## Quick Start

**Browse documentation** — visit your Sideways instance and explore spaces.

**Create a space** — click "New space" on the home page, or use the CLI:

```bash
sideways init "My Project"
sideways push
```

**Install the CLI** — visit the [[setup|Setup]] page for installation instructions.

## Key Concepts

- **Spaces** — top-level containers for documentation (like projects or teams)
- **Sections** — organizational groupings within a space (mapped from directories)
- **Documents** — markdown files, versioned, with tags and comments
- **Comments** — threaded discussions anchored to specific text passages

## Features

- [[writing|Writing & Editing]] — markdown with GFM, math, syntax highlighting, wiki-links
- [[cli-guide|CLI Guide]] — push, pull, sync documentation from your terminal
- [[comments-guide|Comments & Review]] — inline comments, @mentions, notifications
- [[search-guide|Search]] — full-text search across all your documentation
- [[pdf-export|PDF Export]] — beautiful PDFs with themed cover pages and table of contents
- [[mcp-guide|MCP & AI Agents]] — let Claude and other LLMs read and write your docs
- [[themes|Themes]] — customise fonts, colors, and cover pages per space
