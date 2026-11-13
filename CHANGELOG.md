# Changelog

One line per plugin release, newest first.

- rport 0.4.0 - read-only run-history analysis (`scripts history`): joins job details, multi-jobs, the audit log and library edit history into one timeline per run - who, from where, which library script and version, client and OS, privileges, outcome - with anomaly flags (e.g. a POSIX script run under cmd on Windows) and a Markdown report; effects are inferred from script text and output, never by running anything.
- rport 0.3.0 - scripts chapter: browse the server script library and job results; run a library script on one client on request (dry run first, sudo only when asked); no ad-hoc code, no multi-client runs.
- bitbucket 1.0.0 - replaces bitbucket-devops (never tagged). The token can be stored under any secret name (`config set --token-secret`). Zero-dependency script maintained here; REST vs git auth rules verified live; token only in apra-fleet (no credential files); app passwords, unscoped API tokens and OAuth consumers dropped; adds PR review and repos/code. Requires apra-fleet 0.4.4+.
- rport 0.2.0 (fix) - write `{{secret.NAME}}` bare in command templates: apra-fleet substitutes it already quoted, so quoting it again broke the token (notably in PowerShell).
- rport 0.2.0 - first release in this marketplace; source and tests live here (plugins/rport). Apache-2.0. Requires apra-fleet 0.4.4+, checked at runtime.
- bitbucket-devops 1.3.0 - published, never tagged; removed in favour of bitbucket 1.0.0.
