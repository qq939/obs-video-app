# OBS — 视频对象存储 Web App

监听 **8082** 端口的视频上传 / 播放服务，前端为**抖音式竖屏翻页视频流**（手跟踪 + 吸附动画）
+ **三页水平滑动架构**（CSS translateX）：信息页 / 中间 feed / 设置页。
**纯手势操作**，没有任何按钮。后端为 Node.js 内置 `http` 模块实现，
无任何第三方依赖。同时保留平台要求的 `/ask/claude` 问答接口。

项目根目录：`/home/agent/.claude/workspace/project`
当前 git HEAD：`main` → `1e67fb6`（OBS + Claude Ask + HLS 全自动 + 旋转修复 + 按字节切段 + UTC+8 05:00 cron + mov/mkv 重编码 + 单播放器 + 左右滑动面板 + 纯手势操作 + 无感自动播放 + 侧栏 50% + 按需缓存 + 抖音式纵向翻页 + 翻页阈值视口自适应 + 方向/速度锁定 + 前5/当前/后5 播放窗口 + 空缺随机填充，详情见 `logs/agent_tui.summary.md`）

---

## 功能概览

- 🎬 **抖音式竖屏翻页视频流**：手跟踪 + `easeOutCubic` 吸附动画 + wheel 翻页，原生滚动完全由 JS 接管（`overflow-y: hidden; touch-action: none`），无 scroll-snap
- 🔁 **三页水平架构**：`<div id="pages">` 横向 300% 宽，CSS `translateX(calc(-1 * var(--page) * (100% / 3)))` + `transition: transform .35s` 切页（0=信息 / 1=中间 feed / 2=设置）
- 🎯 **翻页阈值视口自适应**：`SWIPE_THRESHOLD = Math.max(240, round(innerWidth * 0.35))`（视口 1280 时 ≈ 448），加方向锁定（`AXIS_LOCK_DIST=18`）+ 速度豁免（`VELOCITY_THRESHOLD=0.5 px/ms`），左右滑动不再误翻页
- 🪟 **前 5 / 当前 / 后 5 播放窗口**：`WINDOW_SIZE=11`，`playlistWindow` 数组；前后各 5 格从 videos 实际位置取，超出部分 Fisher–Yates 随机填充（池耗尽重新洗），`scrollToIndex` 固定到中间副本
- 🔀 **随机播放**：`GET /videos` 每次返回随机顺序（Fisher–Yates），前端随机开关可重排
- 📐 **左右侧栏**：左滑打开信息面板（文件名/大小/时间/进度/索引），右滑打开设置面板（视频数量/随机开关/自动播放开关/播放速度）
- 👆 **纯手势操作**：无任何按钮 — 长按空白处打开上传弹窗，左右滑切换面板，点击/双击/拖动控制视频
- ⬆️ **分片上传**：`init → chunk → complete`，支持**断点续传**（按文件 sha256 匹配未完成会话），弹窗内点击或拖拽文件即可
- 🗜️ **视频压缩**：上传弹窗默认「压缩后上传」——浏览器端用 `captureStream()`+`MediaRecorder` 先把视频转码为 VP9/Opus webm（体积更小再传，省流量），原文件过大/不支持时自动回退直传
- 📡 **HTTP Range 流式播放**：支持 `206 Partial Content`，浏览器可拖拽进度条
- 📡 **HLS 流式播放**：服务端 ffmpeg 生成 m3u8 + ts 分片（存于独立 `hls/` 文件夹，不污染 `obs/`），浏览器用 hls.js（MSE）或 Safari 原生 HLS 播放；**全自动**：上传 / 压缩 / 服务启动 / **每日 UTC+8 05:00 cron** 对所有资产后台生成（无任何「转HLS」按钮），带旋转元数据的视频自动重编码扶正，**`.mov` / `.mkv` 一律重编码**（QuickTime moov 位置 + codec tag 兼容性问题，避免 hls.js/MSE 播放卡顿），hls.js 缺失/致命错误时自动回退直连 mp4/webm（OBS 上传 / 下载 / 列表接口全部保留）；**段大小按字节切**，每段约 50 MiB（`-hls_segment_size 52428800`，GOP 对齐）
- 🎚️ **播放速度选择**：设置面板 0.5x / 1x / 1.5x / 2x / 3x（默认 1.5x）
- ⏭️ **秒传跳过**：同一文件（相同 hash + size）再次上传直接返回已有地址
- 🔒 **路径安全**：文件名清洗，拒绝 `..` / 目录穿越
- 🔇 **永不静音**：暂停即无声，播放即有声（不再 `muted=true`），避免桌面鼠标拖拽滑动不触发 click 而无声
- 📍 **位置缓存**：离开页前记录 `currentTime`，滑回时自动恢复（>0.5s 视为有效）
- 🪶 **无感自动播放**：浏览器要求 user gesture 才能带声音播放；监听 `pointermove` / `wheel` / `scroll` / `touchmove` / `keydown`（任一发生）即视为手势，自动 `updatePlayback()` 触发播放 —— 用户**不用点击屏幕**，鼠标移到页面上就自动开播
- 📐 **侧栏占半屏**：左右信息/设置 panel `width: 50%`（最小 240 px），feed 在 panel 打开时偏移 50%
- 🚫 **按需缓存**：只当前活动视频持有 `preload='metadata'`，其余 `preload='none'` + `pause()`，避免浏览器预加载整个 feed、避免无声泄漏；hls.js 也只挂在活动视频上
- 💬 **Claude Ask**：保留 `/ask/claude`，经 `run_claude.js` 调用 claude CLI

