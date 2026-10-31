# Roadmap

Order matters: each step proves something the next one relies on.

1. **bitbucket-devops** (task 001) — no dependencies. Proves packaging, paths, bundled code, Windows install, tagging.
2. **apra-fleet base plugin** — lives in the apra-fleet repo (it already has `skills/fleet` and `plugins/claude-code/fleet-status`). Give it a root `.claude-plugin/plugin.json` whose MCP config starts the fleet server, so installing the plugin registers the MCP. List it here with a `github` source; tags `apra-fleet--v<version>` go on the apra-fleet repo. Decide whether fleet-status merges into it or stays a separate plugin that depends on it.
3. **First plugin that depends on apra-fleet** — declares `"dependencies": [{ "name": "apra-fleet", "version": "^<major>.<minor>" }]`. Proves that installing it pulls in apra-fleet and the MCP.
4. **Inventory and migrate the rest.** For each scattered skill: does it assume the fleet MCP, which other skills does it call, is it public-safe. Skills always used together share a plugin; shared ones get their own plugin and are depended on.
5. **Bundle plugin** (e.g. `apra-dev-standard`): only a `dependencies` list. One install for a new developer; push it org-wide via `enabledPlugins` in managed settings.
6. **Automate sync** once there are two or three plugins with source repos: a GitHub Action per source repo that runs the build and opens a PR here.
