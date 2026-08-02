# OBS — 视频对象存储 Web App

监听 **8082** 端口的视频上传 / 播放服务，前端为抖音式竖屏滑动视频流（scroll-snap），
**三页水平排布**（CSS translateX）：信息页 / 主 feed / 设置页，三页播放**同一个视频且进度同步**。
后端为 Node.js 内置 `http` 模块实现，无任何第三方依赖。同时保留平台要求的
`/ask/claude` 问答接口。

项目根目录：`/home/agent/.claude/workspace/project`

---

## 功能概览

- 🎬 **竖屏视频流**：全屏滑动、逐条自动播放（scroll-snap + IntersectionObserver）
- 🔀 **随机播放**：`GET /videos` 每次返回随机顺序（Fisher–Yates），前端随机开关可重排
- 📄 **三页水平布局**：主 feed 页左右滑动切换：
  - 左滑 → 信息页（同一 feed + 右侧播放信息面板：文件名/大小/时间/进度/索引）
  - 右滑 → 设置页（同一 feed + 右侧设置菜单 + 右下角加号上传按钮）
  - 三个页面都播放**同一个视频**，播放进度通过 leader 视频每 500ms 同步到其它两页
- ⬆️ **分片上传**：`init → chunk → complete`，支持**断点续传**（按文件 sha256 匹配未完成会话）
- 🪟 **上传弹窗**：设置页右下角 `＋` **或设置菜单内「＋ 上传视频」按钮**打开，支持点击选择 / 拖拽文件，实时显示分片进度
- 📡 **HTTP Range 流式播放**：支持 `206 Partial Content`，浏览器可拖拽进度条
- 🗑️ **删除视频**：视频卡片右上角一键删除
- 🗜️ **视频压缩**：上传弹窗默认「压缩后上传」——浏览器端用 `captureStream()`+`MediaRecorder` 先把视频转码为 VP9/Opus webm（体积更小再传，省流量），原文件过大/不支持时自动回退直传；视频卡片「压缩」按钮则一键服务端转码为 H.264/AAC MP4（`ffmpeg` + `+faststart`），体积更小、浏览器秒开
- 📡 **HLS 流式播放**：服务端 ffmpeg 生成 m3u8 + ts 分片（存于独立 `hls/` 文件夹，不污染 `obs/`），浏览器用 hls.js（MSE）或 Safari 原生 HLS 播放；**全自动**：上传 / 压缩 / 服务启动时对所有资产后台生成（无任何「转HLS」按钮），带旋转元数据的视频自动重编码扶正，hls.js 缺失/致命错误时自动回退直连 mp4/webm（OBS 上传 / 下载 / 列表接口全部保留）
- ⏭️ **秒传跳过**：同一文件（相同 hash + size）再次上传直接返回已有地址
- 🔒 **路径安全**：文件名清洗，拒绝 `..` / 目录穿越
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
- 前端：视频卡片「压缩」按钮（服务端转码）；上传弹窗「压缩后上传」勾选项（浏览器端先压缩再上传，见下）

### 7. HLS 流式播放（m3u8 + ts）

服务端用 ffmpeg 把视频切成 4s 的 ts 分片并生成 VOD 播放列表（`hls/<name>/index.m3u8` + `seg-*.ts`，**独立文件夹，不污染 `obs/`**），浏览器用 hls.js（MSE）或 Safari 原生 HLS 播放，比直连大文件更流畅。**HLS 全自动生成，无任何「转HLS」按钮**。OBS 上传 / 下载 / 列表接口全部保留。

| 接口 | 方法 | 说明 |
|------|------|------|
| `/hls/:name/index.m3u8` | GET / HEAD | 播放列表（`application/vnd.apple.mpegurl`），支持 Range；源文件存在但分片缺失/版本过期时**自动惰性生成** |
| `/hls/:name/seg-NNNNN.ts` | GET / HEAD | ts 分片（`video/mp2t`），支持 Range；严格 `seg-\d+\.ts` 正则防穿越 |

> 无手动 HLS 接口：生成完全自动化（上传完成 / 压缩后 / 服务启动时对所有资产后台扫描）。

生成规则：

