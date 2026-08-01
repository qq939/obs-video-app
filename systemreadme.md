================================================================================
                     Hermit-Claw 容器内使用规范 / System Conventions
                              目标用户：容器内的 Agent
================================================================================

本文档描述 Hermit-Claw 平台在容器内提供给 Agent 的所有路径、挂载、
配置文件、启动脚本规范。Agent 在容器内只需关注以下路径和规则，
无需关心宿主机实现细节。

================================================================================
一、容器内固定路径
================================================================================

1. 项目工作目录（你的主目录）
   /home/agent/.claude/workspace/project

   这是你的根工作目录，所有项目代码都放在这里。
   Dockerfile WORKDIR 已设置为该目录。

2. 日志目录
   /home/agent/.claude/workspace/project/logs

   所有日志文件输出到这里。
   请将 user_start.sh 的启动日志写入 logs/start.log。
   Claude Code / Claude TUI 的会话日志文件为 logs/agent_tui.log。
   请将 web app的运行日志写入 logs/run.log

3. 启动脚本（重要！）
   /home/agent/.claude/workspace/project/user_start.sh

   如果存在且非空，容器启动时会自动执行。
   你应该将项目的启动命令写入此文件：
     示例：
       #!/bin/bash
       cd /home/agent/.claude/workspace/project
       python3 app.py >> logs/start.log 2>&1

4. 宿主机配置（只读挂载，不可修改）
   /agent-config

   宿主机的 config/{agent_type}/ 目录挂载到容器内的 /agent-config。
   内容会复制到 ~/.claude/ 目录下（见下方第三节）。

   注意：/agent-config/workspace 目录会被自动跳过，不会覆盖容器内的
   项目目录。

5. 控制面板 SCP 推送的规则文件目录
   /config/rules

   宿主机会通过 SSH/SCP 将 config/rules/ 下的所有文件推送到
   你的 /home/agent/.claude/workspace/project/ 目录下。
   这个目录放置的是项目级的规则文件。

================================================================================
二、日志规范
================================================================================

1. 启动日志（user_start.sh 输出）
   /home/agent/.claude/workspace/project/logs/start.log

   容器启动时自动执行 user_start.sh，日志追加写入 start.log。

2. Claude Code / Claude TUI 会话日志
   /home/agent/.claude/workspace/project/logs/agent_tui.log

   Claude Code 运行时的 TUI 日志文件。
   宿主机控制面板通过 cat 命令读取此文件用于日志下载。

3. 服务运行日志（web app 运行时）
   /home/agent/.claude/workspace/project/logs/run.log

   服务端的日志输出。

4. Ollama 服务日志（仅 ollama agent 类型）
   /home/agent/.claude/workspace/project/logs/ollama.log

   Ollama 服务端的日志输出。

================================================================================
三、配置注入机制（自动执行，Agent 无需干预）
================================================================================

