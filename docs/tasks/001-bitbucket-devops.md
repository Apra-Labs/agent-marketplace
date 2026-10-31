# Task 001 — Publish bitbucket-devops as the first plugin

**Status:** in review - release (step 6) waiting for approval
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
Checked against https://code.claude.com/docs/en/ (skills, plugins/manifest-reference, plugins/loading, plugins/marketplace-reference, plugins/cli-reference) on 2026-10-31, Claude Code 2.1.314.

1. **Skill directory variable: `${CLAUDE_SKILL_DIR}`.** "The directory containing the skill's `SKILL.md` file. For plugin skills, this is the skill's subdirectory within the plugin, not the plugin root." It is substituted in the SKILL.md body and in `allowed-tools` Bash rules, so for an installed plugin it resolves to `.../plugins/cache/apra/bitbucket-devops/<version>/skills/bitbucket-devops`. On Windows substituted paths use forward slashes (`C:/Users/...`), which works from both PowerShell and Git Bash. It is NOT substituted in files the agent reads later (docs/*.md) and NOT exported to Bash-tool commands; so docs/ in the plugin refer to `${CLAUDE_SKILL_DIR}` and SKILL.md (where it is substituted) tells the agent what that path is. `${CLAUDE_PLUGIN_ROOT}` is also substituted in plugin skill bodies, but it is the plugin root, so `${CLAUDE_SKILL_DIR}` is the right one here.
2. **Plugin Node package dependencies exist** ("Node.js package dependencies", plugins/loading): if the plugin root has `package.json` + a lockfile, Claude Code runs that package manager from the user's PATH when it copies the plugin into the cache and moves `node_modules` into the cached copy. Caveats: needs npm on PATH, 60 s timeout, `--ignore-scripts`, registry deps only, cannot be turned off, a failed or skipped install leaves the plugin loaded but broken (only a note in `/plugin`), and it does not run at all for a plugin loaded in place from a local-path marketplace. **Decision: bundle** the CLI into one self-contained `bin/bitbucket-cli.mjs` (esbuild, all deps inlined, ~450 KB). Nothing to install or build on the user's machine and no npm-on-PATH or timeout failure mode. A trial bundle of `bitbucket-mcp/src/index-cli.ts` ran with no `node_modules` present.
3. Node requirement: `bitbucket-mcp` declares `engines.node >=18`; the bundle targets node18.
4. Other facts used: `plugin.json` and the marketplace entry may both carry `version` (validate warns only if they differ; plugin.json wins). `claude plugin tag` creates `<name>--v<version>` and refuses if the two disagree or the tree is dirty. A marketplace added from a local directory loads plugins in place (no cache copy), so verification installs from a `file://` git URL of this repo to exercise the real cache path.

## Verification
2026-10-31, Claude Code 2.1.314. Plugin built by `scripts/sync-bitbucket-devops.ps1 -Ref feat/plugin-build` (source PR Apra-Labs/bitbucket-devops-skill#7; no release tag exists yet). Real workspace/repo names replaced with `<workspace>/<repo>`.

**Windows 11 (PowerShell + Git Bash, Node 22)**
1. `claude plugin validate .` -> passed (advice only: README could show the one-step `--marketplace` install line). `claude plugin validate plugins/bitbucket-devops` -> passed (warning: no icon).
2. Fresh profile: `CLAUDE_CONFIG_DIR=<empty dir>`, `claude plugin marketplace add "https://github.com/Apra-Labs/agent-marketplace.git#feat/bitbucket-devops-plugin"` (a local path loads in place and `file://` URLs are rejected by this CLI, so a git ref was used to exercise the real cache copy), `claude plugin install bitbucket-devops@apra` -> installed 1.3.0, enabled, at `<config>/plugins/cache/apra/bitbucket-devops/1.3.0/`.
3. Session: `claude -p "... check credentials for Bitbucket ..." --plugin-dir <installed cache dir>` -> the agent ran `node "C:/Users/<user>/.../cache/apra/bitbucket-devops/1.3.0/skills/bitbucket-devops/lib/helpers.js" check-credentials` (`${CLAUDE_SKILL_DIR}` substituted with forward slashes) and reported `~/.bitbucket-credentials` active, tier1Ready/tier2Ready true. Note: a fresh profile has no Claude login, so the session ran in the normal profile; there a leftover `~/.claude/skills/bitbucket-devops` install wins when the prompt does not name the skill (it is listed as `bitbucket-devops`, the plugin as `bitbucket-devops:bitbucket-devops`). Users who installed the old way should delete `~/.claude/skills/bitbucket-devops` after installing the plugin.
4. Same session, real credentials: latest failed pipeline for `<workspace>/<repo>` -> build #108 FAILED via `helpers.js get-latest-failed`; Tier 2 `node ".../bin/bitbucket-cli.mjs" list-pipelines <workspace> <repo> 3` -> 3 pipelines. Directly from the cache dir: `bin/bitbucket-cli.mjs list-repos <workspace> 50` -> exit 0.
5. `node <cache>/lib/helpers.js self-update` and `check-for-updates` -> `Installed as a Claude Code plugin - update with /plugin marketplace update apra`, exit 0.
6. `grep -rn "\.claude/skills" plugins/bitbucket-devops` and the installed cache -> no matches (exit 1). `npm run build:plugin` also fails the build if any remain.

**Linux (Debian bookworm container `node:22-bookworm`, Claude Code 2.1.314, fresh home, no credentials)**
- `claude plugin marketplace add <same URL#ref>` + `claude plugin install bitbucket-devops@apra` -> installed 1.3.0 at `/root/.claude/plugins/cache/apra/bitbucket-devops/1.3.0/`.
- grep `.claude/skills` in the cache -> none. `self-update` -> plugin message, exit 0. `check-credentials` -> "No credentials file found", exit 0. Bundled CLI loads with no `node_modules` (fails only on missing credentials, as expected). Live API calls were not run on Linux, to avoid copying credentials off the Windows machine.

**Node 18** (`node:18-bookworm-slim`, v18.20.8): `helpers.js self-update`, `check-credentials` and `bin/bitbucket-cli.mjs` all load and run from the plugin folder.

**Install route regression** (source repo git checkout, no `bin/`): `helpers.js` falls back to `bitbucket-mcp/dist/index-cli.js`; `check-for-updates` still reports `git-checkout`.

**Release (step 6) pending:** after #7 merges, tag the source repo `v1.3.0`, re-run `scripts/sync-bitbucket-devops.ps1` with no ref (picks up the tag), merge this branch, then `claude plugin tag --push` from `plugins/bitbucket-devops`.
