# Apra Labs agent marketplace

This repo is the single place Apra Labs publishes Claude Code plugins (skills, agents, commands, hooks, MCP server configs), and the home of their source. People install from it with:

    /plugin marketplace add Apra-Labs/agent-marketplace
    /plugin install <plugin>@apra

apra-fleet is **not** delivered from here: `apra-fleet install` installs the fleet binary, MCP server and fleet's own skills (`/fleet`, `/pm`, `/fleet-supervisor`, `/fleet-sprint`, ...) for every supported agent. Plugins here only state which apra-fleet version they need and check it (rule 4).

## What lives here

- `.claude-plugin/marketplace.json` — the catalog. Marketplace name is `apra`.
- `plugins/<name>/` — one folder per plugin: its manifest, its skills/agents/hooks, its tests, README and LICENSE.
- `package.json` — dev tooling for all plugins (`npm test` runs every `plugins/*/tests/`).
- `docs/tasks/` — task briefs. Work the lowest-numbered open one.

## Rules

1. **Source lives here, in the plugin's folder.** A new skill is written in `plugins/<name>/`, tests in `plugins/<name>/tests/` (Claude Code loads only the manifest and `skills/`, `agents/`, `commands/`, `hooks/`; other folders ship but are ignored). Never put a `package.json` + lockfile in a plugin folder: Claude Code would `npm install` it on every user's machine. Dev dependencies go in the root `package.json`. No `node_modules`, no git submodules. A plugin gets its own source repo only when it needs a build or heavy inputs, has its own install route or audience, or needs different access; it is then pulled in by a sync script under `scripts/` and never edited here. None does today.
2. **Plugins reference their own files relative to themselves.** Never hardcode `~/.claude/skills/...` or any install path. In SKILL.md bodies use `${CLAUDE_SKILL_DIR}` (the skill's own folder; Claude Code substitutes it, with forward slashes on Windows); in hooks and MCP configs use `${CLAUDE_PLUGIN_ROOT}`. Quote it in commands.
3. **Nothing that must survive an update goes inside a plugin folder.** The cache is replaced on update. User config and credentials live in the user's home directory.
4. **apra-fleet is required, not delivered.** A plugin that needs apra-fleet states the minimum version in its `plugin.json` description, its README and the README table, and its SKILL.md first checks it: call `mcp__apra-fleet__version`; if the tool is missing or the version is too low, stop and point the user at https://github.com/Apra-Labs/apra-fleet/blob/main/docs/install.md. Other plugins it needs go in `dependencies` with a version range. Skills that are always used together go in the same plugin.
5. **Versioning:** semver in `plugin.json`, the same version in the plugin's `marketplace.json` entry, and a git tag `<plugin>--v<version>` created with `claude plugin tag --push` from the plugin folder. Never edit a released tag.
6. **Every change passes `npm test` and `claude plugin validate`** on the marketplace and each changed plugin, and is installed and exercised once locally before it's committed.
7. **Windows is the primary platform.** Anything a plugin runs must work from PowerShell and Git Bash on Windows, not just Linux/macOS.
8. **Public repo.** No credentials, internal hostnames or IPs, client names, or Bitbucket/Azure DevOps URLs of private projects. Skills that are client- or site-specific don't belong here.
9. **License:** Apache-2.0 (same as apra-fleet): a `LICENSE` in the plugin folder and `"license": "Apache-2.0"` in `plugin.json`. Bundled third-party code ships its notices.

## Releasing a plugin

1. Change it here (or, for an external-source plugin, merge in its repo and run its sync script).
2. Bump `version` in `plugins/<name>/.claude-plugin/plugin.json` and in `marketplace.json`; add a CHANGELOG line.
3. `npm test`, `claude plugin validate .` and `claude plugin validate plugins/<name>`.
4. Merge, then from `plugins/<name>` run `claude plugin tag --push`.
