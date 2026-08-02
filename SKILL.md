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
- **运行环境**：Node.js v20+（原生 `http`，无外部依赖）；claude CLI 位于 `/usr/local/bin/claude`
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
| `/videos` | GET | → `{videos:[{name,size,mtime,url}]}` |
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
- 前端：每个视频卡片有「压缩」按钮（`v-compress`，服务端 ffmpeg 转码）；上传弹窗有「压缩后上传」勾选项（`#compressBeforeUpload`，默认勾选，浏览器端先压缩再上传）
- 大视频压缩收益：1080p 高码率视频通常可省 30%+；已压缩的小视频会被 skip

### 压缩后上传（浏览器端先压缩，省网络流量）
- **逻辑**：「压缩后上传」是**上传前**在浏览器端把视频重编码为 webm（VP9/Opus）再上传，省的是**网络流量**；视频卡片「压缩」按钮是**上传后**在服务端 ffmpeg 转码为 H.264 MP4，用于已有大文件瘦身。两者并存。
- **实现**：`public/app.js` 的 `compressFileClient(file, onProgress)`——
  - 创建离屏 `<video>`（`position:fixed; width:2px; opacity:0`），`src = URL.createObjectURL(file)`，**`muted=false; volume=0`**（volume=0 绕过自动播放策略，且 `captureStream()` 仍录到完整音频——`muted=true` 会把录音静音）；
  - `await video.play()` 后 `video.captureStream()` + `MediaRecorder`（webm，`videoBitsPerSecond: 2_500_000`，`audioBitsPerSecond: 128_000`，`start(500)` 分片收集）；
  - 以 `currentTime/duration` 上报进度；`ended` 或兜底超时（duration+15s）后 `recorder.stop()`，合成 `Blob`；
  - 输出 `blob.size >= file.size` → 返回 `null`（回退直传原文件）；否则返回 `baseName.webm` 的 `File`；
  - 特性检测：`MediaRecorder` / `HTMLMediaElement.prototype.captureStream` / `isTypeSupported`（vp9→vp8→裸 webm），不支持或失败一律返回 `null` 回退。
- **startUpload 流程**：勾选时先 `compressFileClient`（进度条「浏览器转码 xx%」），有压缩结果就用 webm 上传、否则原文件（提示「未压缩」），再走原有 `uploadFile`（sha256→init→分片→complete）。
- 服务端无需改动：`VIDEO_EXTS` 与 MIME 已含 `.webm`/`video/webm`。
- 验证（`/tmp/verify_compress_before_upload.py`）：3.28MB mp4 → 存为 `cbt_src.webm`（1.33MB，省 59%），ffprobe 见 vp9+opus 双轨，`volumedetect` mean ≈ -21 dB（音频非静音）；取消勾选 → 原样传 mp4（`/tmp/verify_compress_unchecked.py`）。

