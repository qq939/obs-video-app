#!/usr/bin/env node
/**
 * 滑动失败不暂停播放验收测试（TDD）
 * 验证：finishSwipe 中无论成功（return true）还是失败（return false）都调用 updatePlayback。
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

    // 检测 finishSwipe 函数体中：return false 前有 updatePlayback
    // 找 finishSwipe 开头，用下一个注释行作为函数结束标记（CRLF 兼容）
    const fnStart = src.indexOf('function finishSwipe(');
    check('找到 finishSwipe 函数', fnStart >= 0);
    if (fnStart >= 0) {
        // 函数结束：下一个顶层注释块（// ---- Douyin-style）
        const nextComment = src.indexOf('\n    // ---- Douyin-style', fnStart);
        const fnBody = src.substring(fnStart, nextComment > 0 ? nextComment : src.length);

        // 检查 if (Math.abs(dx) < SWIPE_THRESHOLD && !fast) { ... return false; } 分支内是否有 updatePlayback
        const failBranchMatch = fnBody.match(/if\s*\(\s*Math\.abs\(dx\)\s*<\s*SWIPE_THRESHOLD[\s\S]{0,400}?return\s+false\s*;/);
        const hasUpdateBeforeReturnFalse = failBranchMatch ? /updatePlayback\s*\(/.test(failBranchMatch[0]) : false;
        check('return false 前有 updatePlayback（滑动失败也触发播放）', hasUpdateBeforeReturnFalse, hasUpdateBeforeReturnFalse ? '' : '未找到');

        // 统计 updatePlayback 调用次数
        const count = (fnBody.match(/updatePlayback\s*\(/g) || []).length;
        check('finishSwipe 中至少有 1 次 updatePlayback', count >= 1, `实际=${count}`);
    }

    clearTimeout(timer);
    console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
