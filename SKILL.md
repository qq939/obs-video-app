---
name: web-app-8082
description: 开发、测试、发现 bug、变更维护容器内 Web App 8082（OBS 视频上传 + Claude Ask Server）。涉及启动脚本、日志规范、Git 提交、/ask/claude 链路与 OBS 视频存储扩展。
---

# SKILL — Web App 8082 开发与运维

## 适用场景

在容器内开发/维护端口 8082 的 Web 应用时使用。覆盖：
- 启动脚本 `user_start.sh` 的创建与维护
- `server.js`（OBS 视频上传 + Claude Ask Server）的扩展
- 日志规范与 `agent_tui.log` 整理
- Git 提交与 `logs/commit.txt` 记录

## 关键事实

- **端口**：固定 `8082`，`server.js` 必须监听 `0.0.0.0`
- **项目目录**：`/home/agent/.claude/workspace/project`
- **当前 HEAD**：`main` → `c2fd1e0`（OBS + Claude Ask + HLS 全自动 + 旋转修复 + **4 MiB 段** + `maxBufferLength: 120` + `POST /hls/generate-all` 端点 + 启动脚本固化 HLS 生成 + 三页水平 + 抖音式纵向翻页 + 翻页阈值视口自适应 + **11 格 (uuid, t) 播放队列 + 实时 t 同步** + **长按视频 5x 加速** + **第 1 页 5x 倒放 + 第 2/3 页共享 8 档播放速度 (0.5/0.8/1/1.5/2/3/5/7)**；详情见 `logs/agent_tui.summary.md` 末尾「最后 3 轮对话总结」）
- **运行环境**：Node.js v20+（原生 `http`，无外部依赖）；claude CLI 位于 `/usr/local/bin/claude`；ffmpeg 5.1 位于 `/usr/bin/ffmpeg`
- **平台惯例**：全部在 `systemreadme.md`

## 启动脚本规范（user_start.sh）

1. 目录：`/home/agent/.claude/workspace/project/user_start.sh`
2. 容器启动时若存在且非空，会被 `start.sh` 自动执行
3. 必须：
   - 启动日志 → `logs/start.log`
   - Web App 运行日志 → `logs/run.log`
   - 用 `setsid`（非 nohup）拉起进程
   - 启动前 `pkill` 旧进程，避免端口冲突
   - 启动后做 `/health` 自检并写日志

```bash
#!/bin/bash
set -u
PROJECT_DIR="/home/agent/.claude/workspace/project"
LOG_DIR="${PROJECT_DIR}/logs"
mkdir -p "${LOG_DIR}"
ts() { date "+%Y-%m-%d %H:%M:%S"; }
echo "[$(ts)] begin" >> "${LOG_DIR}/start.log"
cd "${PROJECT_DIR}" || exit 1
pkill -f "node ${PROJECT_DIR}/server.js" 2>/dev/null && sleep 1
setsid node "${PROJECT_DIR}/server.js" >> "${LOG_DIR}/run.log" 2>&1 &
sleep 2
curl -s -m 3 http://localhost:8082/health >/dev/null 2>&1 \
  && echo "[$(ts)] health OK" >> "${LOG_DIR}/start.log" \
  || echo "[$(ts)] health FAIL" >> "${LOG_DIR}/start.log"
```

## /ask/claude 链路（勿打破）

```
/ask/claude → spawn node run_claude.js (env CLAUDE_MSG=base64)
            → claude --dangerously-skip-permissions --continue --print -
            → 问题/回答写入 logs/agent_tui.log
```

- **禁止**在 `/ask/claude` 中直接调用 `claude` CLI
- 参数识别：含空格或长度<50 → 普通文本；否则 base64
- 超时：60 分钟（`TIMEOUT_MS`）
- 主会话繁忙时二次调用会等待（会话锁），属预期行为

## OBS 视频存储功能（已实现）

`server.js` 现为 OBS 视频上传 / 播放服务，同时保留 `/ask/claude` 与 `/health`。

### 数据目录
- 视频存储：`obs/`（已加入 `.gitignore`，仅保留 `obs/.gitkeep`）
- 分片临时目录：`obs/.uploads/`（上传完成后自动清理）
- **`obs/` 是资产目录**：禁止删除/清空/写入测试文件。测试视频一律放 `/tmp`；测试上传 API 后立即删除测试文件。
- 前端：`public/`（`index.html` / `style.css` / `app.js`）

