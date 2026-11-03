#!/usr/bin/env bash
# DEV ONLY. Starts an isolated local stack (no Docker needed): mongod (replica set) on :27118, redis on :6479, API on :3102.
# Never touches your normal mongod/redis, their data, or the real .env.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$DIR")"
DATA="$DIR/.data"; LOGS="$DIR/.logs"; RUN="$DIR/.run"
mkdir -p "$DATA/mongo" "$DATA/redis" "$LOGS" "$RUN/cwd"   # RUN/cwd has no .env, so ConfigModule cannot pick up the real one
set -a; . "$DIR/.env.dev"; set +a
MONGO_PORT=27118; REDIS_PORT=6479
export DEV_MAIL_LOG_FILE="$LOGS/mail.log"

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

if ! alive "$RUN/mongod.pid"; then
  nohup mongod --replSet rsdev --port $MONGO_PORT --bind_ip 127.0.0.1 --dbpath "$DATA/mongo" </dev/null >"$LOGS/mongod.log" 2>&1 &
  echo $! >"$RUN/mongod.pid"
fi
for i in $(seq 1 30); do mongosh --quiet --port $MONGO_PORT --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break; sleep 1; done
mongosh --quiet --port $MONGO_PORT --eval 'try{rs.status().ok}catch(e){rs.initiate({_id:"rsdev",members:[{_id:0,host:"127.0.0.1:'$MONGO_PORT'"}]})}' >/dev/null
for i in $(seq 1 30); do [ "$(mongosh --quiet --port $MONGO_PORT --eval 'db.hello().isWritablePrimary')" = "true" ] && break; sleep 1; done

if ! alive "$RUN/redis.pid"; then
  redis-server --port $REDIS_PORT --bind 127.0.0.1 --dir "$DATA/redis" --dbfilename dev.rdb --save "" --appendonly no \
    --daemonize yes --pidfile "$RUN/redis.pid" --logfile "$LOGS/redis.log" </dev/null >/dev/null 2>&1
fi

if ! alive "$RUN/api.pid"; then
  [ -f "$ROOT/dist/main.js" ] && [ -z "${DEV_REBUILD:-}" ] || (cd "$ROOT" && npm run build >"$LOGS/build.log" 2>&1)
  # cwd = dev/.run/cwd (empty): the API must not read the real .env
  (cd "$RUN/cwd"; nohup node "$ROOT/dist/main.js" </dev/null >"$LOGS/api.log" 2>&1 & echo $! >"$RUN/api.pid")
fi
for i in $(seq 1 90); do curl -fs "http://127.0.0.1:$PORT/health/live" >/dev/null 2>&1 && break; sleep 1; done
curl -fs "http://127.0.0.1:$PORT/health/live" >/dev/null || { echo "API did not become healthy — see $LOGS/api.log" >&2; exit 1; }
echo "Stack up: mongo :$MONGO_PORT (rs rsdev, db solvexo_dev)  redis :$REDIS_PORT  api http://localhost:$PORT"
echo "Mail/OTP log: $LOGS/mail.log   API log: $LOGS/api.log   (npm run dev:stack:down to stop)"
