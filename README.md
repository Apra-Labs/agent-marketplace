# Apra Labs agent marketplace

Claude Code plugins from [Apra Labs](https://apralabs.com): skills, agents, hooks and MCP servers we use in our own engineering work.

## Install

```
/plugin marketplace add Apra-Labs/agent-marketplace
/plugin install <plugin>@apra
```

Update with `/plugin marketplace update apra`.

Some plugins need [apra-fleet](https://github.com/Apra-Labs/apra-fleet) (see **Needs** below). It is not installed from here: install it with its own installer ([instructions](https://github.com/Apra-Labs/apra-fleet/blob/main/docs/install.md)), which also brings fleet's own skills (`/fleet`, `/pm`, ...). Those plugins check the apra-fleet version when they run and tell you if it is missing or too old.

## Plugins

| Plugin | What it does | Needs |
|---|---|---|
| [bitbucket](plugins/bitbucket) | Bitbucket Cloud done right: REST and git authentication (API tokens with scopes, access tokens), repos and code, pull requests and reviews, pipelines and logs, deployments. The token never reaches the agent. | apra-fleet 0.4.4+ (MCP, with a local member), Node.js 18+, a Bitbucket API token with scopes or an access token |
| [rport](plugins/rport) | Safe RPort (rportd/openrport) work: stored tunnels, revive, expiry bookkeeping, repointing apra-fleet members when a port changes. The API token never reaches the agent. | apra-fleet 0.4.4+ (MCP, with a local member), Node.js 18+ |

## Other agents

Skills follow the open [Agent Skills](https://agentskills.io) format, so the `SKILL.md` folders under `plugins/*/skills/` also work in Gemini CLI, OpenCode and other compatible agents. Copy the skill folder into that agent's skills directory. Plugin dependencies are not automatic outside Claude Code.

## Contributing

Each plugin's source lives in its folder here (tests in `plugins/<name>/tests/`; run `npm test` from the root). A plugin gets its own source repo only for a concrete reason (see CLAUDE.md rule 1); none does today. See [CLAUDE.md](CLAUDE.md) for the rules.
