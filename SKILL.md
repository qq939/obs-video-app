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
- 前端：每个视频卡片有「压缩」按钮（`v-compress`）；上传弹窗有「上传后压缩」勾选项（`#compressAfterUpload`），上传完成自动转码
- 大视频压缩收益：1080p 高码率视频通常可省 30%+；已压缩的小视频会被 skip

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
- [ ] 前端三页 translateX 切换 + 三页同步播放（`logs/run.log` 无报错）
- [ ] `logs/run.log` 有运行输出
