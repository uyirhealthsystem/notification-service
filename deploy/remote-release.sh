#!/usr/bin/env bash
# Runs ON the EC2 host (piped in over SSH by the GitHub Actions deploy job).
# Promotes the freshly-uploaded release in /opt/notification-service/releases/next,
# applies database migrations, restarts the service, and rolls back to the
# previous release if it doesn't come up healthy (consumer joined the Kafka
# group) in time. Migrations are NOT rolled back - keep them additive, so the
# previous release still runs against the new schema.
set -euo pipefail

SVC=notification-service
ROOT=/opt/$SVC
ENV_FILE="$ROOT/shared/$SVC.env"
KEEP=5

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE - run deploy/setup-ec2.sh first"; exit 1; }
[ -d "$ROOT/releases/next" ] || { echo "no uploaded release at $ROOT/releases/next"; exit 1; }

PORT=$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d '"' || true)
PORT=${PORT:-4100}
PREVIOUS=$(readlink -f "$ROOT/current" 2>/dev/null || true)

TS=$(date +%Y%m%d%H%M%S)
REL="$ROOT/releases/$TS"
mv "$ROOT/releases/next" "$REL"
cd "$REL"

# DATABASE_URL for the migrate step below.
set -a; . "$ENV_FILE"; set +a
export NODE_ENV=production

echo "==> installing production dependencies"
npm ci --omit=dev --no-audit --no-fund

echo "==> applying database migrations"
npx prisma migrate deploy

echo "==> switching 'current' symlink -> $TS"
ln -sfn "$REL" "$ROOT/current"

echo "==> restarting service"
sudo systemctl restart "$SVC"

# /health is 200 only once the Kafka consumer has joined its group, so this
# also proves the brokers / credentials in the env file work. ~60s budget.
echo "==> waiting for health"
healthy=false
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then healthy=true; break; fi
  sleep 2
done

if [ "$healthy" != true ]; then
  echo "!! $TS did not become healthy:"
  curl -sS "http://127.0.0.1:$PORT/health" || true; echo
  sudo systemctl status "$SVC" --no-pager -l | tail -n 30 || true
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ] && [ "$PREVIOUS" != "$REL" ]; then
    echo "==> rolling back to $(basename "$PREVIOUS")"
    ln -sfn "$PREVIOUS" "$ROOT/current"
    sudo systemctl restart "$SVC"
  fi
  exit 1
fi

echo "==> pruning old releases (keeping last $KEEP)"
ls -1dt "$ROOT"/releases/*/ | tail -n +$((KEEP + 1)) | xargs -r rm -rf

echo "==> deployed $TS"
curl -fsS "http://127.0.0.1:$PORT/health"; echo
