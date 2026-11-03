#!/usr/bin/env bash
# DEV ONLY. Stops the isolated dev stack started by up.sh (only the processes whose pid files live in dev/.run).
# `down.sh --wipe` also deletes dev/.data (the dev database) so the next up + seed starts from scratch.
DIR="$(cd "$(dirname "$0")" && pwd)"; RUN="$DIR/.run"
for n in api redis mongod; do
  if [ -f "$RUN/$n.pid" ]; then kill "$(cat "$RUN/$n.pid")" 2>/dev/null || true; rm -f "$RUN/$n.pid"; fi
done
[ "${1:-}" = "--wipe" ] && rm -rf "$DIR/.data" && echo "dev data wiped"
echo "dev stack stopped"
