#!/usr/bin/env node
/**
 * 缓冲后自动播放验收测试（TDD）
 * 验证：切换视频源后，缓冲完成（canplay）时，如果 playing=true，自动调用 play()。
 *
 * 超时机制：整体 20s。
 */
const http = require('http');

const BASE = 'http://localhost';
const GLOBAL_TIMEOUT_MS = 20000;

let failures = 0;

function check(name, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' (' + detail + ')' : ''}`);
    if (!ok) failures += 1;
}

function request(path) {
    return new Promise((resolve) => {
        const url = new URL(path, BASE);
        const opts = { hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search };
        const req = http.get(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', (e) => resolve({ error: e.message }));
        req.setTimeout(10000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    });
}

(async () => {
    const timer = setTimeout(() => { console.error('FAIL - 整体超时（20s）'); process.exit(1); }, GLOBAL_TIMEOUT_MS);

    const app = await request('/app.js');
    check('GET /app.js 返回 200', app.status === 200, `status=${app.status}`);
    const src = app.body;

    // 1) canplay 监听器中检查 playing 状态并调用 play()
    // 必须是 addEventListener('canplay', ...) + if (playing) + video.play()
    // 使用 {0,500}? 而非 {1,500}?：CRLF 行尾时 \s\S 只匹配 \n，留 \r 不影响
    const hasCanplayPlay = /addEventListener\s*\(\s*['"]canplay['"][\s\S]{0,500}?if\s*\(\s*playing\s*\)[\s\S]{0,200}?play\s*\(/;
    check('canplay 监听器在 playing=true 时自动播放', hasCanplayPlay, hasCanplayPlay ? '' : '未找到 addEventListener(canplay) + playing + video.play()');

    clearTimeout(timer);
    console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
