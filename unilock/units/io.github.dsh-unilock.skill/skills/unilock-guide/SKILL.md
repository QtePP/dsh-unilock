---
name: unilock-guide
description: Explain how the five unilock units compose. Use when a task asks about the unilock capability split or how to assemble a composition.
---

# unilock guide

Five independent units, one responsibility each:

| Unit | Provides | Owns |
|---|---|---|
| `command` | `unilock.command` | slash-command plane |
| `cli` | `unilock.cli` | a standalone executable |
| `skill` | `unilock.skill` | model-readable instructions (this file) |
| `tool` | `unilock.tool` | a model-callable tool definition |
| `mcp` | `unilock.mcp` | an external MCP server connection |

A composition selects any subset. Units never import each other. When one unit
needs another, it declares a capability name in `requires.capabilities` and the
composition resolves it — never a package path.
