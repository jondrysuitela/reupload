import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { parseTikTokUrl, isTikTokSourceAllowed, getAllowedTikTokAccounts } from "./services/tiktok.js";
import { classifyContent } from "./services/christian-filter.js";
import { generateCaption } from "./services/caption.js";
import { SourceRegistry } from "./services/source-registry.js";
import { FileKVStore } from "./services/persistent-store.js";
import { AutomationRunner } from "./services/automation-runner.js";
import { AutomationScheduler } from "./services/scheduler.js";
import { defaultBestPostingTimeProvider } from "./services/best-posting-time-provider.js";
import {
  buildMetricoolNativeVideoPayload,
  publishScheduledVideo,
  resolveHttpsUrl,
  shouldAllowPublish,
} from "./services/publisher.js";

const exec = promisify(execFile);
const app = express();

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || "/data";
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_MB || 500) * 1024 * 1024;
const FILE_TTL_HOURS = Number(process.env.FILE_TTL_HOURS || 24);
const ALLOWED_TIKTOK_ACCOUNTS = getAllowedTikTokAccounts(
  process.env.ALLOWED_TIKTOK_ACCOUNTS || process.env.ALLOWED_TIKTOK_ACCOUNT || ""
);
const configuredAutomationSources = (process.env.AUTOMATION_SOURCES || "")
  .split(",")
  .map((item) => item.trim().replace(/^@/, "").toLowerCase())
  .filter(Boolean)
  .filter((name) => ALLOWED_TIKTOK_ACCOUNTS.length === 0 || isTikTokSourceAllowed(name, ALLOWED_TIKTOK_ACCOUNTS));
const sourceRegistry = new SourceRegistry([
  ...ALLOWED_TIKTOK_ACCOUNTS.map((account) => ({ id: account, name: account, enabled: true, priority: 100 })),
  ...configuredAutomationSources.map((sourceName) => ({ id: sourceName, name: sourceName, enabled: true, priority: 90 })),
]);
const automationStore = new FileKVStore({ dataDir: DATA_DIR, namespace: "automation" });
const jobs = new Map();
const publishedJobs = new Map();
const publicationLocks = new Set();
const automationRunner = new AutomationRunner({
  registry: sourceRegistry,
  dataDir: DATA_DIR,
  store: automationStore,
  maxPostsPerRun: Number(process.env.MAX_POSTS_PER_RUN ?? 1),
  downloadVideo: (url, jobId, options) => downloadVideo(url, jobId, options),
  validateVideo: validateDownloadedVideo,
  maxFileSizeBytes: MAX_FILE_SIZE,
  downloadTimeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS || 300000),
  publicUrlBuilder: (filename) => {
    const configuredBaseUrl = String(process.env.PUBLIC_BASE_URL || "");
    if (!configuredBaseUrl) throw new Error("PUBLIC_BASE_URL must be configured for automated publishing");
    const baseUrl = new URL(configuredBaseUrl);
    if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password) {
      throw new Error("PUBLIC_BASE_URL must be HTTPS and must not contain credentials");
    }
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/api/video/${encodeURIComponent(filename)}`;
    baseUrl.search = "";
    baseUrl.hash = "";
    return resolveHttpsUrl(baseUrl.toString());
  },
  onJobUpdate: (job) => {
    const progress = {
      DISCOVERED: 10,
      ANALYZING: 20,
      APPROVED: 30,
      DOWNLOADING: 50,
      COMPLETED: 75,
      READY_TO_PUBLISH: 90,
      PUBLISHING: 95,
      SCHEDULED: 100,
      PUBLISHED: 100,
      FAILED: 0,
      PUBLISH_FAILED: 0,
    }[job.status] ?? 0;
    jobs.set(job.job_id, { ...job, progress });
  },
  publisherIdempotencyMap: publishedJobs,
  publicationLocks,
});
const automationFetcher = async (source) => {
  const username = String(source?.username || source?.name || source?.id || "").replace(/^@/, "").toLowerCase();
  if (!username || !sourceRegistry.getEnabledSources().some((item) => item.id === source.id)) return [];
  if (ALLOWED_TIKTOK_ACCOUNTS.length > 0 && !isTikTokSourceAllowed(username, ALLOWED_TIKTOK_ACCOUNTS)) {
    throw new Error("TikTok source is not in the configured authorization allowlist");
  }

  const limit = Math.min(Math.max(Number(process.env.AUTOMATION_DISCOVERY_LIMIT || 20), 1), 50);
  const { stdout } = await exec(
    "yt-dlp",
    [
      "--dump-single-json",
      "--flat-playlist",
      "--no-warnings",
      "--playlist-end",
      String(limit),
      "--impersonate",
      "chrome",
      `https://www.tiktok.com/@${username}`,
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 120000 }
  );
  const profile = JSON.parse(stdout);
  return (profile.entries || []).map((entry) => ({
    video_id: entry.id,
    title: entry.title || "",
    description: entry.description || "",
    username,
    author: profile.uploader || username,
    source_url: entry.webpage_url || entry.original_url || (String(entry.url || "").startsWith("https://")
      ? entry.url
      : `https://www.tiktok.com/@${username}/video/${entry.id}`),
  }));
};
const automationScheduler = new AutomationScheduler({
  runner: automationRunner,
  store: automationStore,
  enabled: process.env.AUTOMATION_ENABLED === "true",
  timezone: process.env.AUTOMATION_TIMEZONE || "Asia/Jayapura",
  hour: Number(process.env.AUTOMATION_RUN_HOUR ?? 10),
  minute: Number(process.env.AUTOMATION_RUN_MINUTE ?? 0),
  maxPostsPerDay: Number(process.env.MAX_POSTS_PER_DAY ?? 1),
  dryRun: process.env.AUTOMATION_DRY_RUN === "true" || process.env.PUBLISHER_DRY_RUN === "true",
  fetcher: automationFetcher,
});
const DOWNLOAD_TOKEN = process.env.DOWNLOAD_TOKEN || "";

