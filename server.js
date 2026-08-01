/**
 * OBS - Video Object Storage Web App
 * ===================================
 * Web app listening on port 8082 (bind 0.0.0.0).
 *
 * Main features:
 *   - Douyin/TikTok-style vertical video feed (frontend in public/)
 *   - Chunked upload with resume (init -> chunk* -> complete)
 *   - HTTP Range streaming for video playback (206 Partial Content)
 *   - Video list / delete
 *
 * Platform conventions (systemreadme.md):
 *   - Keep /ask/claude (calls run_claude.js) and /health endpoints.
 *   - Videos stored in obs/; upload temp data in obs/.uploads/.
 *   - Run log goes to logs/run.log (redirected by user_start.sh).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 8082;
const WORKSPACE_DIR = '/home/agent/.claude/workspace/project';
const OBS_DIR = path.join(WORKSPACE_DIR, 'obs');
const UPLOAD_DIR = path.join(OBS_DIR, '.uploads');
const PUBLIC_DIR = path.join(WORKSPACE_DIR, 'public');
const TIMEOUT_MS = 3600 * 1000;

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.ogv', '.mov', '.m4v', '.mkv']);
const MIME = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.mkv': 'video/x-matroska',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm'
};

// ---------------------------------------------------------------- helpers

function logLine(...args) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[${ts}]`, ...args);
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function sendText(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
}

function readBody(req, limit = 10 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) {
                req.destroy();
                reject(new Error('body too large'));
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/** Safe file name: strip path separators and traversal. */
function safeName(name) {
    if (!name) return null;
    let n = String(name).trim();
    n = n.split(/[\\/]/).pop();          // strip any directory part
    n = n.replace(/\.\./g, '').replace(/[\x00-\x1f]/g, '');
    if (!n || n === '.' || n === '..') return null;
    return n;
}

/** Validate uploadId: hex/timestamp style id. */
function isUploadId(id) {
    return /^[a-zA-Z0-9-]{8,64}$/.test(id || '');
}

function isChunkIndex(i, totalChunks) {
    return Number.isInteger(i) && i >= 0 && i < totalChunks;
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const s = fs.createReadStream(filePath);
        s.on('data', (d) => hash.update(d));
        s.on('end', () => resolve(hash.digest('hex')));
        s.on('error', reject);
    });
}

function listVideoFiles() {
    if (!fs.existsSync(OBS_DIR)) return [];
    const items = fs.readdirSync(OBS_DIR)
        .filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()) && !f.startsWith('.'))
        .map((name) => {
            const stat = fs.statSync(path.join(OBS_DIR, name));
            return { name, size: stat.size, mtime: stat.mtime, url: `/obs/${encodeURIComponent(name)}` };
        });
    // 随机顺序（Fisher–Yates）
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

// ------------------------------------------------------- upload operations

function initUpload(body) {
    const filename = safeName(body.filename);
    const size = Number(body.size);
    const hash = String(body.hash || '').toLowerCase();
    const chunkSize = Number(body.chunkSize) || 1024 * 1024;
    const totalChunks = Number(body.totalChunks) || Math.max(1, Math.ceil(size / chunkSize));
    if (!filename || !Number.isFinite(size) || size < 0) {
        return { error: { status: 400, msg: 'invalid filename/size' } };
    }
    const destPath = path.join(OBS_DIR, filename);
    // If a file with the same hash already exists, tell client to skip.
    if (hash && fs.existsSync(destPath)) {
        // Cheap check: if sizes match too, treat as already uploaded.
        if (fs.statSync(destPath).size === size) {
            return { skip: true, url: `/obs/${encodeURIComponent(filename)}` };
        }
    }

    // Resume support: if an in-progress session with the same hash+filename
    // exists, return it so the client can continue uploading missing chunks.
    if (fs.existsSync(UPLOAD_DIR)) {
        const entries = fs.readdirSync(UPLOAD_DIR);
        for (const id of entries) {
            const metaPath = path.join(UPLOAD_DIR, id, 'meta.json');
            if (!fs.existsSync(metaPath)) continue;
            try {
                const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                if (m.hash && m.hash === hash && m.filename === filename && m.size === size
                    && m.uploaded && m.uploaded.length < m.totalChunks) {
                    return { uploadId: m.uploadId, chunkSize: m.chunkSize, totalChunks: m.totalChunks, uploaded: m.uploaded, filename: m.filename, resumed: true };
                }
            } catch (e) { /* skip corrupt meta */ }
        }
    }

    const uploadId = crypto.randomBytes(8).toString('hex') + '-' + Date.now().toString(36);
    const dir = path.join(UPLOAD_DIR, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    const meta = { uploadId, filename, size, hash, chunkSize, totalChunks, uploaded: [] };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return { uploadId, chunkSize, totalChunks, uploaded: [], filename };
}

function saveChunk(uploadId, index, buf) {
    const dir = path.join(UPLOAD_DIR, uploadId);
    const metaPath = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) return { error: { status: 404, msg: 'upload not found' } };
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!isChunkIndex(index, meta.totalChunks)) return { error: { status: 400, msg: 'bad chunk index' } };
    const partPath = path.join(dir, `${index}.part`);
    fs.writeFileSync(partPath, buf);
    if (!meta.uploaded.includes(index)) meta.uploaded.push(index);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return { ok: true, index, uploaded: meta.uploaded.length, total: meta.totalChunks };
}