### 前端三页水平布局（CSS translateX）
- `#pages` 300% 宽 flex，三页各 1/3，`translateX(calc(-1 * var(--page) * 100% / 3))` 切页
- 页 0：feed + 播放信息面板；页 1：纯 feed（默认，页点指示器）；页 2：feed + 设置菜单 + `＋` 上传按钮（左下角）
- 三页共享同一视频列表；任一 feed 滚动后 `syncFeeds()` 同步其它两页滚动位置
- 每页在当前索引各有一个 `<video>`，以当前页为 leader，每 500ms 同步 `currentTime` 到其它两页（进度同步）
- 侧面板显隐：JS 静态设置 `pg.dataset.active = pg.dataset.page`，CSS 用 `[data-active="0"/"2"]` 显示面板并收窄 feed；面板镜像对称——页 0 播放信息面板在左、页 2 设置面板在右
- 切页手势：标准拖拽跟随（`dragOffset`），左滑→下一页（到设置页）、右滑→上一页（到信息页）；拖拽时禁用过渡实时跟手，松手恢复过渡并吸附（`finishSwipe`）；边缘（页 0 右滑 / 页 2 左滑）阻力 `dx/3` 防飞出
- 上传弹窗：设置页左下角 `＋`（`#uploadBtn`）**或设置菜单内 `#uploadPanelBtn`（「＋ 上传视频」）** → `#uploadModal`，支持点击 / 拖拽选择文件，分片进度实时显示
- **点视频回中间**：在侧面板页（页 0=播放信息 / 页 2=设置）视频只占一侧，点击可见视频区域 → `setPage(1)` 回到中间纯 feed 页并恢复播放（`handleTap` 中 `currentPage !== 1` 分支）
- **侧页 3 倍速快进/倒退**：切到左页（页 0 播放信息）视频 3 倍速倒退，切到右页（页 2 设置）3 倍速前进，中间页正常 1 倍速；Chrome/Safari 不支持负 `playbackRate`，倒退用 100ms 定时器手动 `currentTime -= 0.3`（≈3x）实现，前进用 `playbackRate = 3`；`updatePlayback()` 里按 `currentPage` 决定，切回中间页自动恢复
- **进页即有声音 + 滑走暂停/滑回续播**：
  - 声音：**全程不禁音**（无任何 `muted=true`）。`updatePlayback()` 对 leader 直接 `muted=false` 后 `play()`；若浏览器自动播放策略拒绝（promise reject），视频保持暂停、等首个用户手势（`touchstart/mousedown/pointerdown/click` 任一，once 监听）触发 `updatePlayback()` 再播——旧代码用 `userInteracted` 门控 + 只监听 `touchstart/click`，桌面鼠标拖拽滑动不触发 `click`，导致滑完仍无声
  - 无声泄漏：`updatePlayback()` 先遍历当前 feed，把除活动视频外**所有** `<video>` `pause()`（暂停即无声，无需 mute）；切走的上一个视频立即停声；非当前页的活动视频也保持暂停（仅 500ms 同步 `currentTime`）
  - 位置缓存：`positions` Map（视频名 → 秒）。`applyIndex()` 切走前 `recordActivePosition()` 记录当前位置；`updatePlayback()` 切回时若缓存存在且差距 >0.5s 则 `currentTime` 恢复（元数据未加载时用 `_pendingSeek` + `loadedmetadata` 事件延迟 seek，完成后删除缓存项）；`loadFeed()` 清空缓存
  - 缓存窗口：`updateVideoCache()` 只对 prev/current/next（环形）三个视频保留 `preload='metadata'`，其余全部 `preload='none'` + `pause()`，避免浏览器把整个 feed 都缓冲、也避免远处视频出声

### 纵向无尽头滚动（3 副本 + 隐形回绕）
- 每个 feed 渲染 `FEED_COPIES=3` 份视频列表（中间份为「真实」位置，`scrollToIndex` 定位到 `n + idx`），上/下滑到首尾都不会卡住，可无限循环
- 滚动进入前/后 ghost 副本（`vis < n` 或 `vis >= 2n`）时，立即 `scrollTop` 跳回中间份同一真实视频（内容相同，肉眼无跳变），并更新 `activeIndex`
- 顺序固定：`videos` 数组顺序浏览期间不变，上滑严格逆序回放刚才的视频（历史顺序），回绕后继续同一循环序列
- 程序化滚动抑制：`scrollToIndex` 给目标 feed 打 `_progScrollUntil`（60ms）时间戳，scroll 处理函数忽略该窗口内的自触发事件；不再用全局 `suppressScroll`，因此用户快速连续滑动源 feed 也能被处理、不会漏掉回绕

