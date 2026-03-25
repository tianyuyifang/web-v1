# Cloud Deployment Guide

Deploy the music app to the cloud in two phases:

- **Phase 1 (now):** Google Cloud Platform — burn through $300 credit (~2.5 months), use Hong Kong region for China users
- **Phase 2 (after credits expire):** Migrate to a Chinese cloud provider (Alibaba/Tencent) in Hong Kong for better performance and lower cost

Users are primarily in China, so region selection prioritizes low latency to mainland.

---

## Deployment Phases

### Phase 1: Google Cloud (current — $300 credit, expires ~June 2026)

```
China users → GCP asia-east2 (Hong Kong)
                └── Compute Engine VM (e2-small)
                      ├── nginx (reverse proxy, port 80/443)
                      ├── Next.js production build (port 3000)
                      ├── Express.js (port 4000)
                      ├── PostgreSQL (self-managed, port 5432)
                      ├── /var/www/music/allSongs/ (MP3 files)
                      └── /var/www/music/allClips/ (clip files)
```

- Region: `asia-east2` (Hong Kong) — **30-80ms** to mainland China (vs 200-300ms from US)
- Cost: ~$24-42/mo, covered by $300 credit
- Duration: ~2.5 months until credit expires

### Phase 2: Chinese Cloud Provider (after credits expire)

```
China users → Alibaba Cloud / Tencent Cloud (Hong Kong)
                └── Lightweight Server (2C/2G)
                      ├── same stack as Phase 1
                      └── unlimited bandwidth included
```

- Region: Hong Kong (no ICP filing needed)
- Cost: ~$7-8/mo (50-70 RMB/mo) — dramatically cheaper, unlimited bandwidth
- No code changes needed — same Linux VM setup, just a different provider

> **Why not mainland China?** Hosting in mainland China requires an ICP filing (ICP备案), a government registration process that takes 1-3 weeks and requires a Chinese business entity or individual with Chinese ID. Hong Kong is exempt from ICP requirements while still providing 30-50ms latency to mainland.

---

## Cost Breakdown

### Phase 1 Cost: GCP Hong Kong — Detailed Breakdown

| Component                                  | Unit Price                 | Quantity                 | Monthly Cost |
| ------------------------------------------ | -------------------------- | ------------------------ | ------------ |
| **e2-small VM** (2 shared vCPU, 2GB RAM)   | $0.02413/hr                | 730 hrs                  | **$17.61**   |
| **Standard persistent disk** (boot + data) | $0.044/GB/mo               | 80 GB                    | **$3.52**    |
| **Snapshot backups** (weekly, 2 retained)  | $0.029/GB/mo               | ~10 GB used              | **$0.29**    |
| **Static external IP**                     | $0.004/hr (while attached) | 730 hrs                  | **$2.92**    |
| **Egress (50GB)**                          | $0.12/GB (first 1TB)       | 49 GB (1GB free)         | **$5.88**    |
| **Egress (200GB)**                         | $0.12/GB                   | 199 GB                   | **$23.88**   |
|                                            |                            | **Total (50GB egress)**  | **~$24/mo**  |
|                                            |                            | **Total (200GB egress)** | **~$42/mo**  |

> Asia-east2 (Hong Kong) is ~15-20% more expensive than us-central1, but latency to China drops from 200-300ms to 30-80ms.

### $300 Credit Runway (2.5 months until expiry)

| Scenario                      | Monthly Cost | Credit Used in 2.5 Months |
| ----------------------------- | ------------ | ------------------------- |
| Low traffic (50GB egress)     | ~$24         | ~$60 of $300              |
| Medium traffic (100GB egress) | ~$30         | ~$75 of $300              |
| High traffic (200GB egress)   | ~$42         | ~$105 of $300             |

You'll use $60-105 of the $300 credit before it expires. After expiry, migrate to Phase 2 (Chinese cloud) to avoid paying GCP rates.

### Egress Cost Reference

Egress (data sent to users) is the only variable cost. Everything else is fixed.

