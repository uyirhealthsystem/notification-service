#!/usr/bin/env bash
# One-time provisioning for a fresh Amazon Linux 2023 EC2 host.
# Run as a sudo-capable user (ec2-user):  bash setup-ec2.sh
set -euo pipefail

NODE_MAJOR=22
ROOT=/opt/notification-service
SVC=notification-service
SVC_USER=notification-service
DEPLOY_USER=${SUDO_USER:-$USER}

echo "==> Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" != "$NODE_MAJOR" ]; then
  # NodeSource rather than AL2023's own nodejsNN packages: those install the
  # binary as node-NN, and the systemd unit runs /usr/bin/node.
  curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | sudo bash -
  sudo dnf install -y nodejs
fi
# rsync receives releases; nc is for the connectivity checks printed below.
command -v rsync >/dev/null || sudo dnf install -y rsync
command -v nc >/dev/null || sudo dnf install -y nmap-ncat

echo "==> service user + directories"
sudo useradd --system --create-home --home-dir "$ROOT" --shell /usr/sbin/nologin "$SVC_USER" 2>/dev/null || true
sudo mkdir -p "$ROOT/releases" "$ROOT/shared"
# The deploy user (GitHub Actions / deploy-local.sh) uploads releases and flips
# the 'current' symlink; the service user only needs to read the tree.
sudo chown -R "$DEPLOY_USER:$SVC_USER" "$ROOT"
sudo chmod -R g+rX "$ROOT"

echo "==> env file"
if [ ! -f "$ROOT/shared/$SVC.env" ]; then
  sudo cp "$(dirname "$0")/$SVC.env.example" "$ROOT/shared/$SVC.env"
  sudo chown "$DEPLOY_USER:$SVC_USER" "$ROOT/shared/$SVC.env"
  sudo chmod 640 "$ROOT/shared/$SVC.env"
  echo "   -> edit $ROOT/shared/$SVC.env before the first deploy"
fi

echo "==> systemd unit"
sudo cp "$(dirname "$0")/$SVC.service" "/etc/systemd/system/$SVC.service"
sudo systemctl daemon-reload
sudo systemctl enable "$SVC"

echo "==> sudoers: let the deploy user restart the service without a password"
echo "$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SVC, /usr/bin/systemctl status $SVC, /bin/systemctl restart $SVC, /bin/systemctl status $SVC" \
  | sudo tee "/etc/sudoers.d/$SVC-deploy" >/dev/null
sudo chmod 440 "/etc/sudoers.d/$SVC-deploy"
sudo visudo -cf "/etc/sudoers.d/$SVC-deploy" >/dev/null

cat <<EOF

Done. Next:
  1. Edit  $ROOT/shared/$SVC.env   (DATABASE_URL, Kafka brokers + SASL, SES SMTP credentials, EMAIL_FROM)
  2. Check this host can reach Postgres:  nc -vz <rds-endpoint> 5432
     and Kafka:  nc -vz <broker-host> <port>
     and SES:  nc -vz email-smtp.<region>.amazonaws.com 587
  3. Add these GitHub repo secrets (Settings > Secrets and variables > Actions),
     on the "production" environment:
       EC2_HOST     = this host's public DNS / IP
       EC2_USER     = $DEPLOY_USER
       EC2_SSH_KEY  = a private key whose public half is in ~$DEPLOY_USER/.ssh/authorized_keys
  4. Push to main - the CI/CD workflow deploys here.
     Or deploy the current checkout manually:  bash deploy/deploy-local.sh
EOF
