# redactor (apra-redactor-mcp)

A redacting proxy for the [Model Context Protocol](https://modelcontextprotocol.io).
It sits between Claude (or any MCP client) and the MCP servers you use (GitHub,
Slack, Jira, databases...) and removes secrets and personal data from
everything those servers send back, **before it reaches the model**.

```
Claude ──► apra-redactor-mcp ──► your MCP servers (stdio or HTTP)
       ◄── redacted          ◄───
```

A tool result like

```
Deploy with key AKIAIOSFODNN7EXAMPLE, db password: hunter2xyz
```

reaches Claude as

```
Deploy with key [AWS_KEY_REDACTED], db [PASSWORD_REDACTED]
```

- **Secrets:** API keys and tokens for major providers, passwords, private keys,
  JWTs, random-looking values under secret-like names, and optionally
  [gitleaks](https://github.com/gitleaks/gitleaks)' ~200 detectors.
- **Personal and financial data:** card numbers, SSN, IBAN and bank accounts,
  amounts, private IPs, Indian IDs; optionally names, phone numbers and emails
  (see [NER](#names-phones-and-emails-ner)).
- **Safe by default:** a response that cannot be redacted safely is withheld,
  never passed through. An audit log records which rules fired, never the values.
- **One policy:** the rules ship with each release. Your config can add rules,
  but not weaken the built-in ones.

All your servers are merged into one MCP server, `apra-redactor`, with each
server's tools prefixed (`github_*`, `jira_*`). Tools, resources, prompts,
completions, notifications, elicitation and sampling are forwarded; everything
flowing back is redacted.

## Needs

- **[uv](https://docs.astral.sh/uv/getting-started/installation/)**. The
  plugin starts the server with `uvx --from apra-redactor-mcp==<version>
  apra-redactor-mcp serve`, which downloads the matching
  [PyPI package](https://pypi.org/project/apra-redactor-mcp/) into uv's cache
  on first use. Nothing else to install, no admin rights.
  - Windows: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
  - macOS / Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- Or **Docker** instead of uv (see [Docker](#docker-instead-of-uv)).

No apra-fleet needed.

## Install

```
/plugin marketplace add Apra-Labs/agent-marketplace
/plugin install redactor@apra
```

Restart Claude Code after installing uv so it sees `uvx` on `PATH`.

## Configure

1. **List the servers to protect** in `~/.apra-redactor-mcp/config.yaml`
   (Windows: `%USERPROFILE%\.apra-redactor-mcp\config.yaml`). The first launch
   creates it from a commented template; `uvx apra-redactor-mcp init` writes
   it on demand. Keep tokens in environment variables:

   ```yaml
   servers:
     github:                              # local server (stdio)
       command: ["npx", "-y", "@modelcontextprotocol/server-github"]
       env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }
     jira:                                # remote server (HTTP)
       url: "https://mcp.example.com/mcp"
       headers: { Authorization: "Bearer ${JIRA_MCP_TOKEN}" }
   ```

   The config lives in your home folder, so plugin updates never touch it.

2. **Remove the direct entries** for those servers from your MCP config
   (`claude mcp remove <name>`, `.mcp.json`, other plugins). Only traffic
   through `apra-redactor` is protected.

3. **Restart Claude Code** and check:

   ```sh
   uvx apra-redactor-mcp doctor                    # active rules, servers, gitleaks, NER
   echo "password: hunter2xyz" | uvx apra-redactor-mcp redact
   uvx apra-redactor-mcp install-gitleaks          # optional: add gitleaks' detectors
   ```

Until a server is listed, `apra-redactor` starts with no tools and tells
Claude where the config file is. The plugin's `redacted-tools` skill teaches
Claude how to treat `[..._REDACTED]` placeholders and withheld responses.

## Docker instead of uv

Public images on GitHub Container Registry, amd64 and arm64, non-root:

| Image | Includes |
|---|---|
| `ghcr.io/apra-labs/apra-redactor-mcp:<version>` | proxy, built-in rules, gitleaks |
| `ghcr.io/apra-labs/apra-redactor-mcp:<version>-ner` | + name, phone and email detection |

Register the container yourself (forward tokens by name with `-e`), then
disable the plugin's own `apra-redactor` server in `/mcp` or uninstall the
plugin:

```sh
claude mcp add apra-redactor -- docker run -i --rm --init \
  -v "$HOME/.apra-redactor-mcp:/home/app/.apra-redactor-mcp" \
  -e GITHUB_TOKEN ghcr.io/apra-labs/apra-redactor-mcp:<version> serve
```

On Windows use `-v "%USERPROFILE%\.apra-redactor-mcp:/home/app/.apra-redactor-mcp"`.
Stdio servers your config starts must exist inside the container, so prefer
remote (HTTP) servers with Docker.

## Names, phones and emails (NER)

Detecting names, phone numbers and emails needs Presidio and a ~600 MB spaCy
model, so the plugin's uvx launch leaves it out. Use the `-ner` Docker image
for it. `doctor` shows whether NER is on.

## If `uvx` is not found

Claude Code starts the server with the `PATH` it was launched with. If `/mcp`
shows `apra-redactor` failed:

- Restart Claude Code (and Claude Desktop) from a fresh terminal after
  installing uv. `uv tool update-shell` adds uv's folder to `PATH` if the
  installer could not.
- Still failing (for example a desktop app that does not see your user
  `PATH`): register the server with the absolute path of `uvx`
  (`where uvx` on Windows, `command -v uvx` elsewhere) and disable the
  plugin's copy in `/mcp`:
  `claude mcp add apra-redactor -- <absolute-path-to-uvx> --from apra-redactor-mcp==<version> apra-redactor-mcp serve`.

## Good to know

- Redaction is pattern- and model-based. It sharply reduces exposure, but it is
  not a guarantee.
- Only data flowing *from* your servers is redacted. What Claude sends *to*
  them (tool arguments) passes through as-is.
- Connectors built into claude.ai (Gmail, Drive, Slack) talk to Claude directly
  and cannot be proxied.
- Logs go to stderr (`APRA_REDACTOR_LOG_LEVEL`); the audit log is
  `~/.apra-redactor-mcp/redaction_audit.jsonl`.

## License

[Apache License 2.0](https://github.com/Apra-Labs/agent-marketplace/blob/main/plugins/redactor/LICENSE).
