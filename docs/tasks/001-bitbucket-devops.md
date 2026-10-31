# Task 001 — Publish bitbucket-devops as the first plugin

**Status:** open
**Source repo:** https://github.com/Apra-Labs/bitbucket-devops-skill (default branch; includes the `bitbucket-mcp` submodule, branch `apralabs-develop`)
**Result:** `bitbucket-devops@apra` installs with `/plugin install` on Windows and Linux, and its helpers work from the installed location.

## Why this isn't a straight copy

The skill was built to be installed by `install.sh` into `~/.claude/skills/bitbucket-devops/`. Four things break when it's installed as a plugin instead:

1. **Hardcoded paths.** SKILL.md tells the agent to run `node ~/.claude/skills/bitbucket-devops/lib/helpers.js ...` and `.../bitbucket-mcp/dist/index-cli.js ...` (about 20 places). A plugin is installed into Claude Code's plugin cache, so every one of these is wrong. `helpers.js` itself is fine: it finds `bitbucket-mcp` relative to its own `__dirname`.
2. **Build step.** `bitbucket-mcp/dist/index-cli.js` only exists after `npm install && npm run build` in the submodule. Plugin install runs no build, and `node_modules` must not be committed here.
3. **`self-update`.** The helper does `git pull` / re-runs `install.sh` against its own folder. Inside the plugin cache that fights Claude Code's own update mechanism and its changes are wiped on the next update.
4. **Skill-level credentials.** The third credentials location, `~/.claude/skills/bitbucket-devops/credentials.json`, won't exist for plugin users, and anything saved inside the plugin folder is lost on update. `./credentials.json`, `./.bitbucket-credentials` and `~/.bitbucket-credentials` still work.

## Steps

### 1. Check the two Claude Code facts this task depends on
Read the current Claude Code docs (skills, plugins reference, plugins loading) and confirm:
- the variable Claude Code substitutes in a SKILL.md body for the skill's own directory (expected `${CLAUDE_SKILL_DIR}`), and that it resolves correctly for a skill installed from a plugin;
- whether plugins can declare Node package dependencies that Claude Code installs (see "Node.js package dependencies" in the plugins loading docs).
Write what you found at the top of this file under **Findings** before changing anything.

### 2. Decide how to ship the CLI
Default: bundle `bitbucket-mcp`'s CLI entry into **one self-contained JS file** (esbuild, `--platform=node --format=esm`, all deps inlined) at `plugins/bitbucket-devops/skills/bitbucket-devops/bin/bitbucket-cli.mjs`. No install step, nothing to build on the user's machine.
Only if step 1 shows plugin-declared Node dependencies are reliable on Windows, consider that instead — and say why in Findings.
Requires Node >= the version `bitbucket-mcp` needs; state it in the plugin description and README row.

### 3. Make the source repo produce the plugin
In **bitbucket-devops-skill** (on a branch, PR to its default branch):
- Add `npm run build:plugin` that builds the submodule, bundles the CLI (step 2), and writes the complete plugin to `dist-plugin/`:
  ```
  dist-plugin/
  ├── .claude-plugin/plugin.json
  └── skills/bitbucket-devops/
      ├── SKILL.md
      ├── bin/bitbucket-cli.mjs
      ├── lib/helpers.js
      ├── docs/            (REFERENCE, PATTERNS, TROUBLESHOOTING, GIT_OPERATIONS; drop ARTIFACTS_RESEARCH and the large OpenAPI/Swagger files unless SKILL.md actually tells the agent to read them)
      └── credentials.json.template
  ```
- Rewrite paths in the **plugin copy** of SKILL.md to the skill-directory variable from step 1. Keep the source SKILL.md working for the existing `install.sh` route (generate the plugin copy by substitution during the build rather than forking the file).
- Make `helpers.js` look for the CLI at `bin/bitbucket-cli.mjs` first and fall back to `bitbucket-mcp/dist/index-cli.js`, so both install routes work.
- When running from a plugin (detect: no `.git` and no `.install-version.json` next to it, or an env/path check you can justify), `self-update` and `check-for-updates` print "Installed as a Claude Code plugin — update with /plugin marketplace update apra" and exit 0.
- In SKILL.md (plugin copy), list credential locations without the skill-level one, and tell the agent to point users at `~/.bitbucket-credentials`.
- `plugin.json`: name `bitbucket-devops`, version = the source repo's current version, description (one line, mention Bitbucket Cloud pipelines/PRs/deployments and the Node requirement), author Apra Labs, homepage + repository = the source repo, license `CC-BY-4.0` (matches the source repo), keywords. No `dependencies`: this skill needs no other plugin and no MCP server.
- Add a CHANGELOG entry.

### 4. Bring it into the marketplace
In **this repo**:
- Add `scripts/sync-bitbucket-devops.sh` (and a `.ps1` wrapper, like the source repo's `install.ps1`) that: clones the source repo at a given ref with submodules, runs `npm ci` + `npm run build:plugin`, and replaces `plugins/bitbucket-devops/` with `dist-plugin/`. Ref defaults to the latest release tag.
- Run it.
- Add the entry to `.claude-plugin/marketplace.json`: `name`, `source: "./plugins/bitbucket-devops"`, `description`, `version`, `category: "devops"`, `keywords`.
- Add the README table row.

### 5. Verify — on Windows, then Linux
1. `claude plugin validate .` and `claude plugin validate plugins/bitbucket-devops` pass.
2. Fresh profile (or after removing any `~/.claude/skills/bitbucket-devops` install so it can't mask failures): `/plugin marketplace add <local path to this repo>`, `/plugin install bitbucket-devops@apra`.
3. In a new session, ask "check credentials for Bitbucket" → the agent runs `check-credentials` from the plugin path, not `~/.claude/skills`.
4. With real credentials in `~/.bitbucket-credentials`: "show the latest failed pipeline for <workspace>/<repo>" works end to end, and one Tier 2 command (e.g. `list-pipelines`) runs through `bin/bitbucket-cli.mjs`.
5. `self-update` prints the plugin message.
6. `grep -rn "\.claude/skills" plugins/bitbucket-devops` returns nothing.
Record commands and results under **Verification** at the bottom of this file.

### 6. Release
Commit, push, then from `plugins/bitbucket-devops`: `claude plugin tag --push`. Mark this task **done**.

## Out of scope
- Changing what the skill does.
- Gemini CLI / OpenCode packaging (the README note covers manual copy).
- CI automation of the sync script — do it by hand for this first plugin; automate once there are two or three plugins.

## Findings
_(fill in at step 1)_

## Verification
_(fill in at step 5)_