| Monthly Egress | Egress Cost | Total Monthly |
| -------------- | ----------- | ------------- |
| 10 GB          | $1.08       | ~$25          |
| 50 GB          | $5.88       | ~$30          |
| 100 GB         | $11.88      | ~$36          |
| 200 GB         | $23.88      | ~$48          |

> **Rough math:** 1 user playing 20 clips/day ~ 10-20 MB/day. 10 active users ~ 6-12 GB/month.

---

## Prerequisites

- Google Cloud account with billing enabled ($300 credit)
- Domain name (optional but recommended for HTTPS)
- Your local database and music files ready to transfer

---

## Step-by-Step Deployment

### Step 1: Set Up Google Cloud CLI

Install the gcloud CLI on your Windows PC:

1. Download from https://cloud.google.com/sdk/docs/install
2. Run the installer
3. Open a new terminal and configure:

```bash
gcloud init
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Enable Compute Engine API
gcloud services enable compute.googleapis.com
```

### Step 2: Create the VM

```bash
# Create an e2-small VM with 80GB disk in asia-east2 (Hong Kong — low latency to China)
gcloud compute instances create music-app \
  --zone=asia-east2-a \
  --machine-type=e2-small \
  --boot-disk-size=80GB \
  --boot-disk-type=pd-standard \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --tags=http-server,https-server

# Reserve a static IP (so it doesn't change on reboot)
gcloud compute addresses create music-app-ip \
  --region=asia-east2

# Get the static IP address
gcloud compute addresses describe music-app-ip \
  --region=asia-east2 --format="get(address)"

# Assign it to your VM
gcloud compute instances delete-access-config music-app \
  --zone=asia-east2-a \
  --access-config-name="External NAT"

gcloud compute instances add-access-config music-app \
  --zone=asia-east2-a \
  --address=YOUR_STATIC_IP

# Open firewall for HTTP and HTTPS
gcloud compute firewall-rules create allow-http \
  --allow tcp:80,tcp:443 \
  --target-tags=http-server,https-server
```

### Step 3: SSH Into the VM

```bash
gcloud compute ssh music-app --zone=asia-east2-a
```

All commands from here run **on the VM**.

### Step 4: Install System Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node -v   # should show v20.x
npm -v

# Install PostgreSQL 15
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql

# Install nginx
sudo apt install -y nginx
sudo systemctl enable nginx

# Install PM2 (process manager)
sudo npm install -g pm2

# Install certbot for SSL (if using a domain)
sudo apt install -y certbot python3-certbot-nginx
```

### Step 5: Configure PostgreSQL

```bash
# Set postgres password
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'YOUR_SECURE_DB_PASSWORD';"

# Create the database
sudo -u postgres createdb music_app

# Allow password authentication for local connections
sudo nano /etc/postgresql/14/main/pg_hba.conf
```

Find the line:

```
local   all   all   peer
```

Change `peer` to `md5`:

```
local   all   all   md5
```

```bash
sudo systemctl restart postgresql
```

### Step 6: Transfer Files from Your PC

Run these **from your Windows PC** (not the VM):

```bash
# Export your database
pg_dump -U postgres -d music_app -F c -f music_app_backup.dump

# Upload database dump
gcloud compute scp music_app_backup.dump music-app:~ --zone=asia-east2-a

# Upload music files (this may take a while depending on size)
gcloud compute scp --recurse "C:/Projects/web-v1/music" music-app:~ --zone=asia-east2-a
```

### Step 7: Set Up the App on the VM

SSH back into the VM:

```bash
gcloud compute ssh music-app --zone=asia-east2-a
```

```bash
# Restore the database
pg_restore -U postgres -d music_app --no-owner --no-privileges ~/music_app_backup.dump

# Move music files to a permanent location
sudo mkdir -p /var/www/music
sudo mv ~/music/allSongs /var/www/music/allSongs
sudo mv ~/music/allClips /var/www/music/allClips
sudo chown -R $USER:$USER /var/www/music