### 上传 API
| 接口 | 方法 | 说明 |
|------|------|------|
| `/upload/init` | POST | body `{filename,size,hash,chunkSize,totalChunks}` → `{uploadId,totalChunks,chunkSize,uploaded[]}`；已存在 → `{skip:true,url}`；有未完成会话 → `{resumed:true,uploaded[]}` |
| `/upload/chunk/:uploadId/:index` | PUT | 二进制分片，响应 `{ok,index,uploaded,total}` |
| `/upload/complete/:uploadId` | POST | 合并分片 + sha256 校验 → `{ok,url}` |
| `/upload/:filename` | PUT | 简单**流式**直传 → `{ok,url}` |
| `/obs/:filename` | GET/HEAD | HTTP Range 流式播放（206 / 416） |
| `/videos` | GET | → `{videos:[{name,size,mtime,url}]}`（Fisher–Yates 随机顺序） |
| `/obs/:filename` | DELETE | 删除视频 → `{ok}` |
| `/compress/:filename` | POST | ffmpeg 转码压缩为 H.264/AAC MP4（faststart）→ `{ok,skipped,before,after,saved,savedPct}` |

### 实现要点
- 分片大小前端 2MB，`/upload/init` 可自定义 `chunkSize`
- 断点续传：init 按 hash+filename 匹配未完成会话，返回 `uploaded[]`，客户端只传缺失分片
- 路径安全：`safeName()` 清洗文件名，拒绝 `..` / 目录穿越
- `/videos` 随机顺序：Fisher–Yates 洗牌，每次调用返回不同顺序
- 简单上传流式化：`req.pipe(ws)` 后必须等 `ws.on('finish')` 再 `rename`，否则 rename/stat 会与写盘竞态（WSL2 overlayfs 上表现为 500 ENOENT）
- 前端 sha256：`crypto.subtle` 仅 HTTPS/localhost 可用，LAN IP + HTTP 下为 undefined；
  `public/app.js` 内置纯 JS `sha256Hex()` 回退（填充长度公式 `((msgLen + 72) >> 6) << 6`）
- 静态资源响应加 `Cache-Control: no-cache`，前端修复能及时被浏览器拉取
- 前端 scroll-snap + IntersectionObserver 控制视频播放/暂停

### 视频压缩（/compress/:filename，ffmpeg）
- 环境已安装 ffmpeg 5.1（`/usr/bin/ffmpeg`），`server.js` 用 `child_process.spawn` 调用，无 npm 依赖
- 压缩参数（同 YouTube/抖音的浏览器兼容思路）：
  - `-c:v libx264 -crf 23 -preset medium`：H.264 编码，CRF 23 质量/体积平衡
  - `-pix_fmt yuv420p`：浏览器兼容像素格式
  - `-vf scale='min(1920,iw)':-2`：宽度上限 1920，高度按比例取偶数
  - `-c:a aac -b:a 128k`：AAC 音频
  - `-movflags +faststart`：moov 移到文件头，浏览器秒开（渐进播放关键）
- 压缩到 `obs/.uploads/.comp-*.mp4` 临时文件，成功且更小才 `rename` 覆盖原文件；若输出 ≥ 原文件则保留原文件并返回 `skipped:true`
- 前端：上传弹窗有「压缩后上传」勾选项（`#compressBeforeUpload`，默认勾选，浏览器端先压缩再上传）；**无视频卡片按钮**（按钮已移除，纯手势操作）
- 大视频压缩收益：1080p 高码率视频通常可省 30%+；已压缩的小视频会被 skip

### 压缩后上传（浏览器端先压缩，省网络流量）
- **逻辑**：「压缩后上传」是**上传前**在浏览器端把视频重编码为 webm（VP9/Opus）再上传，省的是**网络流量**；UI 已无「压缩」按钮（删除通过面板开关或服务端直接 `DELETE /video/:name`）。
- **实现**：`public/app.js` 的 `compressFileClient(file, onProgress)`——
  - 创建离屏 `<video>`（`position:fixed; width:2px; opacity:0`），`src = URL.createObjectURL(file)`，**`muted=false; volume=0`**（volume=0 绕过自动播放策略，且 `captureStream()` 仍录到完整音频——`muted=true` 会把录音静音）；
  - `await video.play()` 后 `video.captureStream()` + `MediaRecorder`（webm，`videoBitsPerSecond: 2_500_000`，`audioBitsPerSecond: 128_000`，`start(500)` 分片收集）；
  - 以 `currentTime/duration` 上报进度；`ended` 或兜底超时（duration+15s）后 `recorder.stop()`，合成 `Blob`；
  - 输出 `blob.size >= file.size` → 返回 `null`（回退直传原文件）；否则返回 `baseName.webm` 的 `File`；
  - 特性检测：`MediaRecorder` / `HTMLMediaElement.prototype.captureStream` / `isTypeSupported`（vp9→vp8→裸 webm），不支持或失败一律返回 `null` 回退。
