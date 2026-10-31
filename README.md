# Apra Labs agent marketplace

Claude Code plugins from [Apra Labs](https://apralabs.com): skills, agents, hooks and MCP servers we use in our own engineering work.

## Install

```
/plugin marketplace add Apra-Labs/agent-marketplace
/plugin install <plugin>@apra
```

Update with `/plugin marketplace update apra`. Plugins that need other plugins (for example the apra-fleet MCP) install them automatically.

## Plugins

| Plugin | What it does | Needs |
|---|---|---|
| _none yet_ | | |

## Other agents

Skills follow the open [Agent Skills](https://agentskills.io) format, so the `SKILL.md` folders under `plugins/*/skills/` also work in Gemini CLI, OpenCode and other compatible agents. Copy the skill folder into that agent's skills directory. Plugin dependencies and MCP setup are not automatic outside Claude Code.