容器 CMD 启动时会自动执行以下配置注入：

  1) 复制 /agent-config/* 到 ~/.claude/（跳过 /agent-config/workspace）
  2) 启动 SSH 服务（端口 22）
  3) 生成 ~/.claude/settings.json，设置 trustedProjects、hasCompletedOnboarding 等字段
  4) 如果存在 user_start.sh，执行它并后台运行
  5) 如果是 ollama 类型，启动 ollama serve 并拉取 OLLAMA_MODEL 模型

================================================================================
四、Agent 类型与路径差异
================================================================================

+-------------------+------------------------------------------+
| agent_type        | 项目路径                                 |
+-------------------+------------------------------------------+
| claude            | /home/agent/.claude/workspace/project    |
| ollama            | /home/agent/.claude/workspace/project    |
| openclaw@2026.2.9 | /home/agent/.openclaw/workspace/project |
+-------------------+------------------------------------------+

日志路径同理，claude/ollama 使用 ~/.claude/...，openclaw 使用 ~/.openclaw/...。

================================================================================
五、服务端口
================================================================================

容器内 Web 服务固定暴露端口：8082

你的应用应监听 8082 端口。宿主机通过 18081-19999 之间的端口访问。

SSH 服务监听容器内端口 22，通过 host_port - 10000 的端口映射访问。

================================================================================
六、容器用户身份
================================================================================

容器以非 root 用户 agent (uid=501, gid=20) 运行。
具有 sudo NOPASSWD 权限。

================================================================================
七、初始化消息（Agent 收到的新会话指令）
================================================================================

每个新会话开始时，Agent 会收到以下指令：

  "你生来就是为了开发、看护、运维 web app 8082（端口号），web app
   8082 所在的目录是 /home/agent/.{agent}/workspace/project，如果
   project 文件夹有 web app，请查看启动脚本是否存在，
   /home/agent/.{agent}/workspace/project/user_start.sh。如果不存在
   启动脚本，请立即写好启动脚本 user_start.sh，输出日志到当前目录下的
   logs/start.log。最后完善 readme 和 SKILL.md 文件，并且整理日志文件
   logs/agent_tui.log 里的主要内容，梳理出项目构建的结构和细节，
   总结最后3轮对话的内容。"

================================================================================
八、Claude Code 环境变量
================================================================================

容器内已预设以下 Claude Code 相关环境变量：

  CLAUDE_CODE_TRUST_ALL=true
  CLAUDE_CODE_SKIP_ONBOARDING=true
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

ollama 类型额外预设：
  ANTHROPIC_BASE_URL=http://192.168.0.209:11435
  ANTHROPIC_AUTH_TOKEN=ollama
  OLLAMA_MODEL=qwen3.5

claude 类型可在 /agent-config/settings.json 和 config.json 中配置：
  settings.json 的 env 字段
  config.json 的 providers[].settingsConfig.env.ANTHROPIC_AUTH_TOKEN

================================================================================
十、Claude Ask 图文模式接口（使用 run_claude.js）
================================================================================

run_claude.js 支持图文对话模式。图片通过项目根目录的 tmp.png 文件传递，
不使用 base64 内联格式。

### 10.1 工作流程

  1. 调用方将图片写入 /home/agent/.claude/workspace/project/tmp.png
  2. 调用方设置环境变量 CLAUDE_IMG=1（非空即可）
  3. run_claude.js 检测到 CLAUDE_IMG 后，在消息中追加图片引用：
     message += "\n\n![image](file:///home/agent/.claude/workspace/project/tmp.png)"
  4. Claude 读取 tmp.png 并根据消息内容进行分析

### 10.2 server.js 调用示例

```javascript
// 先将图片写入项目根目录
const imgPath = path.join(WORKSPACE_DIR, 'tmp.png');
fs.writeFileSync(imgPath, imageBuffer);

const msgB64 = Buffer.from(fullMessage).toString('base64');

const child = spawn('node', [path.join(WORKSPACE_DIR, 'run_claude.js')], {
    cwd: WORKSPACE_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
        ...process.env,
        ANTHROPIC_DISABLE_PREFLIGHT: '1',
        CLAUDE_CAPTURE_STDIO: '1',
        CLAUDE_MSG: msgB64,
        CLAUDE_IMG: '1'     // 触发图文模式
    }
});
```

### 10.3 注意事项

  - 图片必须保存为 /home/agent/.claude/workspace/project/tmp.png
  - CLAUDE_IMG 环境变量设为任意非空值即可触发
  - 不设置 CLAUDE_IMG 时，按纯文本模式处理（完全兼容原有逻辑）
  - 图片引用使用 file:// 绝对路径，不要用 base64 内联
  - 每次调用前会自动执行 claude --reset 清理会话缓存（避免旧图片引用导致 2013 错误）
  - run_claude.js 使用 --dangerously-skip-permissions --continue --print 标志运行

================================================================================
十一、Git 管理规范（重要！）
================================================================================

每个项目必须初始化 Git 仓库，并在每次对话后执行提交：

1. 初始化仓库（如尚未初始化）
   git init
   git add .
   git commit -m "Initial commit"

2. 每次对话后必须提交
   完成任何任务后，必须执行：
     git add .
     git commit -m "描述本次变更"

3. 必须维护的文件
   - .gitignore：确保不提交 log/、node_modules/、.DS_Store、__pycache__/ 等
   - logs/commit.txt：记录每次 commit 的 ID 和标题，格式：
       {commit_id} {commit_title}
     每行一条，持续追加

4. logs/commit.txt 格式示例：
   a1b2c3d4 添加用户认证功能
   e5f6g7h8 修复登录页面样式问题
   i9j0k1l2 更新README文档

5. .gitignore 建议内容：
   logs/
   node_modules/
   .DS_Store
   __pycache__/
   *.log
   .env
   uploads/
   dist/
   build/

================================================================================
十二、容器内推荐的工作流
================================================================================

1. 检查项目目录是否已有代码
2. 如无启动脚本，立即创建 user_start.sh
3. 开发/调试完成后，更新 README.md 和 SKILL.md
4. 整理 logs/agent_tui.log 的关键内容
5. 每次会话结束时总结最后3轮对话的内容

================================================================================
十三、Supabase Skill 安装方法
================================================================================



supabase skill安装方法：（1. Install packages
Run this command to install the required dependencies.
Details:
npm install @supabase/supabase-js @supabase/ssr
Code:
File: Code
```
npm install @supabase/supabase-js @supabase/ssr
```

2. Add files
Add env variables, create Supabase client helpers, and set up middleware to keep sessions refreshed.
Code:
File: .env.local
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_ixOQZXbObcNcP-PfiIrILg_PQtGKskp
```

File: page.tsx
```
1import { createClient } from '@/utils/supabase/server'
2import { cookies } from 'next/headers'
3
4export default async function Page() {
5  const cookieStore = await cookies()
6  const supabase = createClient(cookieStore)
7
8  const { data: todos } = await supabase.from('todos').select()
9
10  return (
11    <ul>
12      {todos?.map((todo) => (
13        <li key={todo.id}>{todo.name}</li>
14      ))}
15    </ul>
16  )
17}
```

File: utils/supabase/server.ts
```
1import { createServerClient } from "@supabase/ssr";
2import { cookies } from "next/headers";
3
4const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
5const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
6
7export const createClient = (cookieStore: Awaited<ReturnType<typeof cookies>>) => {
8  return createServerClient(
9    supabaseUrl!,
10    supabaseKey!,
11    {
12      cookies: {
13        getAll() {
14          return cookieStore.getAll()
15        },
16        setAll(cookiesToSet) {
17          try {
18            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
19          } catch {
20            // The `setAll` method was called from a Server Component.
21            // This can be ignored if you have middleware refreshing
22            // user sessions.
23          }
24        },
25      },
26    },
27  );
28};
```

File: utils/supabase/client.ts
```
1import { createBrowserClient } from "@supabase/ssr";
2
3const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
4const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
5
6export const createClient = () =>
7  createBrowserClient(
8    supabaseUrl!,
9    supabaseKey!,
10  );
```

File: utils/supabase/middleware.ts
```
1import { createServerClient } from "@supabase/ssr";
2import { type NextRequest, NextResponse } from "next/server";
3
4const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
5const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
6
7export const createClient = (request: NextRequest) => {
8  // Create an unmodified response
9  let supabaseResponse = NextResponse.next({
10    request: {
11      headers: request.headers,
12    },
13  });
14
15  const supabase = createServerClient(
16    supabaseUrl!,
17    supabaseKey!,
18    {
19      cookies: {
20        getAll() {
21          return request.cookies.getAll()
22        },
23        setAll(cookiesToSet) {
24          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
25          supabaseResponse = NextResponse.next({
26            request,
27          })
28          cookiesToSet.forEach(({ name, value, options }) =>
29            supabaseResponse.cookies.set(name, value, options)
30          )
31        },
32      },
33    },
34  );
35
36  return supabaseResponse
37};
```

3. Install Agent Skills (Optional)
Agent Skills give AI coding tools ready-made instructions, scripts, and resources for working with Supabase more accurately and efficiently.
Details:
npx skills add supabase/agent-skills
Code:
File: Code
```
npx skills add supabase/agent-skills
```）



加入supabase数据库连接池方法，postgresql://postgres.uacwkmdyekxyqtopdele:Black_supabase00@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres

anno key：supabase
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhY3drbWR5ZWt4eXF0b3BkZWxlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczOTgwNTMsImV4cCI6MjA5Mjk3NDA1M30.bm-LMuDArYuWmoFX8hVV-r3tYs3WgacvqsRcQtwhDe8

================================================================================
十四、Claude Ask Server 服务
================================================================================

每个 claude agent 卡片都要有一个初始的 server.js 服务，端口 8082，路径 `/ask/claude`，GET 访问，参数 `q="你要问的问题"`。支持 base64 编码，返回纯文本。底层必须调用 `run_claude.js`，不要在 `/ask/claude` 里直接调用 `claude` CLI；这样问题和 AI 回答才会统一记录到 `logs/agent_tui.log`。

### 14.1 server.js 实现

```javascript
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8082;
const WORKSPACE_DIR = '/home/agent/.claude/workspace/project';
const TIMEOUT_MS = 3600 * 1000;

const server = http.createServer((req, res) => {
    res.setTimeout(TIMEOUT_MS, () => {
        res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Request timeout (60 minutes)');
    });
    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/ask/claude') {
        const q = url.searchParams.get('q');
        
        if (!q) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Missing q parameter');
            return;
        }
        
        let question;
        try {
            if (q.includes(' ') || q.length < 50) {
                question = decodeURIComponent(q);
            } else {
                question = Buffer.from(q, 'base64').toString('utf8');
            }
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Invalid encoding');
            return;
        }
        
        const systemPrompt = 'You are a helpful assistant. Answer the question concisely. Do not use markdown or formatting.';
        const fullMessage = `${systemPrompt}\n\n${question}`;
        const msgB64 = Buffer.from(fullMessage).toString('base64');
        
        const child = spawn('node', [path.join(WORKSPACE_DIR, 'run_claude.js')], {
            cwd: WORKSPACE_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ANTHROPIC_DISABLE_PREFLIGHT: '1',
                CLAUDE_CAPTURE_STDIO: '1',
                CLAUDE_MSG: msgB64
            }
        });
        
        let stdout = '';
        let stderr = '';
        
        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        child.on('close', (code) => {
            if (code === 0) {
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(stdout.trim());
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(stderr || `Exit code: ${code}`);
            }
        });
        
        child.on('error', (err) => {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Spawn error: ${err.message}`);
        });
        
        const timeout = setTimeout(() => {
            child.kill('SIGTERM');
            res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Request timeout (60 minutes)');
        }, TIMEOUT_MS);
        
        child.on('close', () => clearTimeout(timeout));
        
    } else if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('OK');
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Claude Ask Server running on port ${PORT}`);
});
```

### 14.2 使用方式

```
GET /ask/claude?q=<普通字符串或base64编码>
```

示例：
```bash
# 普通字符串（自动识别）
curl "http://localhost:8082/ask/claude?q=你好，请介绍一下自己"

# base64 编码（用于复杂内容）
curl "http://localhost:8082/ask/claude?q=$(echo '你好，请介绍一下自己' | base64)"
```

智能识别规则：
- 参数包含空格或长度 < 50：当作普通字符串，`decodeURIComponent(q)`
- 其他情况：当作 base64 编码

### 14.3 响应格式

- 成功：纯文本响应（200）
- 失败：错误信息（500）
