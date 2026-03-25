# Home Server Deployment Guide (Windows)

Self-host the music app on your Windows PC using dev mode + Cloudflare Tunnel.

Since you only run the server when you're not developing, there's no need for production builds or PM2 — just use `npm run dev` as usual and start the tunnel.

```
Internet → Cloudflare Tunnel (free HTTPS) → Your Windows PC
                                              ├── Next.js dev server (port 3000) → rewrites /api/* to backend
                                              ├── Express dev server (port 4000)
                                              ├── PostgreSQL (port 5432)
                                              └── C:/Projects/web-v1/music/ (local disk)
```

---

## One-Time Setup

### Step 1: Buy a Domain from Cloudflare

1. Sign up / log in at [dash.cloudflare.com](https://dash.cloudflare.com)
2. Go to **Domain Registration** → **Register Domains**
3. Search for a domain and purchase (~$10/year)
4. DNS is already managed by Cloudflare — no transfers needed

### Step 2: Install Cloudflare Tunnel

Open PowerShell or terminal:

```bash
winget install Cloudflare.cloudflared
```

Verify:

```bash
cloudflared --version
```

### Step 3: Create the Tunnel

**3.1 Login:**

```bash
cloudflared tunnel login
```

Opens your browser — select your domain.

**3.2 Create tunnel:**

```bash
cloudflared tunnel create music-app
```

Note the **tunnel ID** printed (e.g., `a1b2c3d4-5678-...`).

**3.3 Configure tunnel:**

Create the file `C:\Users\chaol\.cloudflared\config.yml`:

```yaml
tunnel: <your-tunnel-id>
credentials-file: C:\Users\chaol\.cloudflared\<your-tunnel-id>.json

ingress:
  - hostname: yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

Replace `<your-tunnel-id>` and `yourdomain.com` with your actual values.

**3.4 Create DNS record:**

```bash
cloudflared tunnel route dns music-app yourdomain.com
```

### Step 4: Update Backend CORS

Edit `backend/.env` — add your domain to `FRONTEND_URL`:

```env
FRONTEND_URL=https://yourdomain.com
```

This allows requests from your domain. Your local `http://localhost:3000` still works for development since the Next.js rewrite proxy handles `/api/*` requests.

---

## Daily Usage

### Start serving (when you want friends to access)

Open 3 terminals:

```bash
# Terminal 1: Backend
cd C:/Projects/web-v1/backend
npm run dev

# Terminal 2: Frontend
cd C:/Projects/web-v1/frontend
npm run build
npm start

# Terminal 3: Tunnel
cloudflared tunnel run music-app
```

Your friends can now access `https://yourdomain.com`.

### Stop serving (when you want to develop or shut down)

Close the 3 terminals, or press `Ctrl+C` in each.

That's it. No services to uninstall, no processes lingering in the background.

### What your friends see when it's off

They'll get a Cloudflare error page. No data is lost — everything resumes where it left off next time you start.

---

## Verification Checklist

- [ ] PostgreSQL is running (check in Windows Services or `pg_isready`)
- [ ] `npm run dev` works for both backend (port 4000) and frontend (port 3000)
- [ ] `cloudflared tunnel run music-app` connects successfully
- [ ] `https://yourdomain.com` loads the login page
- [ ] Can log in and play a clip
- [ ] A friend can access `https://yourdomain.com` from their device

---

## Migrating from Self-Host to Cloud Server

When you're ready to move to a cloud server (e.g., Google Cloud), follow these steps.

### What self-hosting leaves on your PC

| Thing                | Location                           | Inside project? |
| -------------------- | ---------------------------------- | --------------- |
| cloudflared + config | `C:\Users\chaol\.cloudflared\`     | No              |
| `node_modules/`      | Already exists, already gitignored | No change       |

Your project folder is untouched — no build artifacts, no extra config files.

### Step 1: Export your database

```bash
pg_dump -U postgres -d music_app -F c -f music_app_backup.dump
```

This captures all user data (playlists, clips, likes, accounts). See [DATABASE_EXPORT_IMPORT.md](DATABASE_EXPORT_IMPORT.md) for details.

### Step 2: Copy files to the cloud server

Transfer these:

- `music_app_backup.dump` — your database
- `music/` folder — all MP3 and LRC files
- Your project code (via `git clone` if on GitHub, or copy directly)

### Step 3: Set up the cloud server

```bash
# Create database and restore
createdb -U postgres music_app
pg_restore -U postgres -d music_app --no-owner --no-privileges music_app_backup.dump

# Install dependencies
cd backend && npm install && npx prisma generate
cd ../frontend && npm install && npm run build
```

Update `backend/.env` with the new `DATABASE_URL`, `MP3_BASE_PATH`, and `FRONTEND_URL`.

### Step 4: Switch DNS

**Option A: Reuse Cloudflare Tunnel (on the cloud server)**

```bash
# Install cloudflared on cloud server and run the same tunnel
cloudflared tunnel run music-app
```

**Option B: Point DNS directly to cloud server**

- In Cloudflare DNS, change the record for `yourdomain.com` from the tunnel CNAME to an A record pointing to your cloud server's IP
- Set up SSL with Let's Encrypt + nginx on the cloud server

### Step 5: Clean up your Windows PC

```bash
# Remove Cloudflare Tunnel
winget uninstall Cloudflare.cloudflared
rm -rf C:/Users/chaol/.cloudflared
```

Your project is back to exactly how it was.

### Step 6: Verify

- [ ] `https://yourdomain.com` loads from the cloud server
- [ ] All user data (playlists, clips, likes) is intact
- [ ] Audio streaming works
- [ ] Your local project folder is clean — `npm run dev` still works for development

---

## Security Notes

- Your app already has invite-only access (PENDING → MEMBER approval by admin)
- Cloudflare provides DDoS protection and SSL/HTTPS automatically
- No ports need to be opened on your router — the tunnel connects outbound
- Optional: enable [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) (free for up to 50 users) for an extra authentication layer
