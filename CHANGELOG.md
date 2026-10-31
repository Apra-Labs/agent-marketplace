# Changelog

One line per plugin release, newest first.

- bitbucket 1.0.0 - replaces bitbucket-devops (never tagged). Zero-dependency script maintained here; REST vs git auth rules verified live; token only in apra-fleet (no credential files); app passwords, unscoped API tokens and OAuth consumers dropped; adds PR review and repos/code. Requires apra-fleet 0.4.4+.
- rport 0.2.0 (fix) - write `{{secret.NAME}}` bare in command templates: apra-fleet substitutes it already quoted, so quoting it again broke the token (notably in PowerShell).
- rport 0.2.0 - first release in this marketplace; source and tests live here (plugins/rport). Apache-2.0. Requires apra-fleet 0.4.4+, checked at runtime.
- bitbucket-devops 1.3.0 - published, never tagged; removed in favour of bitbucket 1.0.0.
