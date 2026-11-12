#!/usr/bin/env bash
# Deploys solvexo-api on the VPS: update the code, build, restart under pm2, then check the API answers.
# Used by .github/workflows/deploy.yml and staging.yml (over SSH or on the self-hosted runner), and by hand:
#   bash scripts/deploy.sh main solvexo-api-staging
# Stops at the first failing step, so a broken build never restarts the running API.
set -euo pipefail

BRANCH="${1:-main}"
PM2_NAME="${2:-solvexo-api-staging}"
APP_DIR="${APP_DIR:-/home/deploy/apps/solvexo-api}"

cd "$APP_DIR"
echo "==> Deploying $BRANCH to $APP_DIR (pm2: $PM2_NAME)"

git fetch --prune origin "$BRANCH"
if [ "$(git rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]; then
  git checkout "$BRANCH"
fi
if [ "${RESET_HARD:-0}" = "1" ]; then
  # Staging can be force-pushed: match the branch exactly (as the staging workflow always has).
  git reset --hard "origin/$BRANCH"
else
  # Fast-forward only: if someone edited files on the server, stop instead of silently overwriting them.
  git merge --ff-only "origin/$BRANCH"
fi
echo "==> At $(git log -1 --format='%h %s')"

npm ci --no-audit --no-fund
npm run build

# --update-env so new or changed .env values are picked up on restart.
if pm2 describe "$PM2_NAME" > /dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env
else
  pm2 start dist/main.js --name "$PM2_NAME"
fi
pm2 save

PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d "\"' \r" || true)"
PORT="${PORT:-3002}"
echo "==> Waiting for http://127.0.0.1:$PORT/health/live"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health/live" > /dev/null 2>&1; then
    echo "==> solvexo-api is up ($BRANCH, $(git log -1 --format=%h))"
    exit 0
  fi
  sleep 2
done
echo "!! solvexo-api did not answer on port $PORT within 60s. Recent logs:" >&2
pm2 logs "$PM2_NAME" --lines 50 --nostream >&2 || true
exit 1
