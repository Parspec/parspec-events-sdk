#!/usr/bin/env bash
# Rebuild the per-language branches from main. Each branch gets <lang>/, fixtures/, .gitignore,
# and a README.md made of <lang>/README.md + PROTOCOL.md. Commits only when the content changed.
# Uses a private index, so your working tree and checked-out branch are never touched.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

src=main
rev=$(git rev-parse --short "$src")
export GIT_INDEX_FILE
GIT_INDEX_FILE=$(mktemp)
trap 'rm -f "$GIT_INDEX_FILE"' EXIT

for lang in node python csharp java; do
  rm -f "$GIT_INDEX_FILE"
  git read-tree --empty
  git read-tree --prefix="$lang/" "$src:$lang"
  git read-tree --prefix=fixtures/ "$src:fixtures"
  git update-index --add --cacheinfo "100644,$(git rev-parse "$src:.gitignore"),.gitignore"
  readme=$({ git show "$src:$lang/README.md"; echo; git show "$src:PROTOCOL.md"; } | git hash-object -w --stdin)
  git update-index --add --cacheinfo "100644,$readme,README.md"
  tree=$(git write-tree)

  if parent=$(git rev-parse -q --verify "refs/heads/$lang"); then
    if [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then echo "$lang: unchanged"; continue; fi
    commit=$(git commit-tree "$tree" -p "$parent" -m "Build $lang from $src $rev")
  else
    commit=$(git commit-tree "$tree" -m "Build $lang from $src $rev")
  fi
  git update-ref "refs/heads/$lang" "$commit"
  echo "$lang: $(git rev-parse --short "$commit")"
done
