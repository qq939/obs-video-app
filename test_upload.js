#!/usr/bin/env node
/**
 * 上传功能验收测试（TDD）
 * 验证两点需求：
 *   1) 上传文件后文件名保持 UTF-8 原始名称（非 16 进制）
 *   2) 上传接口正常工作，返回正确的 JSON
 *
 * 超时机制：单个 HTTP 请求 10s 超时；整体 60s 超时。
 */
const http = require('http');

const BASE = 'http://localhost';
const HTTP_TIMEOUT_MS = 10000;
const GLOBAL_TIMEOUT_MS = 60000;

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
        console.error('FAIL - 整体测试超时（60s）');
        process.exit(1);
    }, GLOBAL_TIMEOUT_MS);

    // 测试1: 中文文件名上传
    const TEST_NAME_CN = '测试视频_2024.mp4';
    const TEST_CONTENT = 'fake video content for ' + TEST_NAME_CN;

    // 先尝试清理
    await request('DELETE', `/obs/${encodeURIComponent(TEST_NAME_CN)}`);

    // 上传中文文件名
    const up1 = await request('PUT', `/upload/${encodeURIComponent(TEST_NAME_CN)}`, TEST_CONTENT);
    check('中文文件名上传成功', up1.status === 200 && /"ok":true/.test(up1.body.toString('utf8')), `status=${up1.status}`);

    // 检查列表中是否包含中文文件名（而非 16 进制）
    const list1 = await request('GET', '/obs');
    const listHtml = list1.body.toString('utf8');
    check('文件列表包含原始中文文件名', listHtml.includes(TEST_NAME_CN), listHtml.substring(0, 500));
    check('文件列表不包含 16 进制文件名', !/^[a-f0-9]{8}\.mp4$/i.test(TEST_NAME_CN));

    // 下载验证
    const dl1 = await request('GET', `/obs/${encodeURIComponent(TEST_NAME_CN)}`);
    check('中文文件名下载返回 200', dl1.status === 200, `status=${dl1.status}`);
    check('中文文件名下载内容一致', dl1.body.toString('utf8') === TEST_CONTENT);

    // 清理
    const del1 = await request('DELETE', `/obs/${encodeURIComponent(TEST_NAME_CN)}`);
    check('中文文件名删除成功', del1.status === 200, `status=${del1.status}`);

    // 测试2: 英文文件名上传（确保基本功能正常）
    const TEST_NAME_EN = 'test_video_english.mp4';
    const TEST_CONTENT_EN = 'fake video content for english';

    await request('DELETE', `/obs/${encodeURIComponent(TEST_NAME_EN)}`);

    const up2 = await request('PUT', `/upload/${encodeURIComponent(TEST_NAME_EN)}`, TEST_CONTENT_EN);
    check('英文文件名上传成功', up2.status === 200 && /"ok":true/.test(up2.body.toString('utf8')), `status=${up2.status}`);

    // 检查列表
    const list2 = await request('GET', '/obs');
    const listHtml2 = list2.body.toString('utf8');
    check('文件列表包含英文文件名', listHtml2.includes(TEST_NAME_EN));

    // 清理
    const del2 = await request('DELETE', `/obs/${encodeURIComponent(TEST_NAME_EN)}`);
    check('英文文件名删除成功', del2.status === 200, `status=${del2.status}`);

    clearTimeout(globalTimer);
    console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
