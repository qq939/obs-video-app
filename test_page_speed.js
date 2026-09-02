#!/usr/bin/env node
/**
 * 页面倍速验收测试（TDD）
 * 验证：
 *   1) 第三页（page=2）：默认 3x 播放
 *   2) 第二页（page=1）：默认 1x 播放
 *
 * 超时机制：整体 20s 超时。
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
        const opts = {
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname + url.search,
        };
        const req = http.get(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', (e) => resolve({ error: e.message }));
        req.setTimeout(10000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    });
}

(async () => {
    const timer = setTimeout(() => {
        console.error('FAIL - 整体测试超时（20s）');
        process.exit(1);
    }, GLOBAL_TIMEOUT_MS);

    // 获取 app.js 源码，检测 applyPagePlayback 逻辑
    const app = await request('/app.js');
    check('GET /app.js 返回 200', app.status === 200, `status=${app.status}`);

    const src = app.body;

    // 检测 applyPagePlayback 中第三页 page === 2 时 playbackRate 设为 3（3x）
    // 实现方式：else if (currentPage === 2) { video.playbackRate = fastSpeed ? 5 : 3; }
    const hasPage2Speed3x = /currentPage\s*===\s*2[\s\S]{1,200}?playbackRate\s*=\s*fastSpeed\s*\?\s*5\s*:\s*3/.test(src);
    check('applyPagePlayback: page=2 时默认 3x', hasPage2Speed3x, hasPage2Speed3x ? '' : '未找到 currentPage===2 + playbackRate=...:3');

    // 检测 else 分支中 playbackRate = fastSpeed ? 5 : 1（第二页默认 1x）
    const hasPage1Speed1x = /else\s*\{[\s\S]{1,200}?playbackRate\s*=\s*fastSpeed\s*\?\s*5\s*:\s*1/.test(src);
    check('applyPagePlayback: page=1 时默认 1x', hasPage1Speed1x, hasPage1Speed1x ? '' : '未找到 else + playbackRate=...:1');

    clearTimeout(timer);
    console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
