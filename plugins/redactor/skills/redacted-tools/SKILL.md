---
name: redacted-tools
description: How to work with tool results that pass through the Apra redaction proxy (apra-redactor-mcp). Use whenever a tool result contains placeholders like [AWS_KEY_REDACTED], [SECRET_REDACTED:rule], [EMAIL_REDACTED] or [CC_REDACTED], when a tool response says "Response withheld", or when the user asks whether their data is being redacted.
---

# Working with redacted tool results

Tools served by the `apra-redactor` MCP server are proxied through
apra-redactor-mcp. Every response is scrubbed of secrets and personal data
before you see it. Placeholders replace what was removed:

| Placeholder | Meaning |
|---|---|
| `[SECRET_REDACTED]`, `[SECRET_REDACTED:<rule>]` | credential found by key name, entropy check, or gitleaks rule `<rule>` |
| `[API_KEY_REDACTED]`, `[AWS_KEY_REDACTED]`, `[GITHUB_TOKEN_REDACTED]`, `[BEARER_REDACTED]`, `[JWT_REDACTED]`, ... | a specific kind of credential |
| `[PASSWORD_REDACTED]`, `[PRIVATE_KEY_REDACTED]` | password or private key |
| `[CC_REDACTED]`, `[SSN_REDACTED]`, `[IBAN_REDACTED]`, `[ACCOUNT_REDACTED]`, `[AMOUNT_REDACTED]` | financial data |
| `[EMAIL_REDACTED]`, `[PHONE_REDACTED]`, `[PERSON_REDACTED]` | personal data (when NER is enabled) |
| `[INTERNAL_IP_REDACTED]` | private network address |

## Rules

1. Treat placeholders as opaque. Never guess, reconstruct or ask the user to paste the original value into the chat; that defeats the redaction.
2. Work around them: "the key in the config file ([AWS_KEY_REDACTED]) should be rotated" is fine.
3. If a result says **"Response withheld"**, the proxy could not redact it safely and forwarded nothing. Tell the user, and suggest they run `apra-redactor-mcp doctor` (or `uvx apra-redactor-mcp doctor`) in a terminal.
4. When both a proxied tool (from `apra-redactor`) and a direct connector offer the same capability, prefer the proxied tool.
5. Redaction can occasionally remove harmless values (for example an order total shown as `[AMOUNT_REDACTED]`). Say so if it affects your answer rather than inventing the value.

## Setup (when the user asks, or `apra-redactor` offers no tools)

The proxy only protects servers it is told about. Walk the user through:

1. Config lives in the user's home folder, never in the plugin: `~/.apra-redactor-mcp/config.yaml` (Windows: `%USERPROFILE%\.apra-redactor-mcp\config.yaml`). The first launch creates it from a template; `apra-redactor-mcp init` (or `uvx apra-redactor-mcp init`) writes it on demand.
2. List each MCP server to protect under `servers:`, with tokens as `${ENV_VARS}`, never pasted into the file or the chat.
3. Remove the direct connectors for those same servers from the MCP client. Only traffic through `apra-redactor` is redacted.
4. Restart the client, then check with `apra-redactor-mcp doctor` (or `uvx apra-redactor-mcp doctor`): it lists the active rules and servers.
