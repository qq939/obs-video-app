#!/bin/bash
# 容器启动脚本：等待 server 就绪后 POST /hls/generate-all（顺序生成），再 exec node server.js
cd /home/agent/.claude/workspace/project
for i in $(seq 1 30); do
    curl -sf http://127.0.0.1:8082/health && break
    sleep 1
done
curl -sf -X POST http://127.0.0.1:8082/hls/generate-all || true
exec node server.js
