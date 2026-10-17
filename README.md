# e2b-sandbox-mcp

An MCP server that gives AI agents safe code execution through [E2B](https://e2b.dev) sandboxes.

## Why

AI agents that generate code need a safe place to run it. E2B provides Firecracker microVMs that spin up in milliseconds, run arbitrary code, and disappear. This MCP server wraps that capability into five tools any agent can call.

## Tools

| Tool | What it does |
|---|---|
| `run-code` | Create a sandbox, execute Python, return output, destroy sandbox |
| `run-with-file` | Upload a file into a sandbox, run code against it |
| `list-templates` | Show available custom sandbox templates |
| `scaffold-template` | Generate a Dockerfile + e2b.toml for a custom template |
| `doctor` | Check SDK installation, API key, and connectivity |

## Setup

```bash
npm install
```

Requires:
- Node.js 18+
- Python 3.10+ with `e2b` and `e2b-code-interpreter` packages
- An E2B API key (free at [e2b.dev](https://e2b.dev))

```bash
pip install e2b e2b-code-interpreter
export E2B_API_KEY=your_key_here
```

## Usage with Claude Code

```bash
claude mcp add --transport stdio e2b-sandbox -s user -- node /path/to/e2b-sandbox-mcp/src/index.js
```

Set `E2B_SANDBOX_MCP_PYTHON` if your E2B packages are in a venv:

```bash
export E2B_SANDBOX_MCP_PYTHON=/path/to/venv/bin/python3
```

## Example

Ask your agent to run code in a sandbox:

> "Run this data analysis in an E2B sandbox: read sales.csv and compute monthly totals"

The agent calls `run-with-file` with the CSV content and analysis code. The sandbox runs it in isolation — no access to your filesystem, network, or credentials.

## License

MIT
