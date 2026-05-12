#!/usr/bin/env bash
set -euo pipefail

# Wrapper for using Claude Code against DeepSeek's Anthropic-compatible endpoint.
# Point AnyBot at this script with:
#   CLAUDE_CODE_BIN=/Users/erhu/code/web/AnyBot/scripts/claude-deepseek-wrapper.sh

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  if command -v security >/dev/null 2>&1; then
    if ! ANTHROPIC_API_KEY="$(security find-generic-password -a "$USER" -s deepseek-api-key -w 2>/dev/null)"; then
      echo "缺少 DeepSeek API Key。首次配置请运行：" >&2
      echo "security add-generic-password -a \"$USER\" -s deepseek-api-key -w '你的 DeepSeek API Key' -U" >&2
      exit 1
    fi
    export ANTHROPIC_API_KEY
  else
    echo "缺少 ANTHROPIC_API_KEY，且当前系统没有 macOS security 命令。" >&2
    exit 1
  fi
fi

deepseek_model="${DEEPSEEK_CLAUDE_MODEL:-deepseek-v4-pro[1m]}"
deepseek_fast_model="${DEEPSEEK_CLAUDE_FAST_MODEL:-deepseek-v4-flash}"

export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="$deepseek_model"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$deepseek_model"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$deepseek_fast_model"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$deepseek_fast_model"
export CLAUDE_CODE_SUBAGENT_MODEL="$deepseek_fast_model"
export CLAUDE_CODE_EFFORT_LEVEL="${CLAUDE_CODE_EFFORT_LEVEL:-max}"
export DISABLE_LOGIN_COMMAND=1
export DISABLE_LOGOUT_COMMAND=1

exec claude --model "$deepseek_model" "$@"
