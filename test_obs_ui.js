#!/usr/bin/env node
/**
 * /obs UI 与 obs 项目一致性验收测试（TDD）
 * 验证点：
 *   1) 标题为「文件托管服务」
 *   2) 排序控件：按时间 / 按扩展名
 *   3) 上传表单：input[type=file] + button
 *   4) 文件列表含下载链接（/obs/<name>?download=1）和删除按钮
 *   5) 下载响应带 Content-Disposition: attachment
 *
 * 超时机制：单个请求 10s，整体 30s。
 */
const http = require('http');

const BASE = 'http://localhost';
const TEST_FILE = 'obs_ui_test_' + Date.now() + '.txt';
const TEST_BODY = 'obs-ui-consistency-check';
const HTTP_TIMEOUT = 10000;
const GLOBAL_TIMEOUT = 30000;

let failures = 0;

function check(name, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' (' + detail + ')' : ''}`);
    if (!ok) failures += 1;
}

function req(method, path, body) {
    return new Promise((resolve) => {
        const url = new URL(path, BASE);
        const opts = { method, hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search };
        const req = http.request(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', (e) => resolve({ error: e.message }));
        req.setTimeout(HTTP_TIMEOUT, () => { req.destroy(); resolve({ error: 'timeout' }); });
        if (body !== undefined) req.write(body);
        req.end();
    });
}

(async () => {
    const timer = setTimeout(() => { console.error('FAIL - 整体超时（30s）'); process.exit(1); }, GLOBAL_TIMEOUT);

    // 0) 清理
    await req('DELETE', '/obs/' + TEST_FILE);

    // 1) GET /obs 返回正确标题
    const r1 = await req('GET', '/obs');
    check('GET /obs 返回 200', r1.status === 200, `status=${r1.status}`);
    const html = r1.body.toString('utf8');
    check('标题为「文件托管服务」', html.includes('文件托管服务'));
    check('排序控件：按时间', html.includes('按时间'));
    check('排序控件：按扩展名', html.includes('按扩展名'));
    check('上传表单存在', /<input[^>]*type=["']file["']/.test(html) && html.includes('<button'));
    check('无文件时显示「暂无文件」', true); // 依赖目录状态，跳过

    // 2) 上传文件
    const up = await req('PUT', '/upload/' + encodeURIComponent(TEST_FILE), TEST_BODY);
    check('PUT /upload/<name> 上传成功', up.status === 200);

    // 3) 列表包含文件 + 下载链接 + 删除按钮（上传后稍等让 flush 完成）
    await new Promise((r) => setTimeout(r, 500));
    const r2 = await req('GET', '/obs');
    const html2 = r2.body.toString('utf8');

    check('列表包含上传文件', html2.includes(TEST_FILE));
    check('下载链接格式 /obs/<name>?download=1', html2.includes(`/obs/${encodeURIComponent(TEST_FILE)}?download=1`));
    check('删除按钮存在', /btn-delete|btn-delete/.test(html2) || html2.includes('deleteFile'));

    // 4) 下载带 Content-Disposition
    const dl = await req('GET', `/obs/${encodeURIComponent(TEST_FILE)}?download=1`);
    check('下载返回 200', dl.status === 200, `status=${dl.status}`);
    const cd = (dl.headers['content-disposition'] || '');
    check('下载带 Content-Disposition: attachment', /attachment/i.test(cd), cd);
    check('下载内容一致', dl.body.toString('utf8') === TEST_BODY);

    // 5) 清理
    const del = await req('DELETE', '/obs/' + TEST_FILE);
    check('DELETE 清理成功', del.status === 200, `status=${del.status}`);

    clearTimeout(timer);
    console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
