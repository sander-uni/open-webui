#!/usr/bin/env bash
set -euo pipefail
if [ -n "${DEMO_BROWSER_BRIDGE:-}" ]; then
  exec python3 "$DEMO_BROWSER_BRIDGE" http://127.0.0.1:5195/?record
fi
exec "${CHROMIUM_EXECUTABLE:?}" --app=http://127.0.0.1:5195/?record --window-position=0,0 --window-size=1280,720 \
  --user-data-dir="$DEMO_ACK_DIR/../browser-profile" --test-type --no-first-run --no-sandbox --disable-dev-shm-usage
