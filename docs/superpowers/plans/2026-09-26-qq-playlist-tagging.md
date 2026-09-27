# qq歌单打标 — 实施计划（简版）

> 状态：计划，未动工。2026-09-26。
> 接口研究与实测记录见记忆 `reference_qq_playlist_like_api.md`（QQ + 网易云 十项接口全部用真账号验证通过）。

## 目标

用户在本站选一个自己 QQ 音乐 / 网易云的歌单 → 点「开始打标」→ APK 抓到的游戏歌名与该歌单匹配 → **完全匹配自动在用户平台账号的「我喜欢」里点赞**，其余进待确认列表 approve / ignore。页面只显示文字，不播放。

## 已定的决策

| 项 | 决定 |
|---|---|
| 平台 | QQ + 网易云同时做，同一页面切换 |
| 入口 | 导航栏新链接「QQ打标」，路由 `/platform-tagging` |
| 门禁 | 新加订项 `platform_tagging`：ADMIN 永远有；档位配置里只给「挚友」勾上 → 以后管理页勾其他档即开放，不改代码 |
| 匹配 | 原样复用 `captureMatchService.matchTitle`（不改）；exact 且歌单内唯一候选才自动点，其余 pending |
| 撤销 | 不做 |
| 已喜欢 | 点之前批量查一次；已在「我喜欢」的显示「已喜欢」，不写 |
| 记录 | 新表 `platform_tag_events`，不碰 `capture_events`；随 session 级联删除（`prune-captures.js` 现有的 45 天会话清理），不另加清理代码 |
| APK | **不改**。心跳回 `target:"playlist"`, `playlistId:"qq:<tid>"` / `"netease:<id>"`，v21 照常按歌 P 扫红蓝列表 |
| 隔离 | 共享代码只加 3 处纯新增分支（见 Step 4）；其余全是新文件 |

## 数据

### 新表 `platform_tag_events`（1 个迁移）

```
id uuid pk
session_id uuid  → capture_sessions.id (onDelete cascade)
user_id uuid
platform  'qq' | 'netease'
playlist_ref text        -- 'qq:<tid>' / 'netease:<id>'，与 capture_sessions.playlist_id 同串
raw_text text
outcome  'liked' | 'already_liked' | 'pending' | 'ambiguous' | 'no_match' | 'ignored' | 'failed'
candidates jsonb          -- [{externalId, songType, title, artist, kind, alreadyLiked}]
liked_external_id text    -- 真正点上去的歌（liked / approve 后）
error text
created_at timestamptz, updated_at
@@index([session_id, created_at]); @@unique([session_id, playlist_ref, raw_text])
```

### `capture_sessions` 加 1 列（同一迁移）
`platform_ref text null` —— 存 `'qq:<tid>'` / `'netease:<id>'`。不能复用 `playlist_id`（它是 `@db.Uuid`，只装本站歌单）。`target` 新增取值 `'platform'`；`target='platform'` 时 `playlist_id` 为 null。

## 后端

### Step 1 — 门禁（照 `reference_addon_gating` 模式）
- `utils/entitlements.js`：`ADD_ONS.PLATFORM_TAGGING = 'platform_tagging'`；`hasAddOn` 的档位分支从「只认 capture」改为按 addOn 名读 `tierConfig[tier][addOn]`（capture 行为不变）。
- `settingsService.js` 默认档位：四档都加 `platformTagging: false`，`zhiyou: true`。
- `TierConfigPanel.js` 加一列开关。
- `routes/platformTagging.js` 顶部 `requirePlatformTaggingAddOn`（复制 `requireCaptureAddOn` 的写法，每次现查 DB）。
- `useAuth.js`：`canPlatformTag`（对齐服务器 `effectiveEntitlements`）。

### Step 2 — 平台客户端（新增函数，不改现有函数签名）
- `sources/qqSource.js` 新增：`listMyPlaylists({cookie,uin,musicKey})`（GetPlaylistByUin + CgiGetPlaylistFavInfo 合并，字段名对齐）、`getPlaylistRows(tid)`（复用 getPlaylist 但**保留 `id`/`type`**——新函数 `toTrackFull`，不改 `toTrack`）、`isLiked(ids[])`（IsSongFanById → `{id:bool}`）、`like({songId,songType})`（AddSonglist dirId 201，成功判据 `result.dirId===201`，再回读）。
- `sources/neteaseLogin.js` 新增：`listMyPlaylists(cookie)`（/api/user/playlist，需 uid → 先 getAccountInfo）、`isLiked(cookie, ids[])`（/api/song/like/check，返回的是「已喜欢子集」→ 转成 map）、`like(cookie, id)`（/api/radio/like like:true，回读 check）。
- 新 `services/platformLikeService.js`：对外统一 `listPlaylists(userId, platform)` / `getPlaylistSongs(userId, platform, ref)` / `likedMap(userId, platform, ids)` / `like(userId, platform, song)`。内部取凭证走 `musicCredentialAccess.getFreshCredential`；QQ 走 `pace()`，网易走 breaker；**所有写操作串行 + 回读验证**。