- **startUpload 流程**：勾选时先 `compressFileClient`（进度条「浏览器转码 xx%」），有压缩结果就用 webm 上传、否则原文件（提示「未压缩」），再走原有 `uploadFile`（sha256→init→分片→complete）。
- 服务端无需改动：`VIDEO_EXTS` 与 MIME 已含 `.webm`/`video/webm`。
- 验证（`/tmp/verify_compress_before_upload.py`）：3.28MB mp4 → 存为 `cbt_src.webm`（1.33MB，省 59%），ffprobe 见 vp9+opus 双轨，`volumedetect` mean ≈ -21 dB（音频非静音）；取消勾选 → 原样传 mp4（`/tmp/verify_compress_unchecked.py`）。

### 前端三页水平架构 + 抖音式纵向翻页
- `<div id="pages">` 横向 300% 宽，包含 3 个 page：`#feed0`（信息页）/ `#feed1`（中间 feed）/ `#feed2`（设置页）
- 三页切换：`pagesEl.style.setProperty('--page', n)`，CSS `transform: translateX(calc(-1 * var(--page) * (100% / 3)))` + `transition: transform .35s`
- 中间 feed 内：`<div class="feed" id="mainFeed">` + 上传弹窗 + 视频容器 `#videoContainer` + 进度标签 `#seekLabel`

### 抖音式纵向翻页（手势驱动，无原生滚动）
- CSS 上 `.feed` 设 `overflow-y: hidden; touch-action: none`，移除 `scroll-snap` 相关属性，原生滚动完全由 JS 接管
- `vertFollow(dy)` 跟手：`scrollTop = vertBaseTop - dy` 实时映射拖拽位移
- `vertRelease(dy)` 松手吸附：`easeOutCubic` 动画到目标位置（`h * 0.25` 吸附距离），更新 `activeIndex`
- wheel 翻页：滚轮事件映射到上下翻页

### 横向翻页阈值（视口自适应 + 方向锁定 + 速度豁免）
- `SWIPE_THRESHOLD = Math.max(240, Math.round(window.innerWidth * 0.35))`（视口 1280 时 ≈ 448，相对视口自适应）
- `AXIS_LOCK_DIST = 18` + `axisLock` 状态变量（null | 'h' | 'v'）：touchmove/mousemove 中首次显著位移后锁定主轴，斜向/微抖不再误判横向
- `VELOCITY_THRESHOLD = 0.5` px/ms；`finishSwipe` 速度豁免：`|dx| >= 0.6 * 阈值` 且 `|dx|/dt > 0.5` 即翻页（快速轻扫仍可有意翻页）
- `touchstart` / `mousedown` 重置 `axisLock`
- 纵向吸附距离 `h * 0.25` 不变

### 播放窗口（前 5 + 当前 + 后 5，共 11 格）
- `WINDOW_SIZE = 11`；`playlistWindow` 数组
- `initPlaylistWindow()`：初始化 11 格窗口（前 5 按实际位置取，不足填 null，已见过不重复）
- `setPlaylistWindow(targetIdx)`：核心函数，把 `videos[targetIdx]` 放到窗口中间，前后各 5 格从 videos 实际位置取，超出部分 `randomFill()` 用 Fisher–Yates 从剩余池随机填充（池耗尽重新洗）
- `applyIndex(idx)` 调用 `setPlaylistWindow(targetIdx)`
- `renderFeeds` 渲染 `playlistWindow × FEED_COPIES`（共 33 格）
- `scrollToIndex` 固定到 `MIDDLE_CURRENT_TOP = WINDOW_SIZE + 5 = 16`（中间副本当前视频）
- `feedReady` 标志屏蔽初始化期间 scroll handler 误触发
- `syncAppState()` 暴露 `window._appState` / `_playlistWindow` / `_activeIndex` 供测试读取
- 调试教训：`initPlaylistWindow` 循环 `i <= 10` 误生成了 16 格（改为 `i <= 5`）；`IIFE` 局部变量无法从外部访问，改用 `window._playlistWindow` 暴露；scroll handler 在 `renderFeeds` 期间误调用 `applyIndex` 导致窗口变形，加 `feedReady` 标志解决

