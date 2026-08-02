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
// HLS output lives in its own top-level folder (sibling of obs/), so the
// generated m3u8 + ts files never pollute the obs/ video storage.
const HLS_DIR = path.join(WORKSPACE_DIR, 'hls');
const HLS_TIMEOUT_MS = 60 * 1000;

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.ogv', '.mov', '.m4v', '.mkv']);
const MIME = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.mkv': 'video/x-matroska',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t',
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

/**
 * Compress a video with ffmpeg into an H.264/AAC MP4 with the moov atom
 * moved to the front (+faststart). This is the same approach YouTube/Douyin
 * use for browser playback: broad codec compatibility + instant start.
 */
function runFfmpeg(args, opts = {}) {
    return new Promise((resolve, reject) => {
        const spawnOpts = { stdio: ['ignore', 'pipe', 'pipe'] };
        if (opts.cwd) spawnOpts.cwd = opts.cwd;
        const child = spawn('ffmpeg', args, spawnOpts);
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (err) => reject(new Error('ffmpeg not available: ' + err.message)));
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error('ffmpeg exit ' + code + ': ' + stderr.split('\n').slice(-3).join(' ').trim()));
        });
    });
}

async function compressVideo(filePath) {
    const before = fs.statSync(filePath).size;
    const tmpOut = path.join(UPLOAD_DIR, `.comp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`);
    const args = [
        '-y', '-i', filePath,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-vf', "scale='min(1920,iw)':-2",
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        tmpOut
    ];
    try {
        await runFfmpeg(args);
    } catch (e) {
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
        throw e;
    }
    const after = fs.statSync(tmpOut).size;
    if (after >= before) {
        // Compressed output isn't smaller (already well-compressed); keep original.
        fs.unlinkSync(tmpOut);
        return { skipped: true, before, after, saved: 0, savedPct: 0 };
    }
    fs.renameSync(tmpOut, filePath);
    return { skipped: false, before, after, saved: before - after, savedPct: Math.round((1 - after / before) * 100) };
}

// ---------------------------------------------------------------- HLS

function hlsExists(name) {
    return fs.existsSync(path.join(HLS_DIR, name, 'index.m3u8'));
}

function invalidateHls(name) {
    fs.rmSync(path.join(HLS_DIR, name), { recursive: true, force: true });
}

/** Probe the first video/audio codec of a media file via ffprobe. */
function detectCodecs(filePath) {
    return new Promise((resolve, reject) => {
        const child = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'stream=codec_type,codec_name',
            '-of', 'json',
            filePath
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => reject(new Error('ffprobe unavailable: ' + e.message)));
        child.on('close', (code) => {
            if (code !== 0) return reject(new Error('ffprobe failed: ' + err.split('\n').slice(-2).join(' ').trim()));
            try {
                const j = JSON.parse(out);
                let video = null, audio = null;
                for (const s of (j.streams || [])) {
                    if (s.codec_type === 'video' && !video) video = s.codec_name;
                    if (s.codec_type === 'audio' && !audio) audio = s.codec_name;
                }
                resolve({ video, audio });
            } catch (e) { reject(e); }
        });
    });
}

/** Fast path: source already H.264 + AAC/MP3 can be remuxed to TS without re-encoding. */
function canRemux({ video, audio }) {
    return video === 'h264' && (audio === 'aac' || audio === 'mp3');
}

/**
 * Build ffmpeg args. Runs with cwd=outDir so the playlist references relative
 * `seg-%05d.ts` names that resolve under /hls/<name>/ automatically.
 * VOD + hls_list_size 0 keeps ALL segments in the (finite) playlist.
 */
function buildHlsArgs(srcPath, codecs) {
    const mapV = ['-map', '0:v:0'];
    const mapA = codecs.audio ? ['-map', '0:a:0'] : [];
    const common = [
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '0',
        '-hls_playlist_type', 'vod',
        '-hls_segment_filename', 'seg-%05d.ts',
        'index.m3u8'
    ];
    if (canRemux(codecs)) {
        return ['-y', '-i', srcPath, ...mapV, ...mapA, '-c', 'copy', ...common];
    }
    // webm/ogv/mkv (VP9/VP8/Opus/AV1) and anything not H.264+AAC -> re-encode to H.264/AAC.
    const venc = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2"];
    const aenc = codecs.audio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an'];
    return ['-y', '-i', srcPath, ...mapV, ...mapA, ...venc, ...aenc, ...common];
}

function countSegments(dir) {
    try {
        return fs.readdirSync(dir).filter((f) => /^seg-\d+\.ts$/.test(f)).length;
    } catch (e) { return 0; }
}

