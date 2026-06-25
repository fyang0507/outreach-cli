#!/usr/bin/env bash
#
# discord-triage.sh — the scheduler "if-statement" for the async intake flow.
#
# Checks whether new messages have arrived in a Discord channel since the last
# digested cursor, using `outreach discord history --count` (no message bodies).
#
#   exit 0  → new intake present; launch the async digest job
#   exit 1  → nothing new; no-op
#   exit 2  → error reading the channel
#
# It deliberately does NOT advance the cursor. The digest job owns that: after
# it finishes processing (attachments downloaded and all), it writes the run's
# newest_id into CURSOR_FILE so the next triage only sees genuinely new messages.
# This keeps the CLI stateless and makes the digest idempotent-friendly.
# See ../discord.md for the full consumer contract.
#
# Usage:
#   discord-triage.sh <channel> <cursor-file>
#
# Env:
#   OUTREACH_BIN   command used to invoke the CLI (default: "outreach").
#                  May be multi-word for dev, e.g. OUTREACH_BIN="node dist/cli.js".
#
# Example (cron / launchd):
#   if discord-triage.sh capture-this ~/.local/state/outreach/capture-cursor; then
#       claude -p "$(cat digest-this-channel.md)"
#   fi

set -euo pipefail

CHANNEL="${1:?usage: discord-triage.sh <channel> <cursor-file>}"
CURSOR_FILE="${2:?usage: discord-triage.sh <channel> <cursor-file>}"

read -ra BIN <<<"${OUTREACH_BIN:-outreach}"

after_args=()
if [[ -s "$CURSOR_FILE" ]]; then
  cursor="$(tr -d '[:space:]' <"$CURSOR_FILE")"
  [[ -n "$cursor" ]] && after_args=(--after "$cursor")
fi

# --count omits message bodies; --limit 1 is all triage needs to answer "any new?".
if ! json="$("${BIN[@]}" discord history --channel "$CHANNEL" --count --limit 1 "${after_args[@]}")"; then
  echo "discord-triage: failed to read channel '$CHANNEL'" >&2
  exit 2
fi

count="$(printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).count)))')"

if [[ "${count:-0}" -gt 0 ]]; then
  echo "discord-triage: $count new in '$CHANNEL'" >&2
  exit 0
fi
exit 1
