# Changelog

One line per plugin release, newest first.

- redactor 0.1.0 (unreleased: waiting for the first PyPI release of apra-redactor-mcp 0.1.0; do not tag before it exists) - first external-source plugin, synced from apra-redactor-mcp by `scripts/sync-redactor.mjs`. Runs the redaction proxy with `uvx --from apra-redactor-mcp==0.1.0`; Docker image as the alternative. Apache-2.0. Needs uv; no apra-fleet.
- bitbucket 1.0.0 - replaces bitbucket-devops (never tagged). The token can be stored under any secret name (`config set --token-secret`). Zero-dependency script maintained here; REST vs git auth rules verified live; token only in apra-fleet (no credential files); app passwords, unscoped API tokens and OAuth consumers dropped; adds PR review and repos/code. Requires apra-fleet 0.4.4+.
- rport 0.2.0 (fix) - write `{{secret.NAME}}` bare in command templates: apra-fleet substitutes it already quoted, so quoting it again broke the token (notably in PowerShell).
- rport 0.2.0 - first release in this marketplace; source and tests live here (plugins/rport). Apache-2.0. Requires apra-fleet 0.4.4+, checked at runtime.
- bitbucket-devops 1.3.0 - published, never tagged; removed in favour of bitbucket 1.0.0.
