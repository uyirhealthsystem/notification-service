#!/usr/bin/env bash
# Deploy the current working checkout to EC2 without GitHub Actions.
# Usage:  EC2_HOST=1.2.3.4 EC2_USER=ec2-user EC2_SSH_KEY=~/.ssh/id_ed25519 bash deploy/deploy-local.sh
set -euo pipefail

: "${EC2_HOST:?set EC2_HOST}"
: "${EC2_USER:?set EC2_USER}"
SSH_KEY="${EC2_SSH_KEY:-$HOME/.ssh/id_ed25519}"
cd "$(dirname "$0")/.."

echo "==> test + build"
npm ci
npm run typecheck
npm test
npm run build

echo "==> assemble bundle"
rm -rf release && mkdir -p release
cp -r dist prisma package.json package-lock.json release/

echo "==> upload"
rsync -az --delete --mkpath -e "ssh -i $SSH_KEY" \
  release/ "$EC2_USER@$EC2_HOST:/opt/notification-service/releases/next/"

echo "==> activate (migrate, restart + health check, rolls back on failure)"
ssh -i "$SSH_KEY" "$EC2_USER@$EC2_HOST" 'bash -s' < deploy/remote-release.sh