- **H.264 + AAC/MP3 且无旋转元数据** → `-c copy` **快速 remux**（不重编码、无质量损失）；**带旋转元数据的视频**（如 iPhone MOV 的 Display Matrix）→ 重编码 `libx264 -crf 23 -preset medium` + `aac 128k`，ffmpeg 内置 autorotation 把旋转**烘焙进像素**（否则 `-c copy` 只把旋转写成 TS 显示矩阵 SEI，hls.js/MSE 忽略导致视频旋转 90°）
- 其它（webm/vp9 等）→ 重编码 `libx264 -crf 23 -preset medium` + `aac 128k`
- 统一参数：`-f hls -hls_time 4 -hls_list_size 0 -hls_playlist_type vod -hls_segment_filename seg-%05d.ts index.m3u8`（VOD，全量保留分片）
- 每个 `hls/<name>/` 内写 `meta.json`（`{ version, size, rotation }`）；`/videos` 的 `hlsReady` 仅在分片存在 **且** 版本匹配 **且** 源文件大小一致时为真——版本升级或源文件变化会让所有资产自动重新生成（**每个变更都赋予所有资产**）
- 生成时机：上传完成 / 压缩后自动后台生成；**服务启动时扫描全部视频**，缺失或过期者后台补齐；删除视频同时删除 `hls/<name>/`；同一视频并发生成只跑一个 ffmpeg（in-flight 锁）
- m3u8 使用**相对分段名**（ffmpeg 在分段临时目录内运行），自动解析到 `/hls/<name>/` 下

前端：

- `public/vendor/hls.min.js`（hls.js 1.5.13，jsdelivr 下载）由 `index.html` 在 `/app.js` 前引入，**必须存在**，否则非 Safari 浏览器无法走 HLS（自动回退直连 mp4/webm）
- 仅中间副本且在缓存窗口内的视频挂 hls.js；leader `startLoad()`、非 leader `stopLoad()`（避免后台狂拉分片）
- hls.js 致命错误：网络错误重试 1 次 → 媒体错误 `recoverMediaError()` 1 次 → 仍失败则销毁实例并回退直连 mp4/webm（`_hlsFallback` 防重挂循环）
- Safari 原生 HLS：`NATIVE_HLS` 仅当 UA 为 Safari 且 `canPlayType('application/vnd.apple.mpegurl')` 为真（Chromium/Firefox/Edge 也报告 `maybe` 但无法播放，需用 UA 排除）
- **按钮位置**：视频卡片的「压缩 / 删除」按钮只在**设置页**（页 2）显示，信息页与中间 feed 保持干净；HLS 全自动、设置页也无「转HLS」按钮

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

> 说明：压缩在**上传前**于浏览器端完成，因此省的是**网络流量**（只传压缩后的小文件）；
> 视频卡片「压缩」按钮是**上传后**于服务端用 ffmpeg 转码为 H.264 MP4，用于已有大文件的瘦身。

---

## 前端交互（三页水平布局）

`public/index.html` 内 `#pages` 为 300% 宽 flex 容器，三个 `<section class="page">`
各占 1/3，通过 `transform: translateX(calc(-1 * var(--page) * 100% / 3))` 水平切换：

| 页 | 内容 | 手势 |
|----|------|------|
| 0 | 同一 feed + 右侧**播放信息面板**（文件名 / 大小 / 时间 / 进度 / 索引） | 从主 feed 右滑 |
| 1 | 纯视频 feed（默认页，顶部页点指示器） | 左右滑切页 |
| 2 | 同一 feed + 右侧**设置菜单**（视频数量 / 随机 / 自动播放 /「＋ 上传视频」/ 刷新）+ 右下角 `＋` 上传按钮 | 从主 feed 左滑 |

交互要点：

- **三页同步**：三个 feed 渲染同一份视频列表；任一 feed 滚动切换视频后，
  `syncFeeds()` 会把其余两页滚动到同一索引（`suppressScroll` 防止反馈循环）。
- **进度同步**：每个页面在当前索引各有一个 `<video>`，以**当前页**视频为 leader，
  每 500ms 将 leader 的 `currentTime` 同步到其余两页，保证切页后续播同一进度。
- **自动播放**：默认开启，只有当前页视频可出声（首次交互后取消静音），其余页静音播放。
- **播放/暂停**：点击当前视频卡片可切换全局播放/暂停。
- **随机播放**：设置页开关；关闭时前端按文件名排序，开启时使用服务端随机顺序。

---

## 日志规范

| 文件 | 内容 |
|------|------|
| `logs/start.log` | `user_start.sh` 启动日志 |
| `logs/run.log` | `server.js` 运行日志 |
| `logs/agent_tui.log` | Claude Ask 会话流水（问题 + 回答） |
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
- 更多容器部署细节参见 `hermit-container-debugging-guide.md`。