---

## 快速开始

```bash
cd /home/agent/.claude/workspace/project
chmod +x user_start.sh
./user_start.sh                  # 启动后自动自检 /health
curl http://localhost:8082/health   # -> OK
```

容器重启时由 `start.sh → user_start.sh` 自动拉起服务。

---

## Docker 部署（推荐）

默认对外映射到 **80** 端口（容器内服务监听 8082），部署后可直接访问：

- `http://<你的局域网IP>/`
- 健康检查：`http://<你的局域网IP>/health`（返回 `OK`）

1) 配置宿主机 OBS 挂载目录（必须绝对路径）：

```bash
cp .env.example .env
```

编辑 `.env`，设置：

```bash
OBS_HOST_DIR=/ABSOLUTE/PATH/TO/YOUR/OBS/DIR
```

2) 启动 / 更新：

```bash
docker compose up -d --build
```

3) 停止：

```bash
docker compose down
```

---

## 目录结构

```
project/
├── server.js              # Web App 主入口（端口 8082，绑定 0.0.0.0）
├── user_start.sh          # 容器启动脚本（日志 -> logs/start.log & run.log）
├── start.sh               # 平台入口脚本（自动执行 user_start.sh）
├── run_claude.js          # Claude CLI 封装（平台文件）
├── systemreadme.md        # 平台惯例文档
├── hermit-container-debugging-guide.md
├── obs/                   # 视频存储目录
│   └── .uploads/          # 分片上传临时目录（完成后自动清理）
├── hls/                   # HLS 流式输出（<name>/index.m3u8 + seg-*.ts，独立于 obs/）
├── public/                # 前端静态资源
│   ├── index.html         # 页面骨架
│   ├── style.css          # 抖音式竖屏样式
│   ├── app.js             # 上传 / 播放 / 删除逻辑
│   └── vendor/hls.min.js  # hls.js（浏览器端 HLS 播放，jsdelivr 下载）
├── AGENTS.md / SOUL.md / USER.md / TOOLS.md / BOOTSTRAP.md / IDENTITY.md / HEARTBEAT.md
├── memory/                # 每日会话记录
├── .gitignore
└── logs/
    ├── start.log          # 启动日志
    ├── run.log            # 服务运行日志
    ├── agent_tui.log      # Claude Ask 会话流水
    ├── agent_tui.summary.md
    └── commit.txt         # git commit 记录
```

> **关于 HLS 与本轮变更**：容器内 `logs/agent_tui.log` 记录了从 2026-08-01 起的所有会话；最近 3 轮 = HLS 按字节切段 50 MiB + 24:00 cron → cron 改 UTC+8 05:00 → 无感播放 + 50% 侧栏 + 按需缓存（commit `21f9a93` / `a106c32` / `8d25e1b` / `1dcecfd`）。后续从 origin 拉来了 `bcdfb65` / `ceb68b4` / `996ebbc` 三个 commit（单播放器 / 手势优化 / 纯手势操作），当前 HEAD `996ebbc` 已包含全部。完整方案、调试 insight、经验教训见 `logs/agent_tui.summary.md`「最后 3 轮对话总结」。

