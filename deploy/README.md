# Deploying to a small VPS

Written for AWS Lightsail (Ubuntu 24.04, the 1 GB plan); the 512 MB plan also
works thanks to the swap file. Any Ubuntu or Debian server with Docker works the
same way.

The result: Caddy on ports 80 and 443 with an automatic HTTPS certificate, the
app and (optionally) Piper behind it on a private Docker network, a swap file as
headroom for image builds, and a nightly database backup.

## 1. Before you start

- **Static IP.** In Lightsail: Networking → Create static IP → attach it to the
  instance. Without it the public IP changes when the instance stops.
- **Firewall.** Instance → Networking → IPv4 firewall: allow **SSH (22)**,
  **HTTP (80)** and **HTTPS (443)**. Nothing else; port 3000 stays closed.
- **DNS.** An **A record** for your subdomain (e.g. `dono.example.com`)
  pointing at the static IP. On Cloudflare, set it to **DNS only** (grey cloud)
  until Caddy has its certificate; you can turn the proxy on afterwards.
- **Lightsail snapshots.** Instance → Snapshots → enable automatic snapshots.
  The nightly backup below lives on the same disk; snapshots protect against
  losing the whole instance.
- **A spending alert.** AWS has no hard spending cap, and traffic beyond the
  plan's monthly allowance is billed per GB. In the AWS console: Billing and
  Cost Management → Budgets → Create budget → "Zero spend budget" or a monthly
  cost budget (e.g. $10), with your email. Promotional credits can hide spend,
  so prefer a budget on **unblended cost before credits** if the console offers
  it. Lightsail's own console also shows data transfer used this month.

## 2. Prepare the server

SSH in (`ssh -i <key.pem> ubuntu@<static-ip>`), then:

```bash
# Swap: headroom for image builds and Piper; essential on the 512 MB plan.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf && sudo sysctl --system

# Docker Engine and Compose from Docker's own apt repository.
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker ubuntu   # then log out and back in

# Security updates install themselves.
sudo apt-get install -y unattended-upgrades
```

## 3. Get the code onto the server

Either clone it (`git clone <repository> crypto-dono`) or copy it from your
machine. Then:

```bash
cd ~/crypto-dono
cp .env.example .env
chmod 600 .env
nano .env
```

Fill in the settings from the main README, and add these production lines:

```
PUBLIC_BASE_URL=https://dono.example.com
DOMAIN=dono.example.com
COMPOSE_FILE=docker-compose.yml:deploy/compose.production.yml
COMPOSE_PATH_SEPARATOR=:
COMPOSE_PROFILES=tts
TTS_URL=http://piper:5000
```

Leave `PORT` empty: Caddy expects the app on 3000. Drop `COMPOSE_PROFILES` and
`TTS_URL` if you do not want text-to-speech.

## 4. Start it

```bash
docker compose up -d --build
docker compose logs -f
```

The first build takes a few minutes on a small instance, and Piper downloads its
voice on first start. Then open `https://dono.example.com`: Caddy fetches the
certificate on the first request.

## 5. Nightly backup

```bash
mkdir -p ~/backups
crontab -e
```

Add:

```
15 4 * * * cd /home/ubuntu/crypto-dono && sh deploy/backup.sh >> /home/ubuntu/backups/backup.log 2>&1
```

Run `sh deploy/backup.sh` once by hand to check it. Backups older than 14 days
are deleted.

## 6. Point everything at the new address

- **NOWPayments** takes the webhook address from each invoice, which comes from
  `PUBLIC_BASE_URL`, so nothing changes in their dashboard.
- **OBS**: Browser Source URL `https://dono.example.com/overlay/<OVERLAY_TOKEN>`.
- Send a test alert from `https://dono.example.com/overlay/<OVERLAY_TOKEN>/test`.

## Updating

```bash
cd ~/crypto-dono
git pull                # or copy the new code over
docker compose up -d --build
```

Database migrations run automatically on start. Take a backup first
(`sh deploy/backup.sh`) when an update mentions a migration.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser cannot connect | Lightsail firewall has 80 and 443 open; DNS points at the static IP (`dig +short dono.example.com`) |
| Certificate errors | `docker compose logs caddy`. With Cloudflare, the record must be DNS only (grey) while the first certificate is issued |
| Service exits on start | `docker compose logs crypto-dono` lists every invalid `.env` setting |
| Everything is slow | `free -h`: swap should exist; if it is always full, move to the 1 GB plan |