await fs.mkdir(DATA_DIR, { recursive: true });
app.use(express.json({ limit: "1mb" }));

function auth(req) {
  if (!DOWNLOAD_TOKEN) return true;

  const supplied = String(req.get("x-download-token") || "");
  const expected = String(DOWNLOAD_TOKEN);
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);

  if (suppliedBuffer.length !== expectedBuffer.length) return false;

  try {
    return crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

function getPublicBaseUrl(req) {
  const forwardedProto = req.get("x-forwarded-proto");
  const proto = forwardedProto ? forwardedProto.split(",")[0].trim() : req.protocol;
  const forwardedHost = req.get("x-forwarded-host");
  const host = forwardedHost ? forwardedHost.split(",")[0].trim() : req.get("host");
  return `${proto}://${host}`;
}

function publicUrl(req, filename) {
  return `${getPublicBaseUrl(req)}/api/video/${encodeURIComponent(filename)}`;
}

async function ytdlpJson(url) {
  const { stdout } = await exec(
    "yt-dlp",
    [
      "--dump-single-json",
      "--no-warnings",
      "--skip-download",
      "--no-playlist",
      "--impersonate",
      "chrome",
      "--retries",
      "3",
      url,
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 120000 }
  );

  return JSON.parse(stdout);
}

async function downloadVideo(url, jobId, { timeoutMs = Number(process.env.DOWNLOAD_TIMEOUT_MS || 300000) } = {}) {
  const out = path.join(DATA_DIR, `${jobId}.%(ext)s`);
  for (const name of await fs.readdir(DATA_DIR).catch(() => [])) {
    if (name.startsWith(`${jobId}.`)) await fs.rm(path.join(DATA_DIR, name), { force: true });
  }
  try {
    await exec(
      "yt-dlp",
      [
        "--no-warnings",
        "--no-playlist",
        "--format",
        "bv*+ba/b",
        "--merge-output-format",
        "mp4",
        "--recode-video",
        "mp4",
        "--impersonate",
        "chrome",
        "--retries",
        "3",
        "--fragment-retries",
        "3",
        "--output",
        out,
        url,
      ],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }
    );
  } catch (error) {
    for (const name of await fs.readdir(DATA_DIR).catch(() => [])) {
      if (name.startsWith(`${jobId}.`)) await fs.rm(path.join(DATA_DIR, name), { force: true }).catch(() => {});
    }
    throw error;
  }

  const candidates = await fs.readdir(DATA_DIR);
  const file = candidates.find((item) => item.startsWith(`${jobId}.`) && item.endsWith(".mp4"));
  if (!file) throw new Error("Download completed but MP4 was not found");

  const fullPath = path.join(DATA_DIR, file);
  const stat = await fs.stat(fullPath);
  if (!stat.size) throw new Error("Downloaded file is empty");
  if (stat.size > MAX_FILE_SIZE) {
    await fs.rm(fullPath, { force: true });
    throw new Error("Video exceeds maximum allowed size");
  }

  return { filename: file, path: fullPath, size: stat.size };
}

