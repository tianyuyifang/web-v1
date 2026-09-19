# 从零重建 music-app(完整恢复手册)

本备份自包含:即使 VM、GCP 账号、GitHub 全部丢失,仅凭 `F:\music-app-backup` 即可重建。

## 备份内容

```
F:\music-app-backup\
├── music\                      41 GB   曲库 mp3+lrc(与 VM allSongs 一致)
├── clips\allClips.tar.gz      7.4 GB   切片音频(重生成需数小时,必须保留)
├── system\vm-backup-payload.tar.gz  ~123 MB
│   ├── db\music_app.sql               数据库完整 dump
│   ├── db\roles.sql                   PG 角色+密码哈希(先于 dump 导入)
│   ├── config\backend.env             ★ DB 密码/JWT 密钥,丢了用户需重注册
│   ├── config\frontend.env.local
│   ├── config\nginx.tar.gz            /etc/nginx 全量
│   ├── config\letsencrypt.tar.gz      ★ SSL 证书 qnicheatsheet.com
│   ├── config\crontab.txt             4 个定时任务(含每日备份)
│   ├── config\pm2-dump.json           PM2 服务定义
│   ├── config\journald.conf / logrotate-nginx
│   ├── code\web-v1.tar.gz             含 .git 完整提交历史
│   └── MANIFEST.txt                   版本清单,照此装环境
├── LAST-BACKUP.txt            上次备份时间与体量
└── backup.log                 历次运行日志
```

## 重建步骤

### 1. 开机器
按 MANIFEST.txt:Ubuntu 22.04、e2-small、磁盘 ≥ 80 GB(推荐 150 GB)。

### 2. 装环境(版本对齐 MANIFEST.txt)
```bash
sudo apt update && sudo apt install -y nginx postgresql-14 git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm install -g pm2
```

### 3. 还原数据库(注意顺序:先角色后数据)
```bash
tar xzf vm-backup-payload.tar.gz
sudo -u postgres psql -f db/roles.sql
sudo -u postgres createdb music_app
PGPASSWORD=<见 backend.env> psql -U postgres -h localhost -d music_app -f db/music_app.sql
```

### 4. 还原代码与配置
```bash
tar xzf code/web-v1.tar.gz -C /home/chaol/
cp config/backend.env  /home/chaol/web-v1/backend/.env
cp config/frontend.env.local /home/chaol/web-v1/frontend/.env.local
sudo tar xzf config/nginx.tar.gz -C /etc/
sudo tar xzf config/letsencrypt.tar.gz -C /etc/     # SSL 证书
crontab config/crontab.txt
```

### 5. 还原音频(两部分都要)
```bash
sudo mkdir -p /var/www/music && sudo chown chaol:chaol /var/www/music
# 曲库:从 F:\music-app-backup\music\ 上传(41 GB,建议分批 tar)
# 切片:
tar xzf clips/allClips.tar.gz -C /var/www/music/
```

### 6. 起服务
```bash
cd /home/chaol/web-v1/backend  && npm install && npx prisma generate
cd /home/chaol/web-v1/frontend && npm install && npm run build
pm2 resurrect          # 用 pm2-dump.json
pm2 startup && pm2 save
sudo systemctl restart nginx
```

### 7. 验证
```bash
curl -I http://localhost:3000                  # 前端 200
curl -s -o /dev/null -w '%{http_code}' http://localhost:4000/api/songs  # 401=正常(需登录)
psql -c "SELECT count(*) FROM songs;"          # 对照 MANIFEST songs_count
ls /var/www/music/allSongs | wc -l             # 对照 MANIFEST
ls /var/www/music/allClips | wc -l             # 对照 MANIFEST
```

## 注意事项

- **`.env` 里的 JWT 密钥必须保留原值**,换了的话所有用户登录态失效、需重新注册。
- **SSL 证书**若已过期,用 `certbot --nginx -d qnicheatsheet.com` 重签即可。
- **DNS**:qnicheatsheet.com 需指向新机器 IP(域名注册商处改)。
- **切片路径**依赖数据库里的 `clips.file_path`,还原时目录结构必须是 `/var/www/music/allClips/`,不能嵌套。

