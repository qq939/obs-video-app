#!/bin/bash
# 容器启动脚本：等待 server 就绪后 POST /hls/generate-all，日志写入 logs/server.log
cd /home/agent/.claude/workspace/project
mkdir -p logs

# 后台启动 server.js，stdout/stderr 重定向到日志文件
node server.js >> logs/server.log 2>&1 &
NODE_PID=$!

# 等待 server HTTP 200
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:8082/health > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

# 触发 HLS 顺序生成
curl -sf -X POST http://127.0.0.1:8082/hls/generate-all || true

# 保持容器运行（等待 node 退出）
wait $NODE_PID
