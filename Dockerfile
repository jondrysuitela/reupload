FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        ca-certificates \
        curl \
    && pip3 install --break-system-packages --no-cache-dir -U --pre "yt-dlp[default]" curl-cffi \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
ENV MAX_FILE_SIZE_MB=500
ENV ALLOWED_TIKTOK_ACCOUNTS=
ENV ALLOWED_TIKTOK_ACCOUNT=
ENV DOWNLOAD_TOKEN=
ENV FILE_TTL_HOURS=24

EXPOSE 8080

CMD ["node", "src/server.js"]
