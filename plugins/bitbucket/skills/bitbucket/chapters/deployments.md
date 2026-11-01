# Chapter: deployments

`bb` and `<repo>` as in [pipelines](pipelines.md). `<env>` is a deployment environment's name
(exact, then case-insensitive) or uuid.

Scopes: `read:pipeline:bitbucket` to list environments and variables;
`admin:pipeline:bitbucket` (plus read) to create environments or change variables.

## Read

```
bb deploy envs <repo>
bb deploy vars <repo> <env>            # secured variables are listed without their values
```

## Change (only when the user asks; `--dry-run` first)

```
bb deploy env-create <repo> <name> [--type Test|Staging|Production] [--rank N] --dry-run
bb deploy var-set <repo> <env> <KEY> --value-env <NAME> --dry-run        # secured by default
bb deploy var-set <repo> <env> <KEY> --value <plain value> --secured=false --dry-run
bb deploy var-update <repo> <env> <KEY|uuid> [--new-key K] [--value-env NAME | --value V] [--secured[=false]] --dry-run
bb deploy var-delete <repo> <env> <KEY|uuid> --dry-run
```

**Secret values never appear in commands or chat.** For a secured variable, the user stores the
value as its own apra-fleet secret first (`credential_store_set name=<NAME> ...`, collected out of
band), and you pass it through the environment in the same runner command:
```
MY_VALUE={{secret.<NAME>}} BITBUCKET_TOKEN={{secret.<SECRET>}} node "${CLAUDE_SKILL_DIR}/scripts/bitbucket.mjs" deploy var-set <repo> <env> <KEY> --value-env MY_VALUE
```
(PowerShell: `$env:MY_VALUE={{secret.<NAME>}}; $env:BITBUCKET_TOKEN={{secret.<SECRET>}}; node ...`.)
The script refuses `--value` together with `--secured`, and redacts values from all output.

Deleting a deployment environment is not offered: it removes its deployment history. If the user
really wants it, they do it in the Bitbucket UI.