### Step 3 — 新服务 `services/platformTagService.js`
- `startTagging({userId, platform, playlistRef})`：校验凭证、拉歌单歌曲（缓存在内存 Map，key=userId+ref，TTL 10 分钟）、调 `captureService.setTarget({target:'platform', playlistRef})`。
- `ingest({session, rawText})`：去重（unique 约束）→ `matchTitle(text, songs)` → 若 exact 且唯一：查 likedMap → 已喜欢记 `already_liked`，否则 `like()` → `liked`/`failed`；其余按 outcome 落表 → `broadcast` 到 SSE 频道 `platform:<userId>`。
- `approve({userId, eventId, externalId})` / `ignore()`。
- `getFeed({userId, sessionId})`。
- 清理：靠 `onDelete: Cascade` 跟 session 一起被现有 prune 脚本删掉，不改脚本。

### Step 4 — 共享代码的 3 处纯新增分支
1. `routes/capture.js` `/ingest`：`target === 'platform'` → `platformTagService.ingest(...)`（放在现有三元之前，不动其他分支）。
2. `captureService.setTarget`：`else if (target === 'platform')` 校验 `playlistRef` 格式 `^(qq|netease):\S+$`，写入；`mode` 保持 `'playlist'`。
3. `routes/capture.js` `/heartbeat`：`target === 'platform'` 时回 `{target:'playlist', playlistId: session.platformRef}`，让 APK 按歌 P 扫、且切歌单时清已发送集合。
- `getConnection` 返回里带上 `platformRef`（新字段，旧调用方忽略）。

### Step 5 — 路由 `routes/platformTagging.js`（全部挂 web 中间件 + 新门禁）
```
GET  /api/platform-tagging/playlists?platform=qq|netease
GET  /api/platform-tagging/playlists/:ref/songs        -- 文字列表 + alreadyLiked 标记
POST /api/platform-tagging/start   {platform, playlistRef}   -- 需已有连接（复用 /api/capture/connect 拿配对码）
GET  /api/platform-tagging/feed?sessionId=
GET  /api/platform-tagging/stream   (SSE，复用 sseManager)
POST /api/platform-tagging/events/:id/approve {externalId}
POST /api/platform-tagging/events/:id/ignore
POST /api/platform-tagging/like    {platform, externalId, songType}  -- 页面手动点 like
```
挂到 `app.js`。写限流：每用户 30 次/分。

## 前端

### Step 6 — 页面 `app/platform-tagging/page.js`
- 未连接平台 → 引导到账户页现有「音源连接」。
- 平台切换（只显示已连接的）→ 歌单列表（名称 / 歌曲数 / 「我喜欢」置顶）→ 点开：文字歌曲列表，已喜欢的带 ♥，每行有手动 like 按钮。
- 「开始打标」：调 `/connect`（若无连接，显示配对码；沿用 CapturePanel 的配对 UI 逻辑）→ `/start`。
- 结果面板：**复制** `CapturePanel.js` 为 `PlatformTagPanel.js` 再删减（不加 prop），四列：已点 / 已喜欢 / 待确认(approve·ignore) / 未匹配。SSE 实时 + 刷新恢复。
- 手机端：单列堆叠（`<sm` 分开处理）。

### Step 7 — 导航
- `Navbar.js`：`canPlatformTag && navLink("/platform-tagging", "QQ打标")`，桌面和手机两处都加。
- `CaptureIndicator`：target 为 `platform` 时显示「投递到：QQ打标」（新增分支）。

## 测试与验证

- 单测：`platformLikeService` 用 mock HTTP 覆盖 QQ `result.dirId===0` 视为未写入、网易 check 子集→map；`setTarget('platform')` 拒绝坏 ref；`ingest` 的 exact-唯一 / exact-多候选 / bracket 三种 outcome。
- grep 防呆：新代码不得出现 `toggleLike`（沿用现有测试）。
- 手测：用两个平台各打一局 → 平台「我喜欢」出现自动点的歌；approve 一首 pending；切回本站歌单，确认现有自动打标行为不变；非挚友账号直调所有新接口 → 403。
- 回归：现有 `/api/capture` 的 playlist / live 路径不受影响（跑既有 e2e）。

## 部署顺序
push → VM pull → `prisma migrate deploy` → `prisma generate` → 重启后端 → 管理页给挚友档勾上 → 重建前端。

## 待你拍板（不影响开工，默认按左侧）
- 记录保留 **30 天** ｜ 或 7 天 / 永久
- 页面名 **「QQ打标」** ｜ 或「歌单打标」（因为也含网易云）
- 手动 like 按钮是否也要求 exact？（默认：手动点不限制）
