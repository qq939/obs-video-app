#!/usr/bin/env node
/**
 * Docker 部署验收测试（TDD）
 * 验证三点需求：
 *   1) docker-compose.yml 配置了 restart（容器自动重启）
 *   2) 端口映射 80:8082
 *   3) 部署后 http://localhost/health 返回 OK
 *
 * 超时机制：单个 HTTP 请求 10s 超时；整体 30s 超时（防止脚本挂死）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const COMPOSE_PATH = path.join(__dirname, 'docker-compose.yml');
const HEALTH_URL = 'http://localhost/health';
const HTTP_TIMEOUT_MS = 10000;
const GLOBAL_TIMEOUT_MS = 30000;

let failures = 0;

function check(name, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' (' + detail + ')' : ''}`);
    if (!ok) failures += 1;
}

function requestHealth(url, timeoutMs) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: d.trim() }));
        });
        req.on('error', (e) => resolve({ error: e.message }));
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ error: 'timeout' }); });
    });
}

(async () => {
    const globalTimer = setTimeout(() => {
        console.error('FAIL - 整体测试超时（30s）');
        process.exit(1);
    }, GLOBAL_TIMEOUT_MS);

    // 1) 校验 docker-compose.yml
    const compose = fs.readFileSync(COMPOSE_PATH, 'utf8');

    const hasRestart = /restart:\s*(always|unless-stopped|on-failure)/.test(compose);
    check('docker-compose.yml 配置自动重启 (restart)', hasRestart);

    const portMatch = compose.match(/"(\d+):8082"/);
    check('端口映射 80:8082', !!portMatch && portMatch[1] === '80', portMatch ? portMatch[0] : 'none');

    // 2) 部署后健康检查
    const h = await requestHealth(HEALTH_URL, HTTP_TIMEOUT_MS);
    check('部署后 /health 返回 OK', h.status === 200 && h.body === 'OK', JSON.stringify(h));

    clearTimeout(globalTimer);
    console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