# Clone your project (or upload via scp)
# Option A: From GitHub
git clone https://github.com/YOUR_USERNAME/web-v1.git ~/web-v1

# Option B: Upload from PC (run on your Windows PC)
# gcloud compute scp --recurse "C:/Projects/web-v1" music-app:~ --zone=asia-east2-a

# Install backend dependencies
cd ~/web-v1/backend
npm install
npx prisma generate

# Install frontend dependencies and build
cd ~/web-v1/frontend
npm install
npm run build
```

### Step 8: Configure Backend Environment

```bash
cat > ~/web-v1/backend/.env << 'EOF'
PORT=4000
DATABASE_URL=postgresql://postgres:YOUR_SECURE_DB_PASSWORD@localhost:5432/music_app
JWT_SECRET=GENERATE_A_RANDOM_STRING_HERE
JWT_EXPIRES_IN=7d
MP3_BASE_PATH=/var/www/music/allSongs
CLIPS_BASE_PATH=/var/www/music/allClips
FRONTEND_URL=https://yourdomain.com
EOF
```

> Generate a JWT secret: `openssl rand -hex 32`

### Step 9: Configure nginx Reverse Proxy

```bash
sudo nano /etc/nginx/sites-available/music-app
```

Paste this configuration:

```nginx
server {
    listen 80;
    server_name yourdomain.com;    # or use _ for any domain / IP access

    # Security headers
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 1000;

    # Frontend (Next.js production server)
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Backend API — proxied by Next.js rewrites, but also allow direct access
    location /api/ {
        proxy_pass http://localhost:4000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/music-app /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### Step 10: Set Up SSL with Let's Encrypt (if using a domain)

First, point your domain's DNS A record to your VM's static IP. Then:

```bash
sudo certbot --nginx -d yourdomain.com
```

Certbot will automatically modify your nginx config to handle HTTPS and set up auto-renewal.

If you don't have a domain yet, you can access the app via `http://YOUR_VM_IP` temporarily.

### Step 11: Start the App with PM2

```bash
# Start backend
cd ~/web-v1/backend
pm2 start src/server.js --name music-backend

# Start frontend (production mode)
cd ~/web-v1/frontend
pm2 start npm --name music-frontend -- start

# Check both are running
pm2 status

# Save process list (survives reboot)
pm2 save

# Set up auto-start on VM boot
pm2 startup
# Run the command it outputs (starts with sudo env ...)
```

### Step 12: Set Up Automated Backups

Create a backup script:

```bash
cat > ~/backup.sh << 'SCRIPT'
#!/bin/bash
BACKUP_DIR=~/backups
mkdir -p $BACKUP_DIR
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Dump database
pg_dump -U postgres -d music_app -F c -f $BACKUP_DIR/music_app_$TIMESTAMP.dump

# Keep only last 7 backups
ls -t $BACKUP_DIR/music_app_*.dump | tail -n +8 | xargs -r rm

echo "Backup completed: music_app_$TIMESTAMP.dump"
SCRIPT

chmod +x ~/backup.sh
```

Schedule daily backups via cron:

```bash
crontab -e
# Add this line (runs at 3 AM daily):
0 3 * * * /home/$USER/backup.sh >> /home/$USER/backups/backup.log 2>&1
```

### Step 13: Set Up Billing Alerts

In the Google Cloud Console:

1. Go to **Billing** → **Budgets & alerts**
2. Create a budget:
   - Amount: $30/month (or whatever your comfort level is)
   - Alert thresholds: 50%, 90%, 100%
   - Email notifications enabled

### Step 14: Verify Everything

- [ ] Visit `https://yourdomain.com` (or `http://YOUR_VM_IP`) — login page loads
- [ ] Register / login works
- [ ] Audio streaming works — play a clip
- [ ] Playlist creation and editing works
- [ ] Admin panel works (`/admin`)
- [ ] PM2 shows both processes as `online` (`pm2 status`)
- [ ] SSL certificate is valid (if using domain)
- [ ] Backup script runs: `~/backup.sh`

---

## Day-to-Day Operations

### SSH into the VM

```bash
gcloud compute ssh music-app --zone=asia-east2-a
```

### View logs

```bash
pm2 logs                    # all logs
pm2 logs music-backend      # backend only
pm2 logs music-frontend     # frontend only
```

### Restart services

```bash
pm2 restart all             # restart both
pm2 restart music-backend   # backend only
pm2 restart music-frontend  # frontend only
```

### Deploy code updates

```bash
cd ~/web-v1
git pull

# Backend changes
cd backend && npm install && npx prisma generate
pm2 restart music-backend

# Frontend changes (requires rebuild)
cd ../frontend && npm install && npm run build
pm2 restart music-frontend
```

### Add new songs

Upload MP3/LRC files to the VM, then run the import script:

```bash
# From your Windows PC — upload new songs
gcloud compute scp --recurse "C:/Projects/web-v1/music/allSongs/NewSong.mp3" music-app:/var/www/music/allSongs/ --zone=asia-east2-a

# On the VM — run import
cd ~/web-v1/backend
npm run import
```

### Monitor disk usage

```bash
df -h           # overall disk usage
du -sh /var/www/music/    # music folder size
```

### Monitor resource usage

```bash
htop                # CPU and memory (install with: sudo apt install htop)
pm2 monit           # PM2 process monitor
```

---

## Migrating from Home Server

If you're currently running the Cloudflare Tunnel setup from [HOME_SERVER_DEPLOYMENT.md](HOME_SERVER_DEPLOYMENT.md):

### 1. Export database (on your Windows PC)

```bash
pg_dump -U postgres -d music_app -F c -f music_app_backup.dump
```

See [DATABASE_EXPORT_IMPORT.md](DATABASE_EXPORT_IMPORT.md) for full details.

### 2. Upload to VM

```bash
gcloud compute scp music_app_backup.dump music-app:~ --zone=asia-east2-a
gcloud compute scp --recurse "C:/Projects/web-v1/music" music-app:~ --zone=asia-east2-a
```

### 3. Restore on VM

```bash
pg_restore -U postgres -d music_app --no-owner --no-privileges ~/music_app_backup.dump
sudo mv ~/music/allSongs /var/www/music/allSongs
sudo mv ~/music/allClips /var/www/music/allClips
```

### 4. Switch DNS

If using the same domain:

- In your DNS provider, change the record from Cloudflare Tunnel CNAME to an **A record** pointing to your VM's static IP
- Wait for DNS propagation (usually 5-30 minutes)

### 5. Clean up Windows PC

```bash
# Remove Cloudflare Tunnel (optional)
winget uninstall Cloudflare.cloudflared
rm -rf C:/Users/chaol/.cloudflared
```

Your local project folder remains untouched — `npm run dev` still works for development.

---

## Troubleshooting

### App not loading

```bash
# Check if processes are running
pm2 status

# Check nginx config
sudo nginx -t

# Check nginx is running
sudo systemctl status nginx

# Check if ports are listening
sudo ss -tlnp | grep -E '3000|4000|80|443'
```

### Database connection issues

```bash
# Test PostgreSQL
sudo -u postgres psql -d music_app -c "SELECT count(*) FROM songs;"

# Check PostgreSQL is running
sudo systemctl status postgresql
```

### Out of disk space

```bash
df -h
# Clean old backups
ls -la ~/backups/
# Clean npm cache
npm cache clean --force
# Clean old logs
pm2 flush
```

### SSL certificate renewal

Let's Encrypt certificates expire after 90 days. Certbot sets up auto-renewal, but verify:

```bash
sudo certbot renew --dry-run
```

### VM performance issues

If the e2-small feels slow, you can resize without losing data:

```bash
# Stop the VM first
gcloud compute instances stop music-app --zone=asia-east2-a

# Resize to e2-medium (4GB RAM, ~$30/mo)
gcloud compute instances set-machine-type music-app \
  --zone=asia-east2-a \
  --machine-type=e2-medium

# Start it back up
gcloud compute instances start music-app --zone=asia-east2-a
```

---

## Phase 1 Cost Summary (GCP Hong Kong)

Assuming 80GB standard disk, e2-small VM, asia-east2 (Hong Kong):

| Component                | Monthly Cost | Notes                                                  |
| ------------------------ | ------------ | ------------------------------------------------------ |
| e2-small VM              | $17.61       | 2 shared vCPU, 2GB RAM, runs 24/7                      |
| 80GB standard disk       | $3.52        | OS (~10GB) + app (~1GB) + music (~50GB) + room to grow |
| Static external IP       | $2.92        | Fixed IP, won't change on reboot                       |
| Egress (50GB)            | $5.88        | $0.12/GB after 1GB free                                |
| Egress (100GB)           | $11.88       | Scales linearly                                        |
| Egress (200GB)           | $23.88       |                                                        |
| Snapshots (backups)      | ~$0.29       | 10GB used, weekly snapshots                            |
| **Total (50GB egress)**  | **~$24/mo**  |                                                        |
| **Total (100GB egress)** | **~$30/mo**  |                                                        |
| **Total (200GB egress)** | **~$42/mo**  |                                                        |

### $300 Credit (expires ~June 2026)

| Traffic Level         | Monthly Cost | 2.5 Months Cost |
| --------------------- | ------------ | --------------- |
| Light (50GB egress)   | ~$24         | **~$60**        |
| Medium (100GB egress) | ~$30         | **~$75**        |
| Heavy (200GB egress)  | ~$42         | **~$105**       |

After credits expire → migrate to Phase 2.

---

## Phase 2: Chinese Cloud Provider (after GCP credits expire)

### Why Migrate?

| Factor            | GCP Hong Kong | Chinese Cloud HK       | Chinese Cloud Mainland |
| ----------------- | ------------- | ---------------------- | ---------------------- |
| Latency to China  | 30-80ms       | 30-50ms                | 5-20ms                 |
| Monthly cost      | $24-42        | **$7-8**               | **$5-6**               |
| Bandwidth         | $0.12/GB      | **Unlimited included** | **Unlimited included** |
| GFW risk          | Some risk     | No risk                | No risk                |
| ICP filing needed | No            | **No**                 | **Yes**                |

The biggest savings: Chinese cloud lightweight servers include **unlimited bandwidth** — no per-GB egress charges. This eliminates the variable cost that makes GCP expensive.

### Provider Comparison (Hong Kong Region — No ICP Required)

#### Alibaba Cloud (Aliyun) — Recommended

| Component          | Spec                          | Monthly Cost            |
| ------------------ | ----------------------------- | ----------------------- |
| Lightweight Server | 2 vCPU, 2GB RAM, 200Mbps peak | ~25 RMB (~$3.50)        |
| Included disk      | 40GB ESSD                     | included                |
| Extra disk (40GB)  | ESSD PL0                      | ~20 RMB (~$2.80)        |
| Bandwidth          | **Unlimited** (200Mbps peak)  | **included**            |
| **Total**          |                               | **~45 RMB/mo (~$6.30)** |

- Best bandwidth: 200Mbps peak — can handle many concurrent MP3 streams
- Unlimited traffic — no egress surprises
- Largest Chinese cloud ecosystem, most documentation

#### Tencent Cloud

| Component         | Spec                                   | Monthly Cost                                  |
| ----------------- | -------------------------------------- | --------------------------------------------- |
| Lighthouse Server | 2 vCPU, 2GB RAM, 20Mbps peak           | ~24 RMB (~$3.30)                              |
| Included disk     | 40GB SSD                               | included                                      |
| Extra disk (40GB) | SSD                                    | ~25 RMB (~$3.50)                              |
| Bandwidth         | 500GB/mo included, overage ~0.8 RMB/GB | **included** (your usage is well under 500GB) |
| **Total**         |                                        | **~49 RMB/mo (~$6.80)**                       |

- Lower peak bandwidth (20Mbps vs Alibaba's 200Mbps)
- 500GB/mo traffic cap — enough for your 50-200GB usage, but not truly unlimited
- Good alternative if Alibaba pricing changes

#### Huawei Cloud

| Component         | Spec                             | Monthly Cost            |
| ----------------- | -------------------------------- | ----------------------- |
| Flexus X Instance | 2 vCPU, 4GB RAM, 1-5Mbps         | ~33 RMB (~$4.60)        |
| Included disk     | 40GB                             | included                |
| Extra disk (40GB) |                                  | ~25 RMB (~$3.50)        |
| Bandwidth         | Unlimited but low peak (1-5Mbps) | included                |
| **Total**         |                                  | **~58 RMB/mo (~$8.00)** |

- Very low peak bandwidth (1-5Mbps = 125-625 KB/s) — **not ideal for audio streaming**
- More RAM (4GB) but bandwidth is the bottleneck
- Not recommended for this use case

### Phase 2 Recommendation

**Alibaba Cloud Lightweight Server in Hong Kong:**

- ~45 RMB/mo (~$6.30/mo) — **75% cheaper than GCP**
- Unlimited bandwidth at 200Mbps peak
- No ICP filing
- 30-50ms to mainland China

### Mainland China Option (requires ICP filing)

If you later obtain an ICP filing, mainland China hosting drops latency to 5-20ms:

| Provider                           | Mainland Price                     | Notes                                            |
| ---------------------------------- | ---------------------------------- | ------------------------------------------------ |
| Alibaba Cloud (Shanghai/Beijing)   | ~38-68 RMB/year (~$5-9/year) promo | Promotional pricing for new users, renews higher |
| Tencent Cloud (Guangzhou/Shanghai) | ~68-99 RMB/year promo              | Similar promos                                   |

Mainland pricing is extremely cheap with promotions but requires:

1. **ICP filing (ICP备案)** — 1-3 week government registration process
2. Chinese business entity or individual with Chinese ID
3. Domain must be registered with a Chinese registrar or transferred to one

### Migration Checklist (GCP → Chinese Cloud)

The server setup is identical — same Ubuntu VM, same stack. Only the provider changes.

1. **Export from GCP:**

   ```bash
   # SSH into GCP VM
   gcloud compute ssh music-app --zone=asia-east2-a

   # Dump database
   pg_dump -U postgres -d music_app -F c -f ~/music_app_backup.dump

   # Download to your PC
   exit
   gcloud compute scp music-app:~/music_app_backup.dump . --zone=asia-east2-a
   gcloud compute scp --recurse music-app:/var/www/music ./music --zone=asia-east2-a
   ```

2. **Set up new server:** Follow the same Steps 4-12 from the GCP guide above — the commands are identical on any Ubuntu VM.

3. **Upload to new server:**

   ```bash
   scp music_app_backup.dump user@NEW_SERVER_IP:~
   scp -r ./music user@NEW_SERVER_IP:~
   ```

4. **Switch DNS:** Update your domain's A record to point to the new server's IP.

5. **Shut down GCP VM:**
   ```bash
   gcloud compute instances stop music-app --zone=asia-east2-a
   # After verifying everything works on new server:
   gcloud compute instances delete music-app --zone=asia-east2-a
   ```

### Cost Comparison Over Time

| Period               | Provider               | Monthly Cost | Notes                  |
| -------------------- | ---------------------- | ------------ | ---------------------- |
| Months 1-2.5         | GCP Hong Kong          | ~$24-42      | Covered by $300 credit |
| Months 3+            | Alibaba Cloud HK       | **~$6-7**    | Unlimited bandwidth    |
| (Optional) Months 6+ | Alibaba Cloud Mainland | **~$3-5**    | If ICP filing obtained |

### Annual Cost After Phase 2

| Provider                       | Annual Cost      | vs GCP          |
| ------------------------------ | ---------------- | --------------- |
| GCP Hong Kong                  | $288-504/year    | baseline        |
| Alibaba Cloud HK               | **~$75/year**    | **75% savings** |
| Alibaba Cloud Mainland (promo) | **~$38-68/year** | **85% savings** |