### 面板与播放
- 面板占半屏：`.side-panel { width: 50%; min-width: 240px }`；feed 偏移 `left/right: 50%`
- 信息面板（左）：文件名 / 大小 / 时间 / 进度 / 索引
- 设置面板（右）：视频数量 / 随机播放开关 / 自动播放开关 / 播放速度（0.5x / 1x / 1.5x / 2x / 3x，默认 1.5x）
- **纯手势操作**（无任何按钮）：
  - **长按空白处** → 打开上传弹窗（`#uploadModal`）
  - **左滑** → 打开信息面板；**右滑** → 打开设置面板
  - 视频点击 / 双击 / 拖动控制播放
  - 点击信息/设置面板外区域 → 关闭面板
- 上传弹窗：支持点击 / 拖拽选择文件，分片进度实时显示；默认「压缩后上传」勾选
- **进页即有声音 + 无感自动播放**：
  - 声音：**全程不禁音**（无任何 `muted=true`）。`updatePlayback()` 对 leader 直接 `muted=false` 后 `play()`；若浏览器自动播放策略拒绝（promise reject），视频保持暂停、等首个用户手势触发 `updatePlayback()` 再播。手势监听列表 = `['pointermove','wheel','scroll','touchmove','keydown']`（任一发生即 `{once:true}` 解锁）；**刻意避开 `touchstart/mousedown/pointerdown/click` 这类「按下」类事件**，因为移动鼠标 / 滚轮 / 触摸滑动这些高频事件就足以让浏览器判定为 user gesture —— 用户**不用点击屏幕**就能解锁播放
  - 无声泄漏：`updatePlayback()` 先遍历当前 feed，把除活动视频外**所有** `<video>` `pause()`（暂停即无声，无需 mute）
  - 位置缓存：`positions` Map（视频名 → 秒）。切走前 `recordActivePosition()` 记录；切回时若缓存存在且差距 >0.5s 则 `currentTime` 恢复（元数据未加载时用 `_pendingSeek` + `loadedmetadata` 事件延迟 seek）；`loadFeed()` 清空缓存
  - 按需缓存：`updateVideoCache()` 只对**当前活动视频**（`realIdx === activeIndex`）保留 `preload='metadata'`，其余全部 `preload='none'` + `pause()`，避免浏览器把整个 feed 都缓冲、也避免远处视频出声；hls.js 也只在活动视频上 attach（`manageHls` 用 `isActive` 而非 prev/next 窗口判断）

### 纵向无尽头滚动（3 副本 + 隐形回绕）
- `FEED_COPIES=3` DOM 副本存放 `playlistWindow` 渲染（11 × 3 = 33 格）
- 中间份为「真实」位置，`scrollToIndex` 定位到 `MIDDLE_CURRENT_TOP = WINDOW_SIZE + 5 = 16`
- 上/下滑到首尾都不会卡住，可无限循环
- 滚动进入前/后 ghost 副本时，立即 `scrollTop` 跳回中间份同一真实视频（内容相同，肉眼无跳变），并更新 `activeIndex`
- 顺序固定：`videos` 数组顺序浏览期间不变，上滑严格逆序回放刚才的视频（历史顺序），回绕后继续同一循环序列
- 程序化滚动抑制：`scrollToIndex` 给目标 feed 打 `_progScrollUntil`（60ms）时间戳，scroll 处理函数忽略该窗口内的自触发事件

## HLS 流式播放（已实现，详见 `logs/agent_tui.summary.md`）

> 2026-08-02 上午的三轮交互从 0 到 1 完成了 HLS 流式播放的实现；
> 实施方案整理在 `logs/agent_tui.summary.md` 末尾「最后 3 轮对话总结」。
> 关键要点摘录如下：