### HLS 流式播放（m3u8 + ts，ffmpeg + hls.js）
- **架构**：服务端 ffmpeg 生成 VOD 播放列表 + ts 分片（**独立 `hls/<name>/` 文件夹**，不污染 `obs/`），浏览器 hls.js（MSE）或 Safari 原生 HLS 播放；OBS 上传/下载/列表接口全部保留
- **ffmpeg 参数**：`-f hls -hls_time 4 -hls_list_size 0 -hls_playlist_type vod -hls_segment_filename seg-%05d.ts index.m3u8`；**必须在分段临时目录里以 `cwd` 运行**（`runFfmpeg` 支持 `opts.cwd`），否则 m3u8 会写绝对分段名
- **快速 remux vs 重编码**：ffprobe 探测首路 codec **和旋转**（`detectRotation`：`stream_tags=rotate` 或 `stream_side_data=rotation`，归一化到 0/90/180/270）；`h264 + (aac|mp3)` **且无旋转** → `-c copy`（不重编码、无质量损失）；**带旋转元数据的视频**（iPhone MOV 的 Display Matrix，ffprobe 报 `rotation:-90` 等）→ 强制重编码 `libx264 -crf 23 -preset medium -pix_fmt yuv420p -vf scale='min(1920,iw)':-2 -c:a aac -b:a 128k`——ffmpeg 默认 autorotation 在 `-vf` 前插入，把旋转**烘焙进像素**（`-c copy` 只把旋转写成 TS 显示矩阵 SEI，hls.js/MSE 忽略 → 视频旋转 90°）；webm/vp9/opus 等 → 同样重编码
- **in-flight 锁**：`hlsLocks` Map（name → Promise）去重，并发同视频只跑一个 ffmpeg；输出 `hls/.tmp-*` 成功后 rename 为 `hls/<name>/`；生成前/后检查源文件仍在（防删除竞态）；失败清理临时目录；`withTimeout(p, 60s)` 兜底；启动时 `mkdirSync(HLS_DIR)` + 清理遗留 `.tmp-*`；启动时顺带移除空的旧 `obs/.hls`（HLS 已迁到独立文件夹）
- **meta.json 版本标记（关键）**：每次生成在 `hls/<name>/meta.json` 写 `{ version: HLS_GEN_VERSION, size, mtime, rotation }`；`hlsExists(name)` 仅当 `index.m3u8` 存在 **且** `meta.version === HLS_GEN_VERSION` **且** `meta.size === 当前源文件 size` 时返回 true——**版本号一升，所有资产自动重新生成**（「每个变更都赋予所有资产」，无需任何按钮）
- **生成时机（全自动，无按钮）**：上传 complete / 简单上传成功后 fire-and-forget 后台生成；删除 → `invalidateHls`；压缩非 skipped → `invalidateHls` + 重新生成；**服务启动 `setImmediate` 扫描全部视频**，缺失/版本过期者后台补齐；`GET /hls/<name>/index.m3u8` 时源在而分片缺失/过期 → 惰性生成；**已删除手动接口** `POST /hls/generate-all` 与 `POST /hls/:name/generate`（返回 404）
- **/videos 附加字段**：`hls: "/hls/<enc(name)>/index.m3u8"`、`hlsReady: hlsExists(name)`（原字段不动）
- **/obs 解码修复**：`safeName(decodeURIComponent(...))`，否则中文/空格文件名的直连播放与 HLS 回退会 404
- **前端生命周期**（`attachHls`/`destroyHls`/`manageHls`）：
  - 只给 middle-copy（DOM 索引 `[n,2n)`）且在缓存窗口（diff≤1）的 item 挂 hls.js；ghost 副本与窗口外保持直连 src
  - leader（`pi===currentPage && i===n+activeIndex`）`startLoad()`，非 leader `stopLoad()`，避免后台狂拉分段
  - 致命错误：网络错误重试 1 次 → 媒体错误 `recoverMediaError()` 1 次 → 仍失败则 `destroy()` + `video.src=v.url` 直连 + `_hlsFallback` 防重挂循环
  - `manageHls()` 在 `updateVideoCache()` 末尾与 `setPage()`/`finishSwipe()` 中调用（覆盖 render/applyIndex/切页）
