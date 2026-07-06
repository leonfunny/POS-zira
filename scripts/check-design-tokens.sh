#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALLOWLIST_FILE="scripts/design-token-allowlist.txt"

cd "$ROOT_DIR"

is_allowed() {
  local file="$1"
  local content="$2"
  local entry path pattern

  [[ -f "$ALLOWLIST_FILE" ]] || return 1

  while IFS= read -r entry || [[ -n "$entry" ]]; do
    entry="${entry%$'\r'}"
    [[ -z "$entry" || "$entry" =~ ^[[:space:]]*# ]] && continue
    [[ "$entry" == *:* ]] || continue

    path="${entry%%:*}"
    pattern="${entry#*:}"

    [[ "$file" == "$path" ]] || continue
    [[ "$content" =~ $pattern ]] && return 0
  done < "$ALLOWLIST_FILE"

  return 1
}

declare -a CHECKS=(
  "gray utility:(bg-gray-|text-gray-|border-gray-)"
  "green utility:(bg-green-|text-green-)"
  "dark variant:dark:"
  "purple utility:purple-"
  "tiny text token:text-\[(9|10)px\]"
  "native confirm:window\.confirm\("
  "native alert:(^|[^a-zA-Z.])alert\("
  # Action-primary ban: use brand/semantic action tokens instead; allow-list only justified info uses.
  "blue primary:bg-blue-600"
)

declare -a OFFENSES=()

for check in "${CHECKS[@]}"; do
  label="${check%%:*}"
  regex="${check#*:}"

  mapfile -t hits < <(rg -n --no-heading --color never -g '*.tsx' -g '*.ts' -e "$regex" src/renderer || true)

  for hit in "${hits[@]}"; do
    file="${hit%%:*}"
    file="${file//\\//}"
    rest="${hit#*:}"
    line="${rest%%:*}"
    content="${rest#*:}"

    if ! is_allowed "$file" "$content"; then
      OFFENSES+=("$label: $file:$line:$content")
    fi
  done
done

if (( ${#OFFENSES[@]} > 0 )); then
  echo "Design token guard failed. Offending matches:"
  printf '  %s\n' "${OFFENSES[@]}"
  echo
  echo "Fix the token or add a justified exact exception to $ALLOWLIST_FILE."
  exit 1
fi

echo "Design token guard passed."