async function completeUpload(uploadId) {
    const dir = path.join(UPLOAD_DIR, uploadId);
    const metaPath = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) return { error: { status: 404, msg: 'upload not found' } };
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    // Check all chunks present
    for (let i = 0; i < meta.totalChunks; i++) {
        if (!fs.existsSync(path.join(dir, `${i}.part`))) {
            return { error: { status: 400, msg: `missing chunk ${i}` } };
        }
    }

    // Merge chunks -> obs/filename
    const destPath = path.join(OBS_DIR, meta.filename);
    const ws = fs.createWriteStream(destPath);
    for (let i = 0; i < meta.totalChunks; i++) {
        await new Promise((resolve, reject) => {
            const rs = fs.createReadStream(path.join(dir, `${i}.part`));
            rs.on('error', reject);
            rs.pipe(ws, { end: false });
            rs.on('end', resolve);
        });
    }
    await new Promise((resolve) => ws.end(resolve));

    // Verify sha256 if provided
    if (meta.hash) {
        const realHash = await sha256File(destPath);
        if (realHash !== meta.hash) {
            fs.unlinkSync(destPath);
            fs.rmSync(dir, { recursive: true, force: true });
            return { error: { status: 400, msg: 'sha256 mismatch' } };
        }
    }

    fs.rmSync(dir, { recursive: true, force: true });
    logLine(`upload complete: ${meta.filename} (${meta.size} bytes)`);
    return { ok: true, url: `/obs/${encodeURIComponent(meta.filename)}` };
}

// -------------------------------------------------------------- HTTP range

function streamFileWithRange(res, filePath, rangeHeader) {
    const stat = fs.statSync(filePath);
    const total = stat.size;
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

    let start = 0;
    let end = total - 1;

    if (rangeHeader) {
        const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        if (m) {
            if (m[1] !== '') start = parseInt(m[1], 10);
            if (m[2] !== '') end = parseInt(m[2], 10);
            if (m[1] === '' && m[2] !== '') {
                // suffix range: last N bytes
                const suffix = parseInt(m[2], 10);
                start = Math.max(0, total - suffix);
                end = total - 1;
            }
            if (start >= total || start > end) {
                res.writeHead(416, {
                    'Content-Range': `bytes */${total}`,
                    'Content-Type': mime
                });
                res.end();
                return;
            }
            end = Math.min(end, total - 1);
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${total}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1,
                'Content-Type': mime,
                'Cache-Control': 'no-cache'
            });
        } else {
            res.writeHead(200, {
                'Content-Length': total,
                'Content-Type': mime,
                'Accept-Ranges': 'bytes'
            });
        }
    } else {
        res.writeHead(200, {
            'Content-Length': total,
            'Content-Type': mime,
            'Accept-Ranges': 'bytes'
        });
    }

    fs.createReadStream(filePath, { start, end }).pipe(res);
}

// ----------------------------------------------------------------- ask/claude

function handleAsk(res, searchParams, bodyText) {
    let q = searchParams.get('q');
    if (!q && bodyText) {
        try { q = JSON.parse(bodyText).q; } catch (e) { /* ignore */ }
    }
    if (!q) return sendText(res, 400, 'Missing q parameter');

    let question;
    try {
        question = (q.includes(' ') || q.length < 50) ? decodeURIComponent(q) : Buffer.from(q, 'base64').toString('utf8');
    } catch (e) {
        return sendText(res, 400, 'Invalid encoding');
    }

    const systemPrompt = 'You are a helpful assistant. Answer the question concisely. Do not use markdown or formatting.';
    const fullMessage = `${systemPrompt}\n\n${question}`;
    const msgB64 = Buffer.from(fullMessage).toString('base64');
    logLine(`/ask/claude question: ${question.slice(0, 200)}`);

    const child = spawn('node', [path.join(WORKSPACE_DIR, 'run_claude.js')], {
        cwd: WORKSPACE_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ANTHROPIC_DISABLE_PREFLIGHT: '1', CLAUDE_CAPTURE_STDIO: '1', CLAUDE_MSG: msgB64 }
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) res.end(stdout.trim());
        else {
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
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
        res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Request timeout (60 minutes)');
    }, TIMEOUT_MS);

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
}

// ------------------------------------------------------------------ router

