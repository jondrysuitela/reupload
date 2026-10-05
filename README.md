# TikTok Downloader API

Docker-ready REST API for authorized TikTok reuploads.

## Scope

The default source account is `@wiwelgeng`. The API rejects other TikTok accounts.

Use only for content you are authorized to download/reupload.

## Local run

Requirements:
- Node.js 20+
- Python 3 + pip
- yt-dlp
- FFmpeg

```bash
npm install
set ALLOWED_TIKTOK_ACCOUNT=wiwelgeng
set DOWNLOAD_TOKEN=change-this
npm start
```

Health:
```bash
curl http://localhost:8080/health
```

Process:
```bash
curl -X POST http://localhost:8080/api/process ^
  -H "Content-Type: application/json" ^
  -H "x-download-token: change-this" ^
  -d "{\"url\":\"https://www.tiktok.com/@wiwelgeng/video/7667229966819527943\"}"
```

Poll:
```bash
curl -H "x-download-token: change-this" http://localhost:8080/api/jobs/JOB_ID
```

## Docker

Build for blitz.cloud (amd64):

```bash
docker build --platform linux/amd64 -t YOUR_DOCKERHUB_USER/tiktok-downloader:1.0.0 .
docker push YOUR_DOCKERHUB_USER/tiktok-downloader:1.0.0
```

Then in blitz.cloud choose **Host something new → An app that's already packaged up**, select the public image, and deploy it. blitz.cloud provides HTTPS automatically.

Set these environment variables:

- `ALLOWED_TIKTOK_ACCOUNT=wiwelgeng`
- `DOWNLOAD_TOKEN=<long random secret>`
- `FILE_TTL_HOURS=24`
- `MAX_FILE_SIZE_MB=500`

The free blitz.cloud plan supports public Docker images, HTTPS, 5 apps, 512 MB shared reserved memory, 10 GB storage, and does not require a credit card. Free apps sleep when idle and wake on the next visit.

## Automation scheduler

The scheduler runs in the same Node process as the HTTP API. It uses the enabled, explicitly configured TikTok source accounts and a bounded profile listing (`AUTOMATION_DISCOVERY_LIMIT`, default `20`, maximum `50` per source). Do not add accounts unless you are authorized to use their content.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTOMATION_ENABLED` | `false` | Start the daily scheduler when set to `true`. |
| `AUTOMATION_TIMEZONE` | `Asia/Jayapura` | Local timezone for scheduler dates and execution time. |
| `AUTOMATION_RUN_HOUR` | `10` | Daily pipeline execution hour, local to `AUTOMATION_TIMEZONE`. |
| `AUTOMATION_RUN_MINUTE` | `0` | Daily pipeline execution minute. |
| `AUTOMATION_DRY_RUN` | `false` | Prevent real publishing when set to `true`; dry-run is also enabled by `PUBLISHER_DRY_RUN=true`. |
| `MAX_POSTS_PER_RUN` | `1` | Maximum approved candidates selected by one run. |
| `MAX_POSTS_PER_DAY` | `1` | Maximum Metricool-confirmed scheduled/published posts in one local calendar day. |
| `DEFAULT_PUBLICATION_HOUR` | `19` | Fallback publication hour; this is not a Metricool recommendation. |
| `DEFAULT_PUBLICATION_MINUTE` | `0` | Fallback publication minute. |
| `AUTOMATION_SOURCES` | empty | Optional comma-separated source usernames; each is subject to the configured TikTok allowlist. |
| `AUTOMATION_DISCOVERY_LIMIT` | `20` | Maximum recent profile entries inspected per enabled source, capped at `50`. |
| `PUBLISHER_DRY_RUN` | `false` | Publisher-level safety switch. Keep `true` during validation. |
| `DOWNLOAD_TIMEOUT_MS` | `300000` | Timeout for the existing yt-dlp download and runner wait. |
| `PUBLIC_BASE_URL` | none | Required for publishing; public HTTPS base URL serving this app's `/api/video/:filename` files. |
| `MAX_FILE_SIZE_MB` | `500` | Maximum validated MP4 size. |

The pipeline execution schedule is separate from publication time. `BestPostingTimeProvider.getNextBestTime()` uses a Metricool lookup only when an implementation supplies data; otherwise it returns the configured fixed fallback with `recommended: false`. The fallback is not represented as an actual best-time recommendation.

`GET /api/automation/status` reports scheduler and pipeline state without credentials. `POST /api/automation/run` requires `x-download-token` and executes the same pipeline as the scheduled run. Scheduler state and per-video status, including the local-day count of successfully scheduled posts, are persisted in `DATA_DIR/automation.json` using atomic replacement. Keep `DATA_DIR` on persistent storage in Docker.

For approved videos, `AutomationRunner` reuses the existing yt-dlp downloader, waits up to `DOWNLOAD_TIMEOUT_MS`, validates the MP4 with `ffprobe`, generates the existing Indonesian caption, obtains a publication time from `BestPostingTimeProvider`, and calls the existing Metricool publisher. Review and skipped content never reaches download or publishing. The media URL is built only from `PUBLIC_BASE_URL`, which must be public HTTPS.

Only publisher-confirmed `SCHEDULED` or `PUBLISHED` results consume `MAX_POSTS_PER_DAY`. Dry-run results include a sanitized planned Facebook Page payload and remain `READY_TO_PUBLISH`; they do not consume the daily publishing quota or make an external Metricool request. `AUTOMATION_DRY_RUN=true` and `PUBLISHER_DRY_RUN=true` both prevent real publishing. Keep `PUBLISHER_DRY_RUN=true` during validation. Do not consider production publishing live until an authorized source allowlist, persistent volume, public HTTPS URL, and Metricool credentials have been deliberately configured and validated.