### 目标
- 服务端用 ffmpeg 为每个视频生成 HLS 流（`m3u8` + 4 秒 `.ts` 分片，VOD 模式）
- 前端用 hls.js（Chrome/Firefox）或原生 HLS（Safari）播放 m3u8
- 保留全部现有 OBS 上传/下载/list 接口
- 自动/惰性生成：**首启动补齐 + 上传/删除/压缩钩子 + 启动后台 sweep**，无任何手动按钮

### 路由（参考已丢的 `025b07f` 设计）
| 接口 | 方法 | 说明 |
|------|------|------|
| `/hls/:name/index.m3u8` | GET | 惰性生成 + Range；存在则直返 m3u8 |
| `/hls/:name/seg-NNNNN.ts` | GET | 严格正则防穿越 + Range |
| ~~`/hls/:name/generate`~~ | ~~POST~~ | **已移除**——全自动无手动触发 |

### 关键 ffmpeg 参数
- **段大小按字节切（最新）**：`ffmpeg -i input -c copy -f hls -hls_segment_size 52428800 -hls_list_size 0 -hls_playlist_type vod -hls_segment_filename seg-%05d.ts index.m3u8`（每段目标 50 MiB，GOP 对齐；ffmpeg 5.1.9+ 原生支持 `-hls_segment_size`，比 `-hls_time` 切段大很多）
- 无旋转 / h264 + aac/mp3 / `.mp4` 或 `.m4v` 容器 → `-c copy` **快速 remux，无损**
- 有旋转 / webm/vp9 / **`.mov` 或 `.mkv`** → 必须 `-c:v libx264 -c:a aac` 重编码
- `cwd` 设为 HLS 临时目录，分片名用相对路径

### 旋转 90° 根因与修复（核心 debug insight）
- **根因**：iPhone 拍摄的 `.mov` 通常带 Display Matrix（`stream_side_data.rotation = -90`）；`-c copy` remux 写到 TS 的 SEI 里，**hls.js/MSE 不解析 SEI**，原始像素按 1920x1440 横屏播出 → 看起来旋转 90°
- **检测**：`detectRotation(filePath)` 用 ffprobe 读 `stream_tags.rotate` 或 `side_data_list[].rotation`，归一化为 0/90/180/270
- **修复**：`canRemux(srcPath, codecs, rotation)` 在 `rotation !== 0` 时返回 false，强制走重编码 —— ffmpeg 默认解码阶段就自动转正，输出 1440x1920 竖屏，无旋转副作用数据

### `.mov` 播放不流畅
- QuickTime 容器常见问题：moov atom 不在头部（`-c copy` 输出仍是 non-faststart），codec tag 写法不标准；hls.js/MSE 读 TS 时遇到这些问题会卡顿
- 解决：`.mov` / `.mkv` 一律重编码为 H.264/AAC，不再走 `-c copy` remux 快速路径
- 前端 `<source type="video/quicktime">` 让浏览器原生支持 mov 直接播放（HLS 生成中或失败时的 fallback）

### 全自动 + meta.json 版本
- `HLS_GEN_VERSION = 3`（每次特性变更 +1，让所有资产自动重生成）
- 每个 `hls/<name>/meta.json` 存 `{version, size, mtime, rotation}`
- `hlsExists(name)` 校验：`index.m3u8` 存在 + `meta.version === HLS_GEN_VERSION` + `meta.size === srcSize`
- 启动时 `setImmediate` 扫描全部视频，缺失/过期者后台补齐
- **每日 UTC+8 05:00 cron**（server.js 进程内 `setInterval` 30 s 粒度，`lastCronKey` 防重入）：用 `Intl.DateTimeFormat({timeZone:'Asia/Shanghai'})` 在 UTC+8 时区判定小时分钟和日期 key，不污染全局 TZ；扫描 obs/，对没有当前版本 HLS 的视频后台补齐（容器无 crontab；进程内定时与 `user_start.sh` 重启同寿命）
- 路径：`hls/` 顶层独立目录（与 `obs/` 平级），不污染 `obs/`
- `.gitignore` 需包含 `hls/`

### 播放优先级（hls > obs）
- `<video>` 用 `<source>` 列表：第一个是 `/hls/<name>/index.m3u8`（`application/vnd.apple.mpegurl`，仅当 `v.hlsReady === true`），第二个是 `/obs/<name>`（按扩展名给正确 mime）
- 浏览器原生处理 fallback：m3u8 加载失败自动尝试下一个 source；hls.js attach 仍走 `manageHls()` 路径，错误回退由 `_hlsFallback` 标记防重挂
- `/videos` 接口返回 `{url, hls, hlsReady}`；前端直接据此决定 source 顺序

