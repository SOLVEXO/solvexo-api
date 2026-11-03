#!/usr/bin/env bash
# DEV ONLY smoke test of the running dev stack (after dev/up.sh + `npm run dev:seed`). Exits non-zero on the first failure.
set -euo pipefail
API=${API:-http://localhost:3102}; ORIGIN=${ORIGIN:-http://localhost:5173}
DIR="$(cd "$(dirname "$0")" && pwd)"; SEED="$DIR/.logs/seed.json"; JAR="$(mktemp)"
j() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1"; }
ok() { echo "  ok  $1"; }
EMAIL=$(j "['owner']['email']" <"$SEED"); PW=$(j "['owner']['password']" <"$SEED")
STORE=$(j "['store']['id']" <"$SEED"); REG=$(j "['store']['registerId']" <"$SEED")

curl -fs "$API/health/live" >/dev/null && ok "health"

# 1. owner login, body mode (mobile apps)
R=$(curl -fs -X POST "$API/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"role\":\"seller\"}")
TOKEN=$(echo "$R" | j "['data']['token']['accessToken']"); echo "$R" | j "['data']['token']['refreshToken']" >/dev/null && ok "owner login (body mode, refresh token in body)"

# 2. owner login, cookie mode (portal): csrf -> login -> refresh with cookie
CSRF=$(curl -fs -c "$JAR" -b "$JAR" "$API/api/auth/csrf" -H "Origin: $ORIGIN" | j "['data']['csrfToken']")
R=$(curl -fs -c "$JAR" -b "$JAR" -X POST "$API/api/auth/login" -H "Origin: $ORIGIN" -H "X-CSRF-Token: $CSRF" -H 'X-Auth-Mode: cookie' -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"role\":\"seller\"}")
echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];assert 'refreshToken' not in d['token'] and d['token']['accessToken'] and d.get('csrfToken')" && ok "owner login (cookie mode, no refresh token in body)"
grep -q solvexo_rt "$JAR" && ok "HttpOnly refresh cookie stored"
CSRF2=$(echo "$R" | j "['data']['csrfToken']")
R=$(curl -fs -c "$JAR" -b "$JAR" -X POST "$API/api/auth/refresh" -H "Origin: $ORIGIN" -H "X-CSRF-Token: $CSRF2" -H 'X-Auth-Mode: cookie') && echo "$R" | j "['data']['token']['accessToken']" >/dev/null && ok "refresh via cookie (rotated)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/auth/refresh" -H "Origin: http://evil.example" -H 'X-Auth-Mode: cookie' -b "$JAR"); case "$CODE" in 2??) echo "FAIL: foreign Origin accepted ($CODE)"; exit 1;; *) ok "foreign Origin rejected ($CODE — CORS layer returns 500, CSRF check 403)";; esac

# 3. store + plan
curl -fs "$API/api/store/my-stores" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];assert len(d)>=2" && ok "GET my-stores (2 stores)"
curl -fs "$API/api/pos-plans" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];assert d" && ok "GET pos-plans"
curl -fs "$API/api/pos-subscriptions/$STORE" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];assert d['status']=='active',d" && ok "main store plan is active"

# 4. POS device registration + PIN login (device token)
D=$(curl -fs -X POST "$API/api/pos/devices" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"storeId\":\"$STORE\",\"registerId\":\"$REG\",\"name\":\"Smoke till\",\"platform\":\"ios\"}")
DT=$(echo "$D" | j "['data']['deviceToken']") && ok "POS device registered"
P=$(curl -fs -X POST "$API/api/pos/pin-login" -H "Authorization: Bearer $DT" -H 'Content-Type: application/json' -d "{\"storeId\":\"$STORE\",\"email\":\"$(j "['manager']['email']" <"$SEED")\",\"pin\":\"$(j "['manager']['pin']" <"$SEED")\"}")
ET=$(echo "$P" | j "['data']['employeeToken']") && ok "manager PIN login"
N=$(curl -fs "$API/api/pos/products/$STORE" -H "Authorization: Bearer $DT" -H "x-pos-employee-token: $ET" | python3 -c "import sys,json;d=json.load(sys.stdin);d=d.get('data',d);print(len(d.get('products',d)) if isinstance(d,dict) else len(d))")
[ "$N" -ge 4 ] && ok "POS products list ($N products)" || { echo "FAIL: expected >=4 products, got $N"; exit 1; }
DID=$(echo "$D" | j "['data']['deviceId']")
curl -fs -X POST "$API/api/pos/devices/$STORE/$DID/revoke" -H "Authorization: Bearer $TOKEN" >/dev/null && ok "device revoked (cleanup)"
echo "SMOKE OK"
