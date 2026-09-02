#!/usr/bin/env node
/**
 * /obs 文件管理接口验收测试（TDD）
 * 验证三点需求：
 *   1) GET /obs 返回文件列表 HTML 页面
 *   2) 上传文件后出现在列表中，且可通过相对路径 /obs/<name>?download=1 下载
 *   3) 下载响应带 Content-Disposition: attachment，内容一致
 *
 * 超时机制：单个 HTTP 请求 10s 超时；整体 30s 超时。
 */
const http = require('http');

const BASE = 'http://localhost';
const TEST_NAME = 'test_obs_e2e.txt';
const TEST_BODY = 'hello obs e2e';
const HTTP_TIMEOUT_MS = 10000;
const GLOBAL_TIMEOUT_MS = 30000;

let failures = 0;

function check(name, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' (' + detail + ')' : ''}`);
    if (!ok) failures += 1;
}

function request(method, path, body, headers = {}) {
    return new Promise((resolve) => {
        const url = new URL(path, BASE);
        const opts = {
            method,
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname + url.search,
            headers,
        };
        const req = http.request(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks),
            }));
        });
        req.on('error', (e) => resolve({ error: e.message }));
        req.setTimeout(HTTP_TIMEOUT_MS, () => { req.destroy(); resolve({ error: 'timeout' }); });
        if (body !== undefined) req.write(body);
        req.end();
    });
}

(async () => {
    const globalTimer = setTimeout(() => {
        console.error('FAIL - 整体测试超时（30s）');
        process.exit(1);
    }, GLOBAL_TIMEOUT_MS);

    // 0) 清理可能残留的测试文件
    await request('DELETE', `/obs/${TEST_NAME}`);

    // 1) GET /obs 返回 HTML 列表页
    const list1 = await request('GET', '/obs');
    check('GET /obs 返回 200', list1.status === 200, `status=${list1.status}`);
    const html = list1.body.toString('utf8');
    check('GET /obs 返回 HTML 页面', /<html/i.test(html) || /文件/i.test(html));

    // 2) 上传文件（相对路径 PUT /upload/<name>）
    const up = await request('PUT', `/upload/${encodeURIComponent(TEST_NAME)}`, TEST_BODY);
    check('PUT /upload/<name> 上传成功', up.status === 200 && /"ok":true/.test(up.body.toString('utf8')), `status=${up.status}`);

    // 3) 列表应包含上传的文件
    const list2 = await request('GET', '/obs');
    check('列表包含上传文件', list2.body.toString('utf8').includes(TEST_NAME));

    // 4) 下载：相对路径 + download=1
    const dl = await request('GET', `/obs/${encodeURIComponent(TEST_NAME)}?download=1`);
    const cd = (dl.headers['content-disposition'] || '');
    check('下载返回 200', dl.status === 200, `status=${dl.status}`);
    check('下载带 Content-Disposition: attachment', /attachment/i.test(cd), cd);
    check('下载内容一致', dl.body.toString('utf8') === TEST_BODY);

    // 5) 清理
    const del = await request('DELETE', `/obs/${TEST_NAME}`);
    check('DELETE 清理成功', del.status === 200, `status=${del.status}`);

    clearTimeout(globalTimer);
    console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
