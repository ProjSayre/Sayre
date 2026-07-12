#!/bin/bash
# Blocks Write/Edit calls outside ./pipeline/ — used by agents that must be
# read-only with respect to source code (review, security-checker).
# Exit 2 blocks the tool call and returns the message on stderr to Claude.

INPUT=$(cat)

# Both Write and Edit tools use a file_path field for their target.
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  # Can't determine target path — fail closed.
  echo "Blocked: could not determine target file path for this write." >&2
  exit 2
fi

# Normalize and check the path falls under ./pipeline/
case "$FILE_PATH" in
  .pipeline/*|*/.pipeline/*)
    exit 0
    ;;
  *)
    echo "Blocked: this agent is read-only with respect to source code. It may only write files under ./pipeline/. Attempted path: $FILE_PATH" >&2
    exit 2
    ;;
esac