const server = http.createServer(async (req, res) => {
    res.setTimeout(TIMEOUT_MS, () => {
        res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Request timeout');
    });

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    const method = req.method || 'GET';

    try {
        // ---- health
        if (method === 'GET' && p === '/health') return sendText(res, 200, 'OK');

        // ---- platform: /ask/claude
        if ((method === 'GET' || method === 'POST') && p === '/ask/claude') {
            if (method === 'POST') {
                const body = await readBody(req, 2 * 1024 * 1024);
                return handleAsk(res, url.searchParams, body.toString('utf8'));
            }
            return handleAsk(res, url.searchParams, null);
        }

        // ---- upload init
        if (method === 'POST' && p === '/upload/init') {
            const bodyBuf = await readBody(req, 1024 * 1024);
            const body = JSON.parse(bodyBuf.toString('utf8') || '{}');
            const result = initUpload(body);
            if (result.error) return sendJson(res, result.error.status, { error: result.error.msg });
            return sendJson(res, 200, result);
        }

        // ---- chunk upload: PUT /upload/chunk/:uploadId/:index
        const chunkMatch = p.match(/^\/upload\/chunk\/([^/]+)\/(\d+)$/);
        if (method === 'PUT' && chunkMatch) {
            const uploadId = chunkMatch[1];
            const index = parseInt(chunkMatch[2], 10);
            if (!isUploadId(uploadId)) return sendJson(res, 400, { error: 'bad uploadId' });
            const buf = await readBody(req, 200 * 1024 * 1024);
            const result = saveChunk(uploadId, index, buf);
            if (result.error) return sendJson(res, result.error.status, { error: result.error.msg });
            return sendJson(res, 200, result);
        }

        // ---- complete: POST /upload/complete/:uploadId
        const completeMatch = p.match(/^\/upload\/complete\/([^/]+)$/);
        if (method === 'POST' && completeMatch) {
            const uploadId = completeMatch[1];
            if (!isUploadId(uploadId)) return sendJson(res, 400, { error: 'bad uploadId' });
            const result = await completeUpload(uploadId);
            if (result.error) return sendJson(res, result.error.status, { error: result.error.msg });
            return sendJson(res, 200, result);
        }

        // ---- simple upload: PUT /upload/:filename (streaming)
        const simpleMatch = p.match(/^\/upload\/(.+)$/);
        if (method === 'PUT' && simpleMatch) {
            const filename = safeName(simpleMatch[1]);
            if (!filename) return sendJson(res, 400, { error: 'invalid filename' });
            const tmpPath = path.join(UPLOAD_DIR, `.simple-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
            await new Promise((resolve, reject) => {
                const ws = fs.createWriteStream(tmpPath);
                req.pipe(ws);
                req.on('error', reject);
                ws.on('error', reject);
                // Wait for the stream to fully flush to disk before renaming,
                // otherwise the rename/stat can race with the in-flight write.
                ws.on('finish', resolve);
            });
            fs.renameSync(tmpPath, path.join(OBS_DIR, filename));
            const size = fs.statSync(path.join(OBS_DIR, filename)).size;
            logLine(`simple upload: ${filename} (${size} bytes)`);
            return sendJson(res, 200, { ok: true, url: `/obs/${encodeURIComponent(filename)}` });
        }

        // ---- video streaming: GET/HEAD /obs/:filename
        const obsMatch = p.match(/^\/obs\/(.+)$/);
        if ((method === 'GET' || method === 'HEAD') && obsMatch) {
            const filename = safeName(obsMatch[1]);
            if (!filename) return sendText(res, 400, 'invalid filename');
            const filePath = path.join(OBS_DIR, filename);
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                return sendText(res, 404, 'Not Found');
            }
            if (method === 'HEAD') {
                const stat = fs.statSync(filePath);
                res.writeHead(200, {
                    'Content-Length': stat.size,
                    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
                    'Accept-Ranges': 'bytes'
                });
                return res.end();
            }
            return streamFileWithRange(res, filePath, req.headers.range);
        }

        // ---- video list
        if (method === 'GET' && p === '/videos') {
            return sendJson(res, 200, { videos: listVideoFiles() });
        }

        // ---- delete: DELETE /obs/:filename
        if (method === 'DELETE' && obsMatch) {
            const filename = safeName(obsMatch[1]);
            if (!filename) return sendJson(res, 400, { error: 'invalid filename' });
            const filePath = path.join(OBS_DIR, filename);
            if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'Not Found' });
            fs.unlinkSync(filePath);
            logLine(`deleted: ${filename}`);
            return sendJson(res, 200, { ok: true });
        }

        // ---- static frontend from public/
        if (method === 'GET' || method === 'HEAD') {
            let rel = p === '/' ? '/index.html' : p;
            const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
            if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
                res.writeHead(200, { 'Content-Type': mime });
                if (method === 'HEAD') return res.end();
                return fs.createReadStream(filePath).pipe(res);
            }
        }

        return sendText(res, 404, 'Not Found');
    } catch (err) {
        logLine('error:', err.message);
        if (!res.headersSent) return sendJson(res, 500, { error: err.message });
        res.end();
    }
});

// Ensure dirs exist
fs.mkdirSync(OBS_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

server.listen(PORT, '0.0.0.0', () => {
    logLine(`OBS web app running on port ${PORT} (obs dir: ${OBS_DIR})`);
});
