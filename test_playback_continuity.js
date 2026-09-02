#!/usr/bin/env node
/**
 * 播放连续性验收测试（TDD）
 * 验证：
 *   1) applyPagePlayback 中不调用 updatePlayback()（不打断播放）
 *   2) 第三页 playbackRate 默认 2x
 *   3) 第二页 playbackRate 默认 1x
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

    // 1) applyPagePlayback 中不调用 updatePlayback（不打断播放）
    // 检查 applyPagePlayback 函数体中是否不再调用 updatePlayback()
    const applySection = src.match(/function applyPagePlayback\(\)[\s\S]{1,800}?(?=\n\s*function|\n\s*\(function|\n\s*\/\/|\Z)/);
    const hasUpdatePlayback = applySection && /updatePlayback\s*\(/.test(applySection[0]);
    check('applyPagePlayback 不打断播放（不调用 updatePlayback）', !hasUpdatePlayback, hasUpdatePlayback ? '仍调用了 updatePlayback' : '');

    // 2) 第三页 page === 2 时 playbackRate 设为 2（2x）
    const page2Speed2x = /currentPage\s*===\s*2[\s\S]{1,200}?playbackRate\s*=\s*fastSpeed\s*\?\s*5\s*:\s*2/.test(src);
    check('applyPagePlayback: page=2 时默认 2x', page2Speed2x, page2Speed2x ? '' : '未找到 currentPage===2 + playbackRate=...:2');

    // 3) 第二页 playbackRate 默认 1x（else 分支或 page===1）
    const page1Speed1x = /else\s*\{[\s\S]{1,200}?playbackRate\s*=\s*fastSpeed\s*\?\s*5\s*:\s*1/.test(src);
    check('applyPagePlayback: page=1 时默认 1x', page1Speed1x, page1Speed1x ? '' : '未找到 else + playbackRate=...:1');

    clearTimeout(timer);
    console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
