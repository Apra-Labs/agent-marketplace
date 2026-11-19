# stop-agents

Stops Claude Code background agents with one command. Use it inside Claude or from any terminal.

It targets the agents that still have a running process: entries in `claude agents --json` that have both an `id` and a `pid`. Conversations are kept; `claude attach <id>` or `claude --resume` reopens them.

Needs `claude` on PATH. The bash version also needs `jq`, `python3` or `python`. The Windows version needs only PowerShell.

## Install

```
/plugin marketplace add Apra-Labs/agent-marketplace
/plugin install stop-agents@apra
```

(One step on Claude Code 2.1.275 or later: `/plugin install stop-agents --marketplace Apra-Labs/agent-marketplace`.)

## Use it

**Inside Claude** (plugin installed and enabled):

```
/stop-agents:stop              list, ask, then stop
/stop-agents:stop -s blocked   only agents in the "blocked" state
```

It runs `stop-agents --dry-run`, shows the list, asks you to confirm in chat, then runs `stop-agents -y`. Plugin `bin/` folders are on the Bash tool's PATH while the plugin is enabled, so Claude can also run `stop-agents` directly.

**From any terminal**: install the command once, either with `/stop-agents:install-cli` (copies the three files to `~/.local/bin` and shows the PATH line for your shell, asking before it edits anything), or by hand:

| Shell | Copy | PATH |
|---|---|---|
| Windows cmd / PowerShell | copy `bin\stop-agents.cmd` and `bin\stop-agents.ps1` to `%USERPROFILE%\.local\bin` | `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';' + "$env:USERPROFILE\.local\bin", 'User')`, then open a new terminal |
| Git Bash | copy `bin/stop-agents` to `~/.local/bin`, `chmod +x` it | `export PATH="$HOME/.local/bin:$PATH"` in `~/.bashrc` |
| macOS / Linux bash | same | same, in `~/.bashrc` |
| macOS / Linux zsh | same | same, in `~/.zshrc` |

Copy the files, do not put the plugin folder on PATH: its path contains the plugin version and changes on every update. Re-run `/stop-agents:install-cli` (or copy again) after updating the plugin.

## Flags

| Flag | Meaning |
|---|---|
| `-y`, `--yes` | stop without asking |
| `-n`, `--dry-run` | only list what would be stopped |
| `-s`, `--state a,b` | also restrict to these states (comma-separated, e.g. `blocked,working`) |

Without `-y` it asks `Stop all of them? [y/N]`. If there is no terminal to ask on (a script, a pipe, a tool run), it prints `No terminal to confirm; rerun with -y to stop them.` and stops nothing, exit code 0. Exit code is 1 if any stop failed; the others are still stopped.

## Safety

- **It never stops its own session.** When `CLAUDE_CODE_SESSION_ID` is set (Claude Code sets it in every session), the agent with that `sessionId` is skipped and reported: `Skipping <id> (<name>): this is the current session.` So an agent that runs `stop-agents -y` through the plugin or from a copy outside the plugin is still protected from stopping itself.
- **Interactive sessions are skipped.** They appear in `claude agents --json` with a `pid` but no `id`, and `claude stop <id>` only accepts background-session ids. Entries with no `pid` (no live process) are skipped as well.

## Caveats

It relies on `claude agents --json`, which is undocumented and may change. Upstream request for a built-in `claude stop --all`: https://github.com/anthropics/claude-code/issues/109414.

## Tests

`npm test` at the repo root runs `tests/stop-agents.test.mjs` against a fake `claude`; no real agent is touched. The PowerShell tests run on Windows only.
