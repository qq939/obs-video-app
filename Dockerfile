FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/agent/.claude/workspace/project

COPY startup.sh /startup.sh
RUN chmod +x /startup.sh

COPY server.js ./server.js
COPY public ./public

RUN mkdir -p obs logs

EXPOSE 8082

# startup.sh 等待 server HTTP 200 后 POST /hls/generate-all（顺序生成 HLS），再 exec node server.js
CMD ["/startup.sh"]
