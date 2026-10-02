#!/bin/sh
# Mirrors the canonical copies in this repo into the submission folder (the parent directory) and
# builds submission.zip next to it. Layout (fixed by the assessment brief):
#   REPO_URL.txt code/ README.md transcripts/ fixtures/ tests/ RUN.md [.env]
# code/ in the zip is `git archive` of HEAD, so untracked files (.env, node_modules) never leak.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
root=$(dirname "$repo")

rm -rf "$root/tests" "$root/fixtures"
cp -R "$repo/tests" "$root/tests"
cp -R "$repo/fixtures" "$root/fixtures"
cp "$repo/README.md" "$root/README.md"
cp "$repo/RUN.md" "$root/RUN.md"
echo "Synced tests/, fixtures/, README.md, RUN.md into $root"

if [ "${1:-}" = "--zip" ]; then
  stage=$(mktemp -d)
  mkdir "$stage/submission"
  for item in REPO_URL.txt README.md RUN.md transcripts fixtures tests .env; do
    [ -e "$root/$item" ] && cp -R "$root/$item" "$stage/submission/"
  done
  mkdir "$stage/submission/code"
  git -C "$repo" archive HEAD | tar -x -C "$stage/submission/code"
  out="$(dirname "$root")/submission.zip"
  rm -f "$out"
  (cd "$stage/submission" && zip -qr "$out" .)
  rm -rf "$stage"
  echo "Built $out"
fi