---

## API 说明

### 1. 分片上传

**初始化上传** — `POST /upload/init`

```json
{ "filename": "a.mp4", "size": 3670016, "hash": "<sha256>", "chunkSize": 1048576, "totalChunks": 4 }
```

响应：

```json
{ "uploadId": "31bd437949323ec8-msaf0hzi", "chunkSize": 1048576, "totalChunks": 4, "uploaded": [0, 1, 3], "filename": "a.mp4" }
```

- 文件已存在（hash+size 匹配）→ `{ "skip": true, "url": "/obs/a.mp4" }`
- 存在未完成会话 → `{ ... , "resumed": true, "uploaded": [...] }`，客户端只传缺失分片即可续传

**上传分片** — `PUT /upload/chunk/:uploadId/:index`

请求体为二进制分片。响应：`{ "ok": true, "index": 0, "uploaded": 1, "total": 4 }`

**完成上传** — `POST /upload/complete/:uploadId`

服务端合并分片并校验 sha256。响应：`{ "ok": true, "url": "/obs/a.mp4" }`；
校验失败：`{ "error": "sha256 mismatch" }`

### 2. 简单上传

`PUT /upload/:filename`（请求体为完整文件）→ `{ "ok": true, "url": "/obs/a.mp4" }`

### 3. 播放 / 下载（HTTP Range）

`GET /obs/:filename` — 支持 Range：

- `Range: bytes=1000-1999` → `206 Partial Content` + `Content-Range`
- 后缀范围 `bytes=-100` → 返回最后 100 字节
- 超出范围 → `416 Range Not Satisfiable`
- `HEAD /obs/:filename` → 返回 `Accept-Ranges: bytes` 与文件大小

### 4. 视频列表

`GET /videos` → `{ "videos": [ { "name": "a.mp4", "size": 3670016, "mtime": "...", "url": "/obs/a.mp4", "hls": "/hls/a.mp4/index.m3u8", "hlsReady": false } ] }`

- `url`：直连播放/下载地址（原字段）
- `hls`：HLS 播放列表地址（m3u8，新增字段）
- `hlsReady`：HLS 分片是否已生成（新增字段；后台异步生成，未就绪时前端直接播 mp4/webm）

### 5. 删除

`DELETE /obs/:filename` → `{ "ok": true }`

### 6. 压缩

`POST /compress/:filename` → 用 ffmpeg 转码为 H.264/AAC MP4（`+faststart`，moov 前置，浏览器秒开）：

```json
{ "ok": true, "skipped": false, "before": 3553000, "after": 2247472, "saved": 1305528, "savedPct": 37 }
```

- 压缩参数：`libx264 -crf 23 -preset medium -pix_fmt yuv420p`，宽度上限 1920，音频 `aac 128k`
- 输出比原文件更小才覆盖；否则保留原文件并返回 `skipped: true`
- 前端：上传弹窗「压缩后上传」勾选项（浏览器端先压缩再上传）；无视频卡片按钮（按钮已移除，纯手势）

### 7. HLS 流式播放（m3u8 + ts）

服务端用 ffmpeg 把视频切成约 50 MiB 的 ts 分片（`hls/<name>/index.m3u8` + `seg-*.ts`，**独立文件夹，不污染 `obs/`**），浏览器用 hls.js（MSE）或 Safari 原生 HLS 播放，比直连大文件更流畅。**HLS 全自动生成，无任何「转HLS」按钮**。OBS 上传 / 下载 / 列表接口全部保留。

| 接口 | 方法 | 说明 |
|------|------|------|
| `/hls/:name/index.m3u8` | GET / HEAD | 播放列表（`application/vnd.apple.mpegurl`），支持 Range；源文件存在但分片缺失/版本过期时**自动惰性生成** |
| `/hls/:name/seg-NNNNN.ts` | GET / HEAD | ts 分片（`video/mp2t`），支持 Range；严格 `seg-\d+\.ts` 正则防穿越 |

