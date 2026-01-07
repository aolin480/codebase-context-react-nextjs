# MCP client configuration examples
This document contains example MCP client configurations for running this fork via `npx` + GitHub reference.
Replace `/path/to/your/project` with the directory you want indexed.
## Claude Desktop / VS Code / Cursor
Add this to your MCP client config:
```json
{
  "mcpServers": {
    "codebase-context-react-nextjs": {
      "command": "npx",
      "args": [
        "-y",
        "github:aolin480/codebase-context-react-nextjs#master",
        "/path/to/your/project"
      ]
    }
  }
}
```
## Warp
Add this to your Warp MCP configuration:
```json
{
  "codebase-context-react-nextjs": {
    "command": "npx",
    "args": [
      "-y",
      "github:aolin480/codebase-context-react-nextjs#master",
      "/path/to/your/project"
    ]
  }
}
```
## Codex
Add this to your Codex MCP configuration:
```toml
[mcp_servers.codebase-context-react-nextjs]
command = "npx"
args = [
  "-y",
  "github:aolin480/codebase-context-react-nextjs#master",
  "/path/to/your/project"
]
```
## Gemini
Add this to your Gemini MCP configuration:
```json
{
  "codebase-context-react-nextjs": {
    "command": "npx",
    "args": [
      "-y",
      "github:aolin480/codebase-context-react-nextjs#master",
      "/path/to/your/project"
    ]
  }
}
```
## OpenCode
Add this to your OpenCode MCP configuration:
```json
{
  "mcp": {
    "codebase-context-react-nextjs": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "github:aolin480/codebase-context-react-nextjs#master",
        "/path/to/your/project"
      ],
      "enabled": true
    }
  }
}
```