// name -> in-flight generation Promise, so concurrent /hls requests for the
// same not-yet-generated video only run one ffmpeg.
const hlsLocks = new Map();

function generateHls(name) {
    if (hlsLocks.has(name)) return hlsLocks.get(name);
    const p = doGenerateHls(name).finally(() => hlsLocks.delete(name));
    hlsLocks.set(name, p);
    return p;
}

async function doGenerateHls(name) {
    const srcPath = path.join(OBS_DIR, name);
    if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
        throw new Error('source missing');
    }
    if (hlsExists(name)) return;

    const tmpDir = path.join(HLS_DIR, `.tmp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
        const codecs = await detectCodecs(srcPath);
        await runFfmpeg(buildHlsArgs(srcPath, codecs), { cwd: tmpDir });
        // Source may have been deleted while ffmpeg was running.
        if (!fs.existsSync(srcPath)) throw new Error('source deleted during hls generation');
        if (hlsExists(name)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });   // lost a race, keep existing
            return;
        }
        fs.rmSync(path.join(HLS_DIR, name), { recursive: true, force: true }); // clear stale
        fs.renameSync(tmpDir, path.join(HLS_DIR, name));
        logLine(`hls generated: ${name} (${countSegments(path.join(HLS_DIR, name))} segs)`);
    } catch (e) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw e;
    }
}

function withTimeout(p, ms) {
    return Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('hls generation timeout')), ms))
    ]);
}

function listVideoFiles() {
    if (!fs.existsSync(OBS_DIR)) return [];
    const items = fs.readdirSync(OBS_DIR)
        .filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()) && !f.startsWith('.'))
        .map((name) => {
            const stat = fs.statSync(path.join(OBS_DIR, name));
            return {
                name, size: stat.size, mtime: stat.mtime,
                url: `/obs/${encodeURIComponent(name)}`,
                hls: `/hls/${encodeURIComponent(name)}/index.m3u8`,
                hlsReady: hlsExists(name)
            };
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
            const fname = safeName(decodeURIComponent(result.url.replace(/^\/obs\//, '')));
            if (fname) generateHls(fname).catch((e) => logLine('hls bg gen failed:', e.message));
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
            generateHls(filename).catch((e) => logLine('hls bg gen failed:', e.message));
            return sendJson(res, 200, { ok: true, url: `/obs/${encodeURIComponent(filename)}` });
        }

        // ---- video streaming: GET/HEAD /obs/:filename
        const obsMatch = p.match(/^\/obs\/(.+)$/);
        if ((method === 'GET' || method === 'HEAD') && obsMatch) {
            let filename;
            try { filename = safeName(decodeURIComponent(obsMatch[1])); }
            catch (e) { return sendText(res, 400, 'invalid filename'); }
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
            let filename;
            try { filename = safeName(decodeURIComponent(obsMatch[1])); }
            catch (e) { return sendJson(res, 400, { error: 'invalid filename' }); }
            if (!filename) return sendJson(res, 400, { error: 'invalid filename' });
            const filePath = path.join(OBS_DIR, filename);
            if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'Not Found' });
            fs.unlinkSync(filePath);
            invalidateHls(filename);
            logLine(`deleted: ${filename}`);
            return sendJson(res, 200, { ok: true });
        }

        // ---- compress: POST /compress/:filename (H.264 faststart transcode)
        const compressMatch = p.match(/^\/compress\/(.+)$/);
        if (method === 'POST' && compressMatch) {
            const filename = safeName(compressMatch[1]);
            if (!filename) return sendJson(res, 400, { error: 'invalid filename' });
            const filePath = path.join(OBS_DIR, filename);
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                return sendJson(res, 404, { error: 'Not Found' });
            }
            logLine(`compress start: ${filename}`);
            const result = await compressVideo(filePath);
            logLine(`compress done: ${filename} ${result.before} -> ${result.after} bytes (${result.savedPct}% saved)`);
            if (!result.skipped) {
                invalidateHls(filename);
                generateHls(filename).catch((e) => logLine('hls regen after compress failed:', e.message));
            }
            return sendJson(res, 200, { ok: true, ...result });
        }

        // ---- HLS playlist (lazy generation): GET/HEAD /hls/:name/index.m3u8
        const hlsM3u8 = p.match(/^\/hls\/(.+)\/index\.m3u8$/);
        if ((method === 'GET' || method === 'HEAD') && hlsM3u8) {
            let name;
            try { name = safeName(decodeURIComponent(hlsM3u8[1])); }
            catch (e) { return sendText(res, 400, 'bad name'); }
            if (!name) return sendText(res, 400, 'invalid name');
            const srcPath = path.join(OBS_DIR, name);
            if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) return sendText(res, 404, 'Not Found');
            try {
                await withTimeout(generateHls(name), HLS_TIMEOUT_MS);
            } catch (e) {
                logLine('hls lazy gen:', e.message);
                return sendText(res, 404, 'HLS not ready');
            }
            const m3u8Path = path.join(HLS_DIR, name, 'index.m3u8');
            if (!fs.existsSync(m3u8Path)) return sendText(res, 404, 'HLS not available');
            if (method === 'HEAD') {
                const st = fs.statSync(m3u8Path);
                res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': 'application/vnd.apple.mpegurl' });
                return res.end();
            }
            return streamFileWithRange(res, m3u8Path, req.headers.range);
        }

        // ---- HLS segments: GET/HEAD /hls/:name/seg-NNNNN.ts
        const hlsSeg = p.match(/^\/hls\/(.+)\/(seg-\d+\.ts)$/);
        if ((method === 'GET' || method === 'HEAD') && hlsSeg) {
            let name;
            try { name = safeName(decodeURIComponent(hlsSeg[1])); }
            catch (e) { return sendText(res, 400, 'bad name'); }
            if (!name) return sendText(res, 400, 'invalid name');
            const seg = hlsSeg[2];
            const segPath = path.join(HLS_DIR, name, seg);
            if (!segPath.startsWith(path.join(HLS_DIR, name) + path.sep)) return sendText(res, 400, 'bad path');
            if (!fs.existsSync(segPath) || !fs.statSync(segPath).isFile()) return sendText(res, 404, 'Not Found');
            if (method === 'HEAD') {
                const st = fs.statSync(segPath);
                res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': 'video/mp2t', 'Accept-Ranges': 'bytes' });
                return res.end();
            }
            return streamFileWithRange(res, segPath, req.headers.range);
        }

        // ---- manual HLS generation: POST /hls/:name/generate
        const hlsGen = p.match(/^\/hls\/(.+)\/generate$/);
        if (method === 'POST' && hlsGen) {
            let name;
            try { name = safeName(decodeURIComponent(hlsGen[1])); }
            catch (e) { return sendJson(res, 400, { error: 'bad name' }); }
            if (!name) return sendJson(res, 400, { error: 'invalid name' });
            const srcPath = path.join(OBS_DIR, name);
            if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) return sendJson(res, 404, { error: 'Not Found' });
            try {
                const t0 = Date.now();
                await generateHls(name);
                logLine(`hls generate done: ${name} in ${Date.now() - t0}ms`);
                return sendJson(res, 200, { ok: true, name, hls: `/hls/${encodeURIComponent(name)}/index.m3u8` });
            } catch (e) {
                return sendJson(res, 500, { error: 'hls generation failed: ' + e.message });
            }
        }

        // ---- batch HLS generation: POST /hls/generate-all
        // Kicks off background generation for every video that does not have
        // HLS yet (the in-flight lock dedupes concurrent runs). Returns counts
        // immediately; the frontend polls /videos for hlsReady progress.
        if (method === 'POST' && p === '/hls/generate-all') {
            const items = listVideoFiles();
            let pending = 0;
            for (const it of items) {
                if (!hlsExists(it.name)) {
                    pending++;
                    generateHls(it.name).catch((e) => logLine('hls all gen failed:', e.message));
                }
            }
            logLine(`hls generate-all: ${items.length} total, ${pending} pending`);
            return sendJson(res, 200, { ok: true, total: items.length, pending });
        }

        // ---- static frontend from public/
        if (method === 'GET' || method === 'HEAD') {
            let rel = p === '/' ? '/index.html' : p;
            const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
            if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
                // no-cache: always revalidate so frontend fixes (e.g. app.js) reach users promptly
                res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
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
fs.mkdirSync(HLS_DIR, { recursive: true });
if (fs.existsSync(HLS_DIR)) {
    for (const f of fs.readdirSync(HLS_DIR)) {
        if (f.startsWith('.tmp-')) fs.rmSync(path.join(HLS_DIR, f), { recursive: true, force: true });
    }
}
// HLS used to live at obs/.hls; remove the legacy dir now that it is a
// separate top-level folder (only if it is empty — never delete user files).
const LEGACY_HLS = path.join(OBS_DIR, '.hls');
if (fs.existsSync(LEGACY_HLS)) {
    try {
        if (fs.readdirSync(LEGACY_HLS).length === 0) fs.rmdirSync(LEGACY_HLS);
    } catch (e) { /* ignore */ }
}

server.listen(PORT, '0.0.0.0', () => {
    logLine(`OBS web app running on port ${PORT} (obs dir: ${OBS_DIR})`);
});