## 验证备份完整性(恢复前先做)

解压 payload 后,数 dump 里每张表的实际数据行数:

```bash
cd <解压目录>
for t in users capture_events capture_sessions tag_events passage_catalogue          song_mappings song_prefs lyric_passage_matches songs clips          playlists playlist_clips likes imported_tracks; do
  n=$(awk -v tbl="public.$t" '$0 ~ "^COPY "tbl" " {f=1; next} f && /^\\.$/ {f=0} f {c++} END {print c+0}' db/music_app.sql)
  printf '%-26s %s
' "$t" "$n"
done
```

2026-09-19 实测基线(供对照,数字会随使用增长):

| 表 | 行数 |
|---|---|
| users | 225 |
| capture_events(唱卡记录) | 181,834 |
| capture_sessions | 2,297 |
| tag_events(打标) | 48,277 |
| passage_catalogue(唱卡段落) | 15,847 |
| song_mappings(映射) | 4,396 |
| song_prefs | 4,863 |
| lyric_passage_matches | 315 |
| songs | 22,039 |
| clips | 45,203 |
| playlists | 1,705 |
| playlist_clips | 260,042 |
| likes | 11,139 |
| imported_tracks | 7,634 |

任何一项为 0 = 备份有问题,不要用它恢复。

## 备份覆盖不到的两样(必须知道)

1. **DNS** —— qnicheatsheet.com 指向的 IP 要在域名注册商处改,备份救不了。
2. **已被 30 天滚动清理删掉的历史** —— cron 里 `prune-captures.js` 每天清理超过 30 天的
   `capture_events`。2026-09-19 时该表最早只到 08-09。备份只能保住当下库里还有的,
   拿不回已被删的历史。若要长期保留,需先做「唱卡集独立成表」。

## 关键密钥说明

`config/backend.env` 里有两个**不能换**的密钥:
- `JWT_SECRET` —— 换了所有用户登录态失效
- `MUSIC_VAULT_KEY` —— 加密用户的 QQ/网易云 cookie,换了所有人要重新连接音源

## ⚠ 文件名编码(最容易出事的一环)

**Windows 解压 tar 时必须加 `--options hdrcharset=UTF-8`，否则中文文件名全部乱码。**

实测证据(2026-09-18)：
| | 文件名 | 字节 |
|---|---|---|
| VM 上(正确) | `18 - CoCo李玟 - 24.lrc` | `e69d8e e78e9f` |
| `tar xf` 默认解压 | `18 - CoCo鏉庣師 - 24.lrc` | `e98f89 e5baa3 e5b8ab` |
| `tar xf --options hdrcharset=UTF-8` | `18 - CoCo李玟 - 24.lrc` | `e69d8e e78e9f` ✅ |

`tar tf` 列表看着是对的，**只有真正写到磁盘才会坏** —— 所以不能靠列表判断。
shell 代码页已是 65001(UTF-8) 也照样发生，与代码页无关。

**为什么致命**：数据库 `clips.file_path` 存的是正确中文名。用乱码文件名恢复，
网站能起来但那批切片点了没声音 —— 而且只有用户点到才会发现。

**验证方法**(恢复后必做)：
```bash
# 乱码特征字符检测，结果必须为 0
ls /var/www/music/allClips | grep -c '鏉\|閺\|鐢\|钁\|娴\|楣\|绂'

# 逐字节核对某个已知中文文件
ls /var/www/music/allClips | grep 'CoCo' | head -1 | xxd | head -1
# 应含 e69d8e e78e9f (李玟)，不是 e98f89 e5baa3 (鏉庣)
```

同理，**从 F 盘往新机器传曲库/切片时**，如果走 tar，两端都要确保 UTF-8：
- Windows 打包：`tar cf x.tar --options hdrcharset=UTF-8 ...`
- Linux 解压：默认即 UTF-8，无需特殊处理