> 无手动 HLS 接口：生成完全自动化（上传完成 / 压缩后 / 服务启动时对所有资产后台扫描）。

生成规则：

- **H.264 + AAC/MP3 且无旋转元数据且扩展名 `.mp4`/`.m4v`** → `-c copy` **快速 remux**（不重编码、无质量损失）
- **带旋转元数据的视频**（如 iPhone MOV 的 Display Matrix）→ 重编码 `libx264 -crf 23 -preset medium` + `aac 128k`，ffmpeg 内置 autorotation 把旋转**烘焙进像素**（否则 `-c copy` 只把旋转写成 TS 显示矩阵 SEI，hls.js/MSE 忽略导致视频旋转 90°）
- **`.mov` / `.mkv` 一律重编码**（QuickTime moov 位置 + codec tag 兼容性问题，避免 hls.js/MSE 播放卡顿）
- 其它（webm/vp9 等）→ 重编码 `libx264 -crf 23 -preset medium` + `aac 128k`
- 统一参数：`-f hls -hls_segment_size 52428800 -hls_list_size 0 -hls_playlist_type vod -hls_segment_filename seg-%05d.ts index.m3u8`（**按字节切，约 50 MiB/段，GOP 对齐**，VOD，全量保留分片）
- 每个 `hls/<name>/` 内写 `meta.json`（`{ version, size, rotation }`）；`/videos` 的 `hlsReady` 仅在分片存在 **且** 版本匹配 **且** 源文件大小一致时为真——版本升级或源文件变化会让所有资产自动重新生成（**每个变更都赋予所有资产**）
- 生成时机：上传完成 / 压缩后自动后台生成；**服务启动时扫描全部视频**，缺失或过期者后台补齐；**每日 UTC+8 05:00 cron**（server.js 进程内 `setInterval`，30 s 粒度，一天一次；用 `Intl.DateTimeFormat({timeZone:'Asia/Shanghai'})` 在 UTC+8 时区判定时分和日期 key）扫描 obs/，对没有当前版本 HLS 的视频后台生成；删除视频同时删除 `hls/<name>/`；同一视频并发生成只跑一个 ffmpeg（in-flight 锁）
- m3u8 使用**相对分段名**（ffmpeg 在分段临时目录内运行），自动解析到 `/hls/<name>/` 下

前端：

- `public/vendor/hls.min.js`（hls.js 1.5.13，jsdelivr 下载）由 `index.html` 在 `/app.js` 前引入，**必须存在**，否则非 Safari 浏览器无法走 HLS（自动回退直连 mp4/webm）
- **播放优先级（hls > obs）**：每个 `<video>` 用 `<source>` 列表构建：第一个 source 是 `/hls/<name>/index.m3u8`（`application/vnd.apple.mpegurl`，仅当 `v.hlsReady === true`），第二个是 `/obs/<name>`（按扩展名给正确 mime，如 `.mov` 给 `video/quicktime`，`.webm` 给 `video/webm` 等）。浏览器原生处理 fallback：m3u8 加载失败自动尝试下一个 source
- **按需缓存 + hls.js 仅挂在活动视频**：`updateVideoCache()` 只对当前活动视频保留 `preload='metadata'`，其余 `preload='none'` + `pause()`；`manageHls()` 只在活动视频的中间副本上 attach hls.js（leader `startLoad()`），其它视频不挂或销毁（远端幽灵拉流主动释放，避免后台狂拉分片）
- hls.js 致命错误：网络错误重试 1 次 → 媒体错误 `recoverMediaError()` 1 次 → 仍失败则销毁实例并回退直连 mp4/webm（`_hlsFallback` 防重挂循环）
- Safari 原生 HLS：`NATIVE_HLS` 仅当 UA 为 Safari 且 `canPlayType('application/vnd.apple.mpegurl')` 为真（Chromium/Firefox/Edge 也报告 `maybe` 但无法播放，需用 UA 排除）
- **无按钮**：UI 不再有「压缩 / 删除 / 转 HLS / 上传」按钮（HLS / 旋转 / mov 兼容全自动；上传通过长按空白处手势触发弹窗）

