# Roadmap

Order matters: each step proves something the next one relies on.

1. **bitbucket-devops** (task 001) — done, then replaced by **bitbucket**: proved packaging, paths and Windows install; its successor is written here as a zero-dependency script whose main job is getting REST and git auth right, with the token in apra-fleet.
2. **rport** — done. First plugin whose source lives here, and first that needs apra-fleet: states the minimum version and checks it at runtime (CLAUDE.md rule 4). apra-fleet itself is not delivered from this marketplace; `apra-fleet install` stays its installer.
3. **Inventory and consolidate the rest.** For each scattered skill: is it public-safe (no client/site names, hosts, credentials), does it need apra-fleet (which version), which other skills does it call. Public-safe ones move into `plugins/<name>/` with their tests; skills always used together share a plugin. Client- or site-specific ones need a separate private marketplace.
4. **Bundle plugin** (e.g. `apra-dev-standard`): only a `dependencies` list. One install for a new developer; push it org-wide via `enabledPlugins` in managed settings.
5. **Automate checks:** CI on this repo runs `npm test` and `claude plugin validate` for every changed plugin, and checks that fleet-dependent plugins carry the version gate.
