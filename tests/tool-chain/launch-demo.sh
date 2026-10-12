#!/usr/bin/env bash
set -euo pipefail
if [ -n "${DEMO_BROWSER_BRIDGE:-}" ]; then
  exec python3 "$DEMO_BROWSER_BRIDGE" http://127.0.0.1:5191/?record
fi
browser_path="${CHROMIUM_EXECUTABLE:-}"
if [ -z "$browser_path" ]; then
  browser_path=$(node -e "console.log(require(process.env.PLAYWRIGHT_MODULE || 'playwright').chromium.executablePath())")
fi
exec "$browser_path" --app=http://127.0.0.1:5191/?record --window-position=0,0 --window-size=1280,720 \
  --user-data-dir="$DEMO_ACK_DIR/../browser-profile" --test-type --no-first-run --no-default-browser-check \
  --disable-dev-shm-usage --no-sandbox