### 8. 平台接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/ask/claude?q=<文本或base64>` | GET / POST | 向 Claude 提问（经 `run_claude.js`，问答写入 `logs/agent_tui.log`） |
| `/ask/claude` (JSON body `{q}`) | POST | 同上，支持 JSON 请求体 |
| `/health` | GET | 健康检查，返回 `OK` |

`/ask/claude` 参数识别：含空格 **或** 长度 < 50 → 普通文本；否则按 base64 解码。

---

## 上传流程（前端）

```
选择文件
  ├─ 若勾选「压缩后上传」（默认勾选）→ 浏览器端转码为 webm（VP9/Opus，约 2.5 Mbps）
  │    · 用 <video>.captureStream() + MediaRecorder 实时重编码（volume=0 绕过自动播放策略且保留音频）
  │    · 输出比原文件更小才使用，否则回退原文件直传
  └─ 得到最终 file
      → 计算 sha256 → POST /upload/init
        ├─ 命中已存在 → 秒传跳过
        └─ 否则 → 遍历分片 PUT /upload/chunk/:uploadId/:index（跳过 uploaded[] 中已传分片）
                 → POST /upload/complete
                 → 刷新视频流
```

分片大小：2 MB（前端），`/upload/init` 可自定义 `chunkSize`。

> 说明：压缩在**上传前**于浏览器端完成，因此省的是**网络流量**（只传压缩后的小文件）。
> UI 已无「压缩 / 删除」按钮：上传即压缩，删除通过面板里的开关或直接删除源文件（保留服务端 HLS 全自动 + 旋转 + mov 兼容）。

---

## 前端交互（三页水平架构 + 抖音式纵向翻页）

`public/index.html` 用 `<div id="pages">` 横向 300% 宽，包含三个 page：

| 页面 | 内容 | 触发手势 |
|------|------|---------|
| 信息页（左，`#feed0`）| 文件名 / 大小 / 时间 / 进度 / 索引 | 主屏**左滑** |
| 中间 feed（`#feed1`）| 抖音式竖屏翻页视频流 | 上下拖拽 / wheel |
| 设置页（右，`#feed2`）| 视频数量 / 随机开关 / 自动播放开关 / 播放速度（0.5x/1x/1.5x/2x/3x） | 主屏**右滑** |
| 上传弹窗 | 选择文件 / 拖拽 / 进度 / 压缩后上传勾选 | **长按空白处** |

三页切换：`pagesEl.style.setProperty('--page', n)`，CSS `transform: translateX(calc(-1 * var(--page) * (100% / 3)))` + `transition: transform .35s`。

交互要点：

- **纯手势**：UI 没有任何按钮 — 上传长按空白处，面板左右滑，视频点击/双击/拖动
- **抖音式纵向翻页（手势驱动，无原生滚动）**：
  - `.feed` 设 `overflow-y: hidden; touch-action: none` 屏蔽原生滚动；CSS 移除 `scroll-snap` 相关属性
  - `vertFollow(dy)` 跟手：`scrollTop = vertBaseTop - dy` 实时映射拖拽
  - `vertRelease(dy)` 松手吸附：`easeOutCubic` 动画到目标位置（`h * 0.25` 吸附距离），更新 `activeIndex`
  - wheel 翻页：滚轮事件映射到上下翻页
- **横向翻页阈值视口自适应**：
  - `SWIPE_THRESHOLD = Math.max(240, Math.round(window.innerWidth * 0.35))`（视口 1280px 时 ≈ 448）
  - `AXIS_LOCK_DIST = 18` + `axisLock` 状态变量：touchmove/mousemove 中首次显著位移后锁定主轴（h / v），斜向/微抖不再误判横向
  - `VELOCITY_THRESHOLD = 0.5` px/ms；`finishSwipe` 速度豁免：`|dx| >= 0.6 * 阈值` 且 `|dx|/dt > 0.5` 即翻页
  - `touchstart` / `mousedown` 重置 `axisLock`