### 前端生命周期
- `public/vendor/hls.min.js`（hls.js 1.5.13，jsdelivr 下载）由 `index.html` 引入
- 只给 middle-copy 窗口内挂 hls.js，leader `startLoad()` / 非 leader `stopLoad()`
- 致命错误 retry 后回退直连 mp4/webm（`_hlsFallback` 防重挂）
- Safari 走原生 HLS（UA 判定，避免 Chromium 误判 `canPlayType` 黑屏）

### 验证脚本（已不存在于 /tmp，参考命令）
- `/tmp/verify_hls_server.py` — 服务端全链路（生成/MIME/Range/中文文件名/穿越/惰性重生成/删除清理）
- `/tmp/verify_hls_frontend_real.py` — 真实 hls.js MSE 播放（分片拉取、currentTime 前进）
- `/tmp/verify_hls_frontend_stub.py` — 生命周期边界、错误回退、Safari 原生
- `/tmp/verify_rotation_v3.py` — 旋转 27 项检查（IMG 1440x1920、2347 1920x1440、meta.json、惰性重生成）
- `/tmp/verify_rotation_v3_frontend.py` — 前端 12 项（无 hls 按钮、按钮位置、真实播放、无 generate-all）

## 日志整理流程

1. 读 `logs/agent_tui.log`，按时间戳分条
2. 解码其中 base64 内容（注意：终端换行可能损坏 base64，需清理空格后解码）
3. 归纳到 `logs/agent_tui.summary.md`：
   - 每条记录的时间、请求、响应、结论
   - 项目构建结构（目录树 + 链路图）
   - 最后 3 轮对话总结表

## Git 规范

```bash
git config --global --add safe.directory /home/agent/.claude/workspace/project  # 首次
git add .gitignore AGENTS.md SOUL.md USER.md TOOLS.md server.js public/ obs/.gitkeep systemreadme.md README.md SKILL.md  # 按需添加
git commit -m "描述本次变更"
git log --format="%h %s" -1 >> logs/commit.txt
```

- `run_claude.js` / `start.sh` / `user_start.sh` 为**平台文件**，**不要**加入 git 仓库
- `logs/`、`sessions/`、`obs/*` 已在 `.gitignore` 忽略
- 目录属主为 root，git 需 `safe.directory` 配置
- 文件系统大小写不敏感（README.md / Readme.md 为同一文件），勿重复创建

## 部署验证清单

- [ ] `/health` → OK
- [ ] `/` 返回前端页面，`/style.css`、`/app.js` 200 且响应带 `Cache-Control: no-cache`
- [ ] `POST /upload/init` + 分片 + `POST /upload/complete` 成功，sha256 一致
- [ ] 同名同 hash 再上传 → `skip:true`
- [ ] `PUT /upload/:filename` 简单流式上传 → 200 `{ok,url}`（勿出现 500 ENOENT）
- [ ] `GET /obs/:filename` 带 `Range` → 206，后缀 `bytes=-N` → 206，超界 → 416
- [ ] `DELETE /obs/:filename` → ok，删后 404
- [ ] `POST /compress/:filename` → 200 `{ok,before,after,savedPct}`，输出为 H.264 + faststart（moov 在 mdat 前）；已压缩的小视频 → `skipped:true`
- [ ] 路径穿越 `..%2F` → 404
- [ ] `node --check server.js public/app.js` 语法通过
- [ ] 前端三页 translateX 切换 + 中间抖音式纵向翻页（手跟踪 + 吸附 + wheel）+ 三页同步播放（`logs/run.log` 无报错）
- [ ] **永不静音**：进任意页拖拽滑动 → leader 始终有声音；侧页 3 倍速（页 0 倒退 / 页 2 前进）；位置缓存工作（离开再回来续播）
- [ ] 播放窗口 WINDOW_SIZE=11（`window._playlistWindow.length === 11`），空缺 Fisher–Yates 随机填充
- [ ] 横向翻页阈值视口自适应（1280 时 ≈ 448），方向锁定后斜向不再误翻页
- [ ] `logs/run.log` 有运行输出
