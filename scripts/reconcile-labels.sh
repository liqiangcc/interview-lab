#!/usr/bin/env bash
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required" >&2
  exit 2
fi

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN is required" >&2
  exit 2
fi

node <<'NODE' | while IFS=$'\t' read -r dimension label; do
const config = require('./config/issue-labels.json');
for (const [dimension, labels] of Object.entries(config.dimensions)) {
  for (const label of labels) process.stdout.write(`${dimension}\t${label}\n`);
}
NODE
  case "$dimension" in
    type) color="8250df"; description="Domain object type" ;;
    source) color="57606a"; description="Source system" ;;
    status) color="0969da"; description="Lifecycle projection" ;;
    quality) color="cf222e"; description="Source/data quality signal" ;;
    task) color="bf8700"; description="Actionable work dimension" ;;
    priority) color="fb8f44"; description="Work priority" ;;
    *) color="d0d7de"; description="Interview Lab managed label" ;;
  esac
  gh label create "$label" --repo "$GITHUB_REPOSITORY" --color "$color" --description "$description" --force
  echo "reconciled $label"
done
