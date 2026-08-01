/**
 * Claude Ask Server
 * -----------------
 * Web app listening on port 8082.
 *
 * Endpoints:
 *   GET|POST /ask/claude?q=<text or base64>  -> plain-text answer via run_claude.js
 *   GET|POST /ask/claude (json body {q, img}) -> plain-text answer (base64 supported)
 *   GET       /health                        -> "OK"
 *
 * Conventions (see systemreadme.md §14):
 *   - Must call run_claude.js, never call `claude` CLI directly.
 *   - Questions/answers are appended to logs/agent_tui.log by run_claude.js.
 *   - Bind to 0.0.0.0 so the host port mapping can reach it.
 *   - Run log goes to logs/run.log (redirected by user_start.sh).
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 8082;
const WORKSPACE_DIR = '/home/agent/.claude/workspace/project';
const TIMEOUT_MS = 3600 * 1000; // 60 minutes

function logLine(...args) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[${ts}]`, ...args);
}

function decodeQ(raw) {
    // Rule from systemreadme.md §14.2:
    //   - contains space OR length < 50  -> treated as plain/percent-encoded text
    //   - otherwise                      -> treated as base64
    if (raw.includes(' ') || raw.length < 50) {
        return decodeURIComponent(raw);
    }
    return Buffer.from(raw, 'base64').toString('utf8');
}

function handleAsk(req, res, searchParams, bodyText) {
    let q = searchParams.get('q');
    if (!q && bodyText) {
        try {
            const body = JSON.parse(bodyText);
            q = body.q;
        } catch (e) {
            // ignore, fall through
        }
    }
    if (!q) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Missing q parameter');
        return;
    }

    let question;
    try {
        question = decodeQ(q);
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid encoding');
        return;
    }

    const systemPrompt = 'You are a helpful assistant. Answer the question concisely. Do not use markdown or formatting.';
    const fullMessage = `${systemPrompt}\n\n${question}`;
    const msgB64 = Buffer.from(fullMessage).toString('base64');

    logLine(`/ask/claude question: ${question.slice(0, 200)}`);

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
    let settled = false;

    child.stdout.on('data', (data) => {
        stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
        stderr += data.toString();
    });

    child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(stdout.trim());
        } else {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(stderr.trim() || `Exit code: ${code}`);
        }
    });

    child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Spawn error: ${err.message}`);
    });

    const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        logLine('/ask/claude timeout, killing child');
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
        res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Request timeout (60 minutes)');
    }, TIMEOUT_MS);
}

const server = http.createServer((req, res) => {
    res.setTimeout(TIMEOUT_MS, () => {
        res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Request timeout (60 minutes)');
    });

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const method = req.method || 'GET';

    if ((method === 'GET' || method === 'POST') && url.pathname === '/ask/claude') {
        if (method === 'POST') {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
                if (body.length > 1024 * 1024) req.destroy();
            });
            req.on('end', () => handleAsk(req, res, url.searchParams, body));
        } else {
            handleAsk(req, res, url.searchParams, null);
        }
    } else if (method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('OK');
    } else if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Claude Ask Server</title></head>
<body>
<h1>Claude Ask Server</h1>
<p>Port 8082 is alive.</p>
<p>Try: <a href="/ask/claude?q=${encodeURIComponent('你好，请介绍一下自己')}">/ask/claude?q=你好</a></p>
<p>Health: <a href="/health">/health</a></p>
</body>
</html>`);
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    logLine(`Claude Ask Server running on port ${PORT}`);
});