- **NATIVE_HLS 检测坑**：Chromium/Firefox/Edge 对 `canPlayType('application/vnd.apple.mpegurl')` 都返回 `'maybe'` 但**不能播**；必须用 Safari UA 判定：`_canNativeHls && /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent)`，否则 Chromium 会误走原生 HLS 而黑屏
- **vendor/hls.min.js**：必须存在于 `public/vendor/`（index.html 在 app.js 前引入）；缺失时 `HAS_HLSJS=false`，非 Safari 自动回退直连 mp4/webm；hls.min.js 的 UMD 会无条件覆盖 `window.Hls`，stub 测试需 `page.route("**/vendor/hls.min.js", abort)`
- **按钮位置（宿主要求）**：视频卡片的「压缩 / 删除」按钮只在**设置页**（页 2）显示——CSS `.page:not([data-page="2"]) .video-item .v-delete/.v-compress { display:none }`；中间 feed 与信息页无任何按钮。**HLS 无任何按钮**：单视频「转HLS」与「全部转HLS」均已移除（DOM 无 `.v-hls`、无 `#hlsAllBtn`、无 `.hls-all-btn`），生成全自动；`handleTap` 只排除 `.v-delete`/`.v-compress`
- **验证脚本**：`/tmp/verify_hls_server.py`（服务端全链路）、`/tmp/verify_hls_v2_server.py`（独立 hls/ 文件夹 + generate-all + 清理）、`/tmp/verify_hls_v2_frontend.py`（按钮位置 + 真实 hls.js 播放）、`/tmp/verify_hls_frontend_stub.py`（生命周期边界 / 错误回退 / Safari 原生）、`/tmp/verify_rotation_v3.py`（旋转修复：IMG_1370.mov 分片 1440x1920 扶正 + meta.json 版本 + 启动/惰性自动补齐 + 手动接口 404）、`/tmp/verify_rotation_v3_frontend.py`（无 HLS 按钮 + 按钮仅页 2 + hls.js 挂载 + 播放）；headless Chromium 需 `--autoplay-policy=no-user-gesture-required` 才允许自动播放

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
- [ ] `GET /hls/<name>/index.m3u8` → 200 `application/vnd.apple.mpegurl` + Range 206；`seg-*.ts` → 200 `video/mp2t` + Range 206
- [ ] `hls/<name>/` 有 `index.m3u8` + `seg-*.ts` + `meta.json`（`{version:2,size,rotation}`）（`obs/` 内无 `.hls`）；m3u8 含 `#EXT-X-PLAYLIST-TYPE:VOD` + `#EXT-X-ENDLIST` + 相对分段名（无绝对 URL）
- [ ] `/videos` 返回 `hls` + `hlsReady`；上传后 `hlsReady` 后台自动变 true；DELETE 后 `hls/<name>/` 同步删除
- [ ] **启动自动补齐**：删掉 `hls/<name>/` 后重启服务（或等 startup sweep），全部视频 `hlsReady` 自动恢复 true；`POST /hls/generate-all` 与 `POST /hls/:name/generate` 返回 404（已移除）
- [ ] **旋转修复**：带旋转元数据的视频（如 IMG_1370.mov，ffprobe `rotation:-90`）HLS 分片为竖屏 `1440x1920`（非旋转的 `1920x1440`）；`meta.json.rotation` 记录实际旋转值；无旋转视频走 `-c copy` 快速 remux
- [ ] `/hls` 路径穿越 `..%2F` → 400/404；非 `seg-\d+\.ts` 分段名 → 400/404
- [ ] 前端真实 hls.js：`window.Hls` 存在、`/hls/` 分片被拉取、`currentTime` 前进
- [ ] 前端按钮：页 0/1 无 `.v-delete`/`.v-compress`（display none），页 2 可见；DOM 中无 `.v-hls`、无 `#hlsAllBtn`、无 `.hls-all-btn`（HLS 全自动）
- [ ] 前端回退：hls.js 致命错误后 `video.src` 变回直连 mp4/webm、`_hlsFallback` 置位；Safari UA 下 `video.src` 以 `index.m3u8` 结尾
- [ ] 路径穿越 `..%2F` → 404
- [ ] `node --check server.js public/app.js` 语法通过
- [ ] 前端三页 translateX 切换 + 三页同步播放（`logs/run.log` 无报错）
- [ ] `logs/run.log` 有运行输出