- **前 5 / 当前 / 后 5 播放窗口**（`WINDOW_SIZE = 11`）：
  - `playlistWindow` 数组；`initPlaylistWindow()` 初始化 11 格（前 5 按实际位置取，不足填 null，已见过不重复）
  - `setPlaylistWindow(targetIdx)`：把 `videos[targetIdx]` 放到窗口中间，前后各 5 格从 videos 实际位置取，超出部分 `randomFill()` 用 Fisher–Yates 从剩余池随机填充（池耗尽重新洗）
  - `applyIndex(idx)` 调用 `setPlaylistWindow(targetIdx)`
  - `renderFeeds` 渲染 `playlistWindow × FEED_COPIES`（共 33 格）
  - `scrollToIndex` 固定到 `MIDDLE_CURRENT_TOP = WINDOW_SIZE + 5 = 16`（中间副本当前视频位置）
  - `feedReady` 标志屏蔽初始化期间 scroll handler 误触发
  - `syncAppState()` 暴露 `window._appState` / `_playlistWindow` / `_activeIndex` 供测试读取
- **面板不打断播放**：打开左/右面板时视频继续在主屏播放（leader 不变，进度不重置）
- **自动播放**：默认开启；`updatePlayback()` 对 leader `muted=false` 后 `play()`；浏览器 autoplay 策略拒绝时等首个手势
- **无感自动播放**：手势监听 `pointermove` / `wheel` / `scroll` / `touchmove` / `keydown` 任一即视为 user gesture（不需要「按下」类事件，鼠标移动到页面即可解锁）
- **永不静音**：全程零 `muted=true`；暂停即无声，无需 mute
- **播放速度**：设置面板按钮（0.5x / 1x / 1.5x / 2x / 3x，默认 1.5x），通过 `video.playbackRate` 设置
- **位置缓存**：`positions` Map（视频名 → 秒）。切走前 `recordActivePosition()` 记录；切回时若缓存存在且差距 >0.5s 则 `currentTime` 恢复（用 `_pendingSeek` + `loadedmetadata` 事件延迟 seek）
- **按需缓存**：`updateVideoCache()` 只对当前活动视频保留 `preload='metadata'`，其余全部 `preload='none'` + `pause()`；hls.js 也只挂在活动视频上（避免远处视频出声、避免远端幽灵拉流）
- **纵向无尽头滚动**：`FEED_COPIES=3` DOM 副本存放 `playlistWindow` 渲染（11 × 3 = 33 格），中间份为「真实」位置；进 ghost 副本立即 `scrollTop` 跳回中间份，肉眼无跳变

---

## 日志规范

| 文件 | 内容 |
|------|------|
| `logs/start.log` | `user_start.sh` 启动日志 |
| `logs/run.log` | `server.js` 运行日志 |
| `logs/agent_tui.log` | Claude Ask 会话流水（问题 + 回答） |
| `logs/agent_tui.summary.md` | agent_tui.log 的整理稿 + 项目构建结构 + 最后 3 轮对话总结 |
| `logs/commit.txt` | git commit 记录（`{commit_id} {标题}`） |

---

## Git 管理规范

```bash
git add .gitignore server.js public/ obs/.gitkeep README.md SKILL.md systemreadme.md
git commit -m "描述本次变更"
git log --format="%h %s" -1 >> logs/commit.txt
```

- `run_claude.js` / `start.sh` / `user_start.sh` 为平台文件，**不纳入 git 仓库**
- `logs/`、`sessions/`、`obs/` 内容已在 `.gitignore` 忽略（视频数据不入库）

---

## 已知说明

- `/ask/claude` 在**当前主会话正在运行**时，二次 claude CLI 会因会话占用而等待；
  该端点设计用于宿主控制面板在主会话空闲时调用。
- 当前 HEAD `1e67fb6` 已实现：HLS 全自动 + 旋转 90° 修复 + 按字节切段（50 MiB/段）+ UTC+8 05:00 cron + mov/mkv 一律重编码 + 单播放器 + 左右滑动面板 + 纯手势操作 + 无感自动播放 + 侧栏 50% + 按需缓存 + 抖音式纵向翻页 + 翻页阈值视口自适应 + 方向/速度锁定 + 前 5/当前/后 5 播放窗口 + 空缺随机填充。完整方案、调试细节、经验教训
  参见 `logs/agent_tui.summary.md` 末尾「最后 3 轮对话总结」。
- 更多容器部署细节参见 `hermit-container-debugging-guide.md`。
