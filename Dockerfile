FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/agent/.claude/workspace/project

COPY server.js ./server.js
COPY public ./public

RUN mkdir -p obs logs

EXPOSE 8082

CMD ["node", "server.js"]
