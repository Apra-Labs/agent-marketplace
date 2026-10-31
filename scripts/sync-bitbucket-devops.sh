#!/usr/bin/env bash
# Pull the built bitbucket-devops plugin in from its source repo.
#
#   scripts/sync-bitbucket-devops.sh [ref]
#
# Clones Apra-Labs/bitbucket-devops-skill at <ref> (tag, branch; default: the
# latest v* release tag) with submodules, runs `npm ci && npm run build:plugin`,
# and replaces plugins/bitbucket-devops/ with the result (dist-plugin/).
# Needs git, node and npm. On Windows run it from Git Bash, or use the .ps1.
set -euo pipefail

REPO_URL="${BITBUCKET_DEVOPS_REPO_URL:-https://github.com/Apra-Labs/bitbucket-devops-skill.git}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/plugins/bitbucket-devops"
REF="${1:-}"

if [ -z "$REF" ]; then
  REF="$(git ls-remote --tags --refs --sort=-v:refname "$REPO_URL" 'v*' | head -n1 | sed 's#.*refs/tags/##')"
  if [ -z "$REF" ]; then
    echo "sync: no v* release tag in $REPO_URL - pass a ref explicitly" >&2
    exit 1
  fi
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "sync: building bitbucket-devops from $REPO_URL @ $REF"
git clone --quiet --depth 1 --branch "$REF" --recurse-submodules --shallow-submodules "$REPO_URL" "$WORK/src"
COMMIT="$(git -C "$WORK/src" rev-parse HEAD)"

(cd "$WORK/src" && npm ci --no-audit --no-fund && npm run build:plugin)

if [ ! -f "$WORK/src/dist-plugin/.claude-plugin/plugin.json" ]; then
  echo "sync: build produced no dist-plugin/.claude-plugin/plugin.json" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$WORK/src/dist-plugin" "$DEST"

# Via stdin: Windows node cannot open Git Bash /c/... paths.
VERSION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).version)' < "$DEST/.claude-plugin/plugin.json")"
echo "sync: plugins/bitbucket-devops <- $REF ($COMMIT), version $VERSION"
echo "sync: set the same version in .claude-plugin/marketplace.json and add a CHANGELOG line"
