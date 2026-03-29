#!/usr/bin/env bash
# Free ports used by scripts/e2e-with-relay.mjs (orbitdb-relay-pinner + Vite) and typical Svelte/Vite dev.
set -euo pipefail

RELAY_AND_VITE_PORTS="3001 4101 4102 4103 4106 5173 4173 5174 5175 5176"

pids=""
for p in $RELAY_AND_VITE_PORTS; do
  for pid in $(lsof -ti tcp:"$p" -sTCP:LISTEN 2>/dev/null || true); do
    pids="$pids $pid"
  done
done

uniq_pids=$(echo "$pids" | tr ' ' '\n' | sort -u | grep -v '^$' || true)

if [[ -z "$uniq_pids" ]]; then
  echo "No listeners on: $RELAY_AND_VITE_PORTS"
  exit 0
fi

echo "Sending SIGKILL to PIDs: $uniq_pids"
echo "$uniq_pids" | xargs kill -9 2>/dev/null || true
sleep 0.2

left=0
for p in $RELAY_AND_VITE_PORTS; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | grep -q .; then
    echo "Still bound: $p"
    lsof -nP -iTCP:"$p" -sTCP:LISTEN
    left=1
  fi
done

if [[ "$left" -eq 0 ]]; then
  echo "All listed ports are free."
fi
