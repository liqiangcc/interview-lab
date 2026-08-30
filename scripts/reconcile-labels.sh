#!/usr/bin/env bash
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "需要安装 gh CLI" >&2
  exit 2
fi

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "必须提供 GH_TOKEN" >&2
  exit 2
fi

node <<'NODE' | while IFS=$'\t' read -r dimension label; do
const config = require('../config/issue-labels.json');
for (const [dimension, labels] of Object.entries(config.dimensions)) {
  for (const label of labels) process.stdout.write(`${dimension}\t${label}\n`);
}
NODE
  case "$dimension" in
    type) color="8250df"; description="领域对象类型" ;;
    source) color="57606a"; description="来源系统" ;;
    status) color="0969da"; description="生命周期状态投影" ;;
    quality) color="cf222e"; description="来源/数据质量信号" ;;
    task) color="bf8700"; description="下一步工作类型" ;;
    priority) color="fb8f44"; description="工作调度优先级" ;;
    *) color="d0d7de"; description="Interview Lab 管理的 Label" ;;
  esac
  gh label create "$label" --repo "$GITHUB_REPOSITORY" --color "$color" --description "$description" --force
  echo "已同步 $label"
done