async function validateDownloadedVideo(file, { maxFileSizeBytes = MAX_FILE_SIZE } = {}) {
  try {
    const filename = String(file?.filename || "");
    if (!filename || path.basename(filename) !== filename || !filename.toLowerCase().endsWith(".mp4")) {
      return { valid: false, error: "Downloaded filename is not a safe MP4 basename" };
    }
    const dataRoot = path.resolve(DATA_DIR);
    const fullPath = path.resolve(file.path || path.join(dataRoot, filename));
    const relativePath = path.relative(dataRoot, fullPath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return { valid: false, error: "Downloaded file path is outside DATA_DIR" };
    }

    const stat = await fs.lstat(fullPath);
    if (stat.isSymbolicLink()) return { valid: false, error: "Symbolic links are not valid downloaded media" };
    if (!stat.isFile() || stat.size <= 0) return { valid: false, error: "Downloaded MP4 is missing or empty" };
    if (stat.size > maxFileSizeBytes) return { valid: false, error: "Video exceeds maximum allowed size" };
    const { stdout } = await exec(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=format_name:stream=codec_type", "-of", "json", fullPath],
      { timeout: 15000, maxBuffer: 1024 * 1024 }
    );
    const probe = JSON.parse(stdout);
    const formats = String(probe?.format?.format_name || "").split(",");
    const hasVideo = (probe?.streams || []).some((stream) => stream.codec_type === "video");
    if (!hasVideo || !formats.some((format) => ["mp4", "mov"].includes(format))) {
      return { valid: false, error: "File is not a valid MP4 video" };
    }
    return { valid: true, filename, path: fullPath, size: stat.size };
  } catch (error) {
    return { valid: false, error: error.message || "MP4 validation failed" };
  }
}

function buildFilteredMetadata({ info, url, parsed, username }) {
  const sourceUsername = String(username || info?.uploader || parsed?.username || "").replace(/^@/, "").toLowerCase();
  const content = classifyContent({
    title: info?.title || "",
    description: info?.description || "",
    author: info?.uploader || "",
    username: sourceUsername,
  });

  return {
    success: true,
    platform: "tiktok",
    author: info?.uploader || parsed?.username || sourceUsername,
    username: sourceUsername || parsed?.username || null,
    title: info?.title || "",
    duration: info?.duration || 0,
    thumbnail: info?.thumbnail || null,
    video_id: info?.id || parsed?.videoId || null,
    source_url: url,
    content_category: content.category,
    christian_score: content.score,
    filter_status: content.status,
    filter_reason: content.filter_reason,
    source_account: sourceUsername || parsed?.username || null,
  };
}

app.get("/health", async (_req, res) => {
  res.json({ status: "ok", service: "tiktok-downloader", version: "1.0.0" });
});

