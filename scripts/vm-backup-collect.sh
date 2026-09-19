#!/bin/bash
# 在 VM 上收集"重建所需的一切"(曲库除外 —— 曲库单独同步)
# 产出: /home/chaol/vm-backup-payload.tar.gz
set -euo pipefail

STAGE=$(mktemp -d /tmp/vmbk.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
echo "staging in $STAGE"

mkdir -p "$STAGE/config" "$STAGE/db" "$STAGE/code"

# 从 VM 自己的 .env 读取 DB 密码（脚本内不存密钥）
DBURL=$(grep -E '^DATABASE_URL=' ~/web-v1/backend/.env | head -1 | cut -d= -f2- | tr -d '"'"'"'"')
PGPW=$(printf '%s' "$DBURL" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')
PGPW=$(printf '%b' "$(printf '%s' "$PGPW" | sed 's/%/\x/g')")
[ -n "$PGPW" ] || { echo "FATAL: cannot read DB password from backend/.env"; exit 1; }


# 1. 数据库完整 dump(自带建库语句)
echo "[1/6] pg_dump..."
PGPASSWORD="$PGPW" pg_dump -U postgres -h localhost -d music_app \
  --clean --if-exists --no-owner > "$STAGE/db/music_app.sql"
# 角色(密码哈希)另存,恢复时先建角色
PGPASSWORD="$PGPW" pg_dumpall -U postgres -h localhost --roles-only > "$STAGE/db/roles.sql"
[ -s "$STAGE/db/roles.sql" ] || { echo "FATAL: roles.sql empty"; exit 1; }

# 2. 应用配置 —— 密钥在这里,最关键
echo "[2/6] app configs (.env)..."
cp ~/web-v1/backend/.env "$STAGE/config/backend.env" 2>/dev/null || echo "WARN: no backend .env"
cp ~/web-v1/frontend/.env.local "$STAGE/config/frontend.env.local" 2>/dev/null || echo "WARN: no frontend .env.local"

# 3. nginx + SSL 证书
echo "[3/6] nginx + SSL..."
sudo tar czf "$STAGE/config/nginx.tar.gz" -C /etc nginx 2>/dev/null
sudo tar czf "$STAGE/config/letsencrypt.tar.gz" -C /etc letsencrypt 2>/dev/null

# 4. cron + PM2 + 系统配置
echo "[4/6] cron / pm2 / system..."
crontab -l > "$STAGE/config/crontab.txt" 2>/dev/null || echo "(empty)" > "$STAGE/config/crontab.txt"
sudo crontab -l > "$STAGE/config/crontab-root.txt" 2>/dev/null || echo "(empty)" > "$STAGE/config/crontab-root.txt"
pm2 save >/dev/null 2>&1 || true
cp ~/.pm2/dump.pm2 "$STAGE/config/pm2-dump.json" 2>/dev/null || true
cp -r ~/.ssh "$STAGE/config/ssh" 2>/dev/null && chmod -R go-rwx "$STAGE/config/ssh" || echo "WARN: no .ssh"
sudo tar czf "$STAGE/config/www-html.tar.gz" -C /var/www html 2>/dev/null || true
cp ~/.pm2/module_conf.json "$STAGE/config/" 2>/dev/null || true
sudo cp /etc/systemd/journald.conf "$STAGE/config/" 2>/dev/null || true
sudo cp /etc/logrotate.d/nginx "$STAGE/config/logrotate-nginx" 2>/dev/null || true

# 5. 代码(排除可重装/可重建的)
echo "[5/6] code..."
tar czf "$STAGE/code/web-v1.tar.gz" -C /home/chaol \
  --exclude='web-v1/backend/node_modules' \
  --exclude='web-v1/frontend/node_modules' \
  --exclude='web-v1/frontend/.next' \
  web-v1 2>/dev/null

# 6. 环境清单(重建时照着装)
echo "[6/6] manifest..."
{
  echo "backup_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "os: $(lsb_release -ds 2>/dev/null)"
  echo "kernel: $(uname -r)"
  echo "node: $(node -v)"
  echo "npm: $(npm -v)"
  echo "postgres: $(psql --version 2>/dev/null | awk '{print $3}')"
  echo "nginx: $(nginx -v 2>&1 | awk -F/ '{print $2}')"
  echo "pm2: $(pm2 -v 2>/dev/null)"
  echo "machine_type: e2-small"
  echo "zone: asia-east2-a"
  echo "disk: $(df -h / | tail -1 | awk '{print $2" used "$3}')"
  echo "songs_count: $(ls -A /var/www/music/allSongs | wc -l)"
  echo "clips_count: $(ls -A /var/www/music/allClips | wc -l)"
  echo "db_size: $(PGPASSWORD="$PGPW" psql -U postgres -h localhost -tAd music_app -c "SELECT pg_size_pretty(pg_database_size('music_app'));" 2>/dev/null | tr -d ' ')"
} > "$STAGE/MANIFEST.txt"

# 关键产物非空校验 —— 空文件等于没备份
for f in db/music_app.sql db/roles.sql config/backend.env config/nginx.tar.gz config/letsencrypt.tar.gz code/web-v1.tar.gz; do
  [ -s "$STAGE/$f" ] || { echo "FATAL: $f missing or empty"; exit 1; }
done

# 打包
tar czf /home/chaol/vm-backup-payload.tar.gz -C "$STAGE" .
echo "DONE: $(du -h /home/chaol/vm-backup-payload.tar.gz | cut -f1)"
cat "$STAGE/MANIFEST.txt"
