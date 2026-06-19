#!/usr/bin/env bash
# scripts/autopilot/run-autopilot.sh
# Launch Aegis (real core, dev build) and run the in-app autopilot autonomously
# on a DISPOSABLE profile, then print the report. Linux only (uses spectacle).
set -euo pipefail
cd "$(dirname "$0")/../.."

TS="$(date +%Y%m%d-%H%M%S)"
OUT="$(pwd)/target/autopilot/$TS"
PROFILE="$(mktemp -d /tmp/aegis-autopilot-profile.XXXXXX)"
FIXTURE_PORT=8137
mkdir -p "$OUT"

if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  HAS_DISPLAY=1
else
  HAS_DISPLAY=
  echo "WARN: no DISPLAY/WAYLAND_DISPLAY — screenshots will be skipped (functional tour still runs)."
fi

echo "==> output:  $OUT"
echo "==> profile: $PROFILE (disposable)"

cleanup() {
  [ -n "${APP_PID:-}" ] && kill -- -"$APP_PID" 2>/dev/null || true
  [ -n "${FIX_PID:-}" ] && kill "$FIX_PID" 2>/dev/null || true
  rm -rf "$PROFILE"
}
trap cleanup EXIT

# 1) fixture server
node scripts/autopilot/fixture-server.mjs "$FIXTURE_PORT" & FIX_PID=$!

# wait for fixture server to be ready
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -sf "http://127.0.0.1:$FIXTURE_PORT/" >/dev/null 2>&1 && break
  sleep 0.3
done

# 2) launch the app on the disposable profile with autopilot enabled
XDG_DATA_HOME="$PROFILE/data" \
XDG_CONFIG_HOME="$PROFILE/config" \
AEGIS_AUTOPILOT_OUT="$OUT" \
VITE_AEGIS_AUTOPILOT=1 \
VITE_AEGIS_AUTOPILOT_FIXTURE="http://127.0.0.1:$FIXTURE_PORT/" \
VITE_AEGIS_AUTOPILOT_DISPLAY="$HAS_DISPLAY" \
  setsid npm run tauri:dev > "$OUT/app.log" 2>&1 & APP_PID=$!

# 3) wait for the report sentinel (watchdog). The FIRST run compiles the Rust core,
# and a cold `tauri dev` build can take 10-20 min, so the default is generous;
# override with AEGIS_AUTOPILOT_TIMEOUT=<seconds>.
TIMEOUT="${AEGIS_AUTOPILOT_TIMEOUT:-1800}"
echo "==> waiting for autopilot to finish (max ${TIMEOUT}s; the first run compiles the Rust core)..."
for ((i = 0; i < TIMEOUT; i++)); do
  [ -f "$OUT/done.sentinel" ] && break
  if ! kill -0 "$APP_PID" 2>/dev/null; then echo "ERROR: app exited early — see $OUT/app.log"; exit 2; fi
  sleep 1
done

if [ ! -f "$OUT/done.sentinel" ]; then echo "ERROR: timed out waiting for report — see $OUT/app.log"; exit 3; fi

# 4) summarize
node -e '
  const r = require(process.argv[1] + "/report.json");
  const s = r.summary;
  console.log(`\n==> RESULT: ${s.pass} passed, ${s.fail} failed, ${s.skip} skipped`);
  for (const x of r.results.filter(x => x.status === "fail")) console.log(`   FAIL ${x.title}: ${x.detail || ""}`);
  console.log(`\n==> gallery: ${process.argv[1]}/report.html`);
  process.exit(s.fail > 0 ? 1 : 0);
' "$OUT"