app.post("/api/metadata", async (req, res) => {
  try {
    if (!auth(req)) return res.status(401).json({ success: false, error: "Unauthorized" });

    const { url } = req.body || {};
    const parsed = parseTikTokUrl(url);
    const info = await ytdlpJson(url);
    const username = String(info?.uploader || parsed.username || "").replace(/^@/, "").toLowerCase();

    if (ALLOWED_TIKTOK_ACCOUNTS.length > 0 && !isTikTokSourceAllowed(username, ALLOWED_TIKTOK_ACCOUNTS)) {
      return res.status(403).json({ success: false, error: "Unauthorized TikTok source account" });
    }

    const payload = buildFilteredMetadata({ info, url, parsed, username });
    res.json(payload);
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    if (!auth(req)) return res.status(401).json({ success: false, error: "Unauthorized" });

    const { url } = req.body || {};
    const parsed = parseTikTokUrl(url);
    const info = await ytdlpJson(url);
    const username = String(info?.uploader || parsed.username || "").replace(/^@/, "").toLowerCase();

    if (ALLOWED_TIKTOK_ACCOUNTS.length > 0 && !isTikTokSourceAllowed(username, ALLOWED_TIKTOK_ACCOUNTS)) {
      return res.status(403).json({ success: false, error: "Unauthorized TikTok source account" });
    }

    const content = classifyContent({
      title: info?.title || "",
      description: info?.description || "",
      author: info?.uploader || "",
      username,
    });

    res.json({
      success: true,
      source: {
        username,
        author: info?.uploader || parsed.username || username,
        source_url: url,
      },
      content: {
        category: content.category,
        score: content.score,
        status: content.status,
        reason: content.filter_reason,
      },
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post("/api/process", async (req, res) => {
  try {
    if (!auth(req)) return res.status(401).json({ success: false, error: "Unauthorized" });

    const { url } = req.body || {};
    const parsed = parseTikTokUrl(url);
    const info = await ytdlpJson(url);
    const username = String(info?.uploader || parsed.username || "").replace(/^@/, "").toLowerCase();

    if (ALLOWED_TIKTOK_ACCOUNTS.length > 0 && !isTikTokSourceAllowed(username, ALLOWED_TIKTOK_ACCOUNTS)) {
      return res.status(403).json({ success: false, error: "Unauthorized TikTok source account" });
    }

    const content = classifyContent({
      title: info?.title || "",
      description: info?.description || "",
      author: info?.uploader || "",
      username,
    });

    const jobId = crypto.randomUUID();
    const metadata = {
      job_id: jobId,
      status: content.status === "SKIPPED" ? "SKIPPED" : "DISCOVERED",
      progress: content.status === "SKIPPED" ? 0 : 20,
      platform: "tiktok",
      title: info?.title || "",
      author: info?.uploader || parsed.username || username,
      username,
      duration: info?.duration || 0,
      video_id: info?.id || parsed.videoId || null,
      source_url: url,
      source_account: username,
      content_category: content.category,
      christian_score: content.score,
      filter_status: content.status,
      filter_reason: content.filter_reason,
      thumbnail: info?.thumbnail || null,
    };

    jobs.set(jobId, metadata);

    if (content.status === "SKIPPED") {
      return res.status(202).json({
        success: true,
        job_id: jobId,
        status: "SKIPPED",
        platform: "tiktok",
        author: metadata.author,
        title: metadata.title,
        content_category: content.category,
        christian_score: content.score,
        filter_status: content.status,
        filter_reason: content.filter_reason,
      });
    }

    if (content.status === "REVIEW") {
      jobs.set(jobId, {
        ...metadata,
        status: "REVIEW",
        progress: 40,
        content_category: content.category,
        christian_score: content.score,
        filter_status: content.status,
        filter_reason: content.filter_reason,
      });

      return res.status(202).json({
        success: true,
        job_id: jobId,
        status: "REVIEW",
        platform: "tiktok",
        author: metadata.author,
        title: metadata.title,
        content_category: content.category,
        christian_score: content.score,
        filter_status: content.status,
        filter_reason: content.filter_reason,
      });
    }

    jobs.set(jobId, {
      ...metadata,
      status: "ANALYZING",
      progress: 35,
      content_category: content.category,
      christian_score: content.score,
      filter_status: content.status,
      filter_reason: content.filter_reason,
    });

    const jobPayload = {
      success: true,
      job_id: jobId,
      status: "APPROVED",
      platform: "tiktok",
      author: metadata.author,
      username,
      title: metadata.title,
      duration: metadata.duration,
      video_id: metadata.video_id,
      content_category: content.category,
      christian_score: content.score,
      filter_status: content.status,
      filter_reason: content.filter_reason,
      source_account: username,
    };

    res.status(202).json(jobPayload);

    jobs.set(jobId, {
      ...metadata,
      status: "DOWNLOADING",
      progress: 60,
      content_category: content.category,
      christian_score: content.score,
      filter_status: content.status,
      filter_reason: content.filter_reason,
    });

    downloadVideo(url, jobId)
      .then(async (file) => {
        const caption = generateCaption({ title: info?.title || "", author: metadata.author, category: content.category });
        const bestPostingTime = await defaultBestPostingTimeProvider.getNextBestTime({
          timezone: process.env.METRICOOL_TIMEZONE || process.env.AUTOMATION_TIMEZONE || "Asia/Jayapura",
        });
        const publicVideoUrl = resolveHttpsUrl(publicUrl(req, file.filename));
        const metricoolPayload = buildMetricoolNativeVideoPayload({
          videoUrl: publicVideoUrl,
          caption,
          brandId: process.env.METRICOOL_BRAND_ID || "7241347",
          bestPostingTime: bestPostingTime.best_posting_datetime,
          timezone: process.env.METRICOOL_TIMEZONE || "Asia/Jayapura",
        });

        jobs.set(jobId, {
          ...metadata,
          status: "READY_TO_PUBLISH",
          progress: 100,
          filename: file.filename,
          size: file.size,
          download_url: publicVideoUrl,
          caption,
          metricool: metricoolPayload,
          best_posting_time: bestPostingTime,
          content_category: content.category,
          christian_score: content.score,
          filter_status: content.status,
          filter_reason: content.filter_reason,
        });
      })
      .catch((error) => {
        jobs.set(jobId, {
          ...metadata,
          status: "FAILED",
          progress: 0,
          error: error.message,
        });
      });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.get("/api/jobs/:id", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "Job not found (or server restarted)" });

  const result = { ...job };
  if (job.download_url) result.download_url = job.download_url;
  if (job.filename && (job.status === "READY_TO_PUBLISH" || job.status === "COMPLETED")) {
    result.download_url = resolveHttpsUrl(publicUrl(req, job.filename));
  }

  res.json(result);
});

app.get("/api/automation/status", async (_req, res) => {
  try {
    const catalog = sourceRegistry.listSources();
    const records = await automationStore.list();
    const enabled = catalog.filter((source) => source.enabled !== false);

    res.json({
      success: true,
      sources: catalog,
      enabled_sources: enabled,
      discovered_count: Object.keys(records).filter((key) => key !== "_scheduler_state").length,
      max_posts_per_run: automationRunner.maxPostsPerRun,
      ...automationScheduler.getStatus(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || "Automation status unavailable" });
  }
});

app.post("/api/automation/run", async (req, res) => {
  try {
    if (!DOWNLOAD_TOKEN || !auth(req)) return res.status(401).json({ success: false, error: "Unauthorized" });

    const { source_names, max_posts_per_run, dry_run } = req.body || {};
    const requestedSources = Array.isArray(source_names)
      ? source_names
      : typeof source_names === "string"
        ? source_names
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];

    const result = await automationScheduler.runManual({
      sourceNames: requestedSources,
      maxPostsPerRun: Number.isFinite(Number(max_posts_per_run))
        ? Number(max_posts_per_run)
        : automationRunner.maxPostsPerRun,
      dryRun: dry_run === true,
    });

    const responseStatus = result.status === "RUN_ALREADY_IN_PROGRESS" ? 409
      : result.status === "DAILY_RUN_ALREADY_STARTED" ? 409
        : result.status === "FAILED" ? 500 : 200;
    res.status(responseStatus).json({ success: result.success, ...result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || "Automation run failed" });
  }
});

app.post("/api/publish", async (req, res) => {
  let lockedVideoId = null;
  try {
    if (!DOWNLOAD_TOKEN || !auth(req)) return res.status(401).json({ success: false, error: "Unauthorized" });

    const { job_id, publication_date, dry_run } = req.body || {};
    if (!job_id) {
      return res.status(400).json({ success: false, error: "job_id is required" });
    }

    const job = jobs.get(job_id);
    if (!job) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }

    if (publishedJobs.has(job_id)) {
      return res.json({ success: true, idempotent: true, ...publishedJobs.get(job_id) });
    }

    const allowResult = shouldAllowPublish(job);
    if (!allowResult.allowed) {
      return res.status(403).json({
        success: false,
        job_id,
        status: allowResult.status,
        error: allowResult.reason,
      });
    }

    const dryRun = dry_run === true || process.env.PUBLISHER_DRY_RUN === "true" || process.env.AUTOMATION_DRY_RUN === "true";
    if (job.video_id) {
      const videoId = String(job.video_id);
      if (publicationLocks.has(videoId)) {
        return res.status(409).json({ success: false, status: "RUN_ALREADY_IN_PROGRESS", video_id: videoId });
      }
      lockedVideoId = videoId;
      publicationLocks.add(videoId);
      const existing = await automationStore.get(videoId);
      if (existing && ["PUBLISHING", "PUBLISH_FAILED", "SCHEDULED", "PUBLISHED"].includes(existing.status)) {
        return res.status(409).json({
          success: false,
          status: "EXISTING",
          video_id: videoId,
          publication_id: existing.publication_id || null,
          error: "This TikTok video already has a publication attempt or accepted publication.",
        });
      }
      if (existing?.status === "READY_TO_PUBLISH" && existing.job_id && existing.job_id !== job_id) {
        return res.status(409).json({ success: false, status: "EXISTING", video_id: videoId, error: "This TikTok video is already queued under another job." });
      }
      const lock = { ...(existing || {}), ...job, video_id: videoId, job_id, filter_status: "APPROVED" };
      if (existing) await automationStore.transition(videoId, existing.status, "PUBLISHING", lock);
      else await automationStore.set(videoId, { ...lock, status: "PUBLISHING" });
    }

    const result = await publishScheduledVideo({
      job: {
        ...job,
        caption: job.caption || generateCaption({ title: job.title || "", author: job.author || "", category: job.content_category || "christian" }),
      },
      publicationDate: publication_date || job.publication_date || null,
      brandId: process.env.METRICOOL_BRAND_ID || "7241347",
      timezone: process.env.METRICOOL_TIMEZONE || "Asia/Jayapura",
      dryRun,
      idempotencyMap: dryRun ? new Map() : publishedJobs,
    });

    if (!result.success) throw new Error(result.error || "Publisher did not confirm scheduling");
    const publisherStatus = String(result.status || "SCHEDULED").toUpperCase();
    if (!dryRun && !["SCHEDULED", "PUBLISHED"].includes(publisherStatus)) {
      throw new Error(`Publisher did not confirm an accepted schedule (status: ${publisherStatus})`);
    }
    const finalStatus = dryRun ? "READY_TO_PUBLISH" : publisherStatus === "PUBLISHED" ? "PUBLISHED" : "SCHEDULED";
    if (!dryRun && lockedVideoId) {
      const current = await automationStore.get(lockedVideoId);
      await automationStore.transition(lockedVideoId, current?.status || "PUBLISHING", finalStatus, {
        ...current,
        publication_id: result.publication_id,
        publication_date: result.publication_date || publication_date || job.publication_date || null,
        publisher_status: publisherStatus,
        scheduled_at: result.scheduled_at || result.publication_date || publication_date || job.publication_date || null,
      });
    } else if (dryRun && lockedVideoId) {
      const current = await automationStore.get(lockedVideoId);
      await automationStore.transition(lockedVideoId, current?.status || "PUBLISHING", "READY_TO_PUBLISH", {
        ...current,
        publication_id: result.publication_id || null,
        publisher_status: "DRY_RUN",
      });
    }
    jobs.set(job_id, { ...job, publication: result, status: finalStatus });
    return res.json({ success: true, ...result });
  } catch (error) {
    if (lockedVideoId) {
      const current = await automationStore.get(lockedVideoId).catch(() => null);
      if (current?.status === "PUBLISHING") {
        await automationStore.transition(lockedVideoId, "PUBLISHING", "PUBLISH_FAILED", {
          ...current,
          error: error.message || "Publish failed",
          failed_at: new Date().toISOString(),
        }).catch(() => {});
      }
    }
    res.status(400).json({ success: false, error: error.message || "Publish failed" });
  } finally {
    if (lockedVideoId) publicationLocks.delete(lockedVideoId);
  }
});

app.get("/api/video/:filename", async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    if (!filename.endsWith(".mp4")) return res.status(400).end();

    const filePath = path.join(DATA_DIR, filename);
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return res.status(404).json({ success: false, error: "Video not found" });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Accept-Ranges", "bytes");

    const range = req.headers.range;
    if (!range) {
      return fsSync.createReadStream(filePath).pipe(res);
    }

    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (!match) return res.status(416).end();

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) return res.status(416).end();

    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", end - start + 1);
    fsSync.createReadStream(filePath, { start, end }).pipe(res);
  } catch {
    res.status(404).json({ success: false, error: "Video not found" });
  }
});

setInterval(async () => {
  const cutoff = Date.now() - FILE_TTL_HOURS * 3600 * 1000;
  try {
    for (const name of await fs.readdir(DATA_DIR)) {
      if (!name.endsWith(".mp4")) continue;
      const filePath = path.join(DATA_DIR, name);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) await fs.rm(filePath, { force: true });
    }
  } catch {}
}, 60 * 60 * 1000).unref();

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`TikTok downloader listening on :${PORT}`);
  automationScheduler.start().catch((error) => {
    console.error(JSON.stringify({ event: "automation_scheduler_start_failed", error: error.message || String(error) }));
  });
});

let shutdownStarted = false;
async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.info(JSON.stringify({ event: "shutdown_started", signal }));
  await automationScheduler.stop({ waitForActive: true });
  await new Promise((resolve) => httpServer.close(resolve));
  console.info(JSON.stringify({ event: "shutdown_completed", signal }));
}

process.once("SIGINT", () => shutdown("SIGINT").catch((error) => {
  console.error(JSON.stringify({ event: "shutdown_failed", error: error.message || String(error) }));
  process.exitCode = 1;
}));
process.once("SIGTERM", () => shutdown("SIGTERM").catch((error) => {
  console.error(JSON.stringify({ event: "shutdown_failed", error: error.message || String(error) }));
  process.exitCode = 1;
}));
