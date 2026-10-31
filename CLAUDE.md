# Apra Labs agent marketplace

This repo is the single place Apra Labs publishes Claude Code plugins (skills, agents, commands, hooks, MCP server configs). People install from it with:

    /plugin marketplace add Apra-Labs/agent-marketplace
    /plugin install <plugin>@apra

## What lives here

- `.claude-plugin/marketplace.json` — the catalog. Marketplace name is `apra`.
- `plugins/<name>/` — one folder per plugin, each with `.claude-plugin/plugin.json`.
- `scripts/` — per-plugin sync scripts that pull a built plugin in from its source repo.
- `docs/tasks/` — task briefs. Work the lowest-numbered open one.

## Rules

1. **Built artifacts only.** Source, tests and dev tooling stay in each plugin's source repo. A plugin folder here holds only what the plugin needs at runtime. No `node_modules`, no git submodules.
2. **Plugins reference their own files relative to themselves.** Never hardcode `~/.claude/skills/...` or any install path. Plugins are installed into Claude Code's plugin cache, not `~/.claude/skills`. In SKILL.md bodies use the skill-directory variable Claude Code substitutes (verify the exact name in the Claude Code skills docs before using it); in hooks and MCP configs use `${CLAUDE_PLUGIN_ROOT}`.
3. **Nothing that must survive an update goes inside a plugin folder.** The cache is replaced on update. User config and credentials live in the user's home directory.
4. **Dependencies are declared, not assumed.** A plugin that needs the apra-fleet MCP or another plugin lists it in `dependencies` in its `plugin.json`, with a version range. Skills that are always used together go in the same plugin.
5. **Versioning:** semver in `plugin.json`, the same version in the plugin's `marketplace.json` entry, and a git tag `<plugin>--v<version>` created with `claude plugin tag --push` from the plugin folder. Never edit a released tag.
6. **Every change passes `claude plugin validate`** on the marketplace and each changed plugin, and is installed and exercised once locally before it's committed.
7. **Windows is the primary platform.** Anything a plugin runs must work from PowerShell and Git Bash on Windows, not just Linux/macOS.
8. **Public repo.** No credentials, internal hostnames or IPs, client names, or Bitbucket/Azure DevOps URLs of private projects.

## Releasing a plugin

1. Run its sync script (or edit it here if it has no source repo).
2. Bump `version` in `plugins/<name>/.claude-plugin/plugin.json` and in `marketplace.json`; add a CHANGELOG line.
3. `claude plugin validate .` and `claude plugin validate plugins/<name>`.
4. Commit, then from `plugins/<name>` run `claude plugin tag --push`.
