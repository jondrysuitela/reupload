import crypto from 'node:crypto';
import path from 'node:path';
import { FileKVStore } from './persistent-store.js';
import { DiscoveryService } from './discovery-service.js';
import { SourceRegistry } from './source-registry.js';
import { generateCaption } from './caption.js';
import { defaultBestPostingTimeProvider } from './best-posting-time-provider.js';
import { buildMetricoolPostPayload, publishScheduledVideo, resolveHttpsUrl } from './publisher.js';
import { parseTikTokUrl } from './tiktok.js';

const RESUMABLE_SOURCE_STATES = new Set(['READY_TO_PUBLISH', 'COMPLETED', 'DISCOVERED', 'ANALYZING', 'APPROVED', 'DOWNLOADING']);

function summarize(result) {
  return {
    discovered: result.discovered,
    analyzed: result.analyzed,
    approved: result.approved.length,
    review: result.review.length,
    skipped: result.skipped.length,
    downloading: result.downloading.length,
    downloaded: result.downloaded.length,
    ready_to_publish: result.ready_to_publish.length,
    scheduled: result.scheduled.length,
    failed: result.failed.length + result.source_errors.length,
    duplicates: result.duplicates.length,
  };
}

function withTimeout(operation, timeoutMs, message) {
  let timer;
  const task = Promise.resolve().then(operation);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

export class AutomationRunner {
  constructor({
    registry,
    dataDir,
    store,
    maxPostsPerRun = Number(process.env.MAX_POSTS_PER_RUN ?? 1),
    downloadVideo,
    validateVideo,
    captionGenerator = generateCaption,
    bestPostingTimeProvider = defaultBestPostingTimeProvider,
    publisher = publishScheduledVideo,
    publicUrlBuilder,
    maxFileSizeBytes = Number(process.env.MAX_FILE_SIZE_MB || 500) * 1024 * 1024,
    downloadTimeoutMs = Number(process.env.DOWNLOAD_TIMEOUT_MS || 300000),
    timezone = process.env.METRICOOL_TIMEZONE || process.env.AUTOMATION_TIMEZONE || 'Asia/Jayapura',
    brandId = process.env.METRICOOL_BRAND_ID || '7241347',
    onJobUpdate = () => {},
    publisherIdempotencyMap = new Map(),
    publicationLocks = new Set(),
  } = {}) {
    this.registry = registry || new SourceRegistry();
    this.store = store || new FileKVStore({ dataDir });
    this.discoveryService = new DiscoveryService({ registry: this.registry, store: this.store, dataDir });
    this.maxPostsPerRun = Number.isFinite(Number(maxPostsPerRun)) ? Math.max(0, Number(maxPostsPerRun)) : 1;
    this.downloadVideo = downloadVideo;
    this.validateVideo = validateVideo;
    this.captionGenerator = captionGenerator;
    this.bestPostingTimeProvider = bestPostingTimeProvider;
    this.publisher = publisher;
    this.publicUrlBuilder = publicUrlBuilder;
    this.maxFileSizeBytes = maxFileSizeBytes;
    this.downloadTimeoutMs = Math.max(1, Number(downloadTimeoutMs) || 300000);
    this.timezone = timezone;
    this.brandId = brandId;
    this.onJobUpdate = onJobUpdate;
    this.publisherIdempotencyMap = publisherIdempotencyMap;
    this.publicationLocks = publicationLocks;
  }

  async setStage(videoId, current, nextStatus, fields = {}) {
    const timestamp = new Date().toISOString();
    const record = {
      ...(current || {}),
      ...fields,
      video_id: videoId,
      status: nextStatus,
      updated_at: timestamp,
    };
    if (current) {
      return this.store.transition(videoId, current.status || 'DISCOVERED', nextStatus, fields);
    }
    record.status_history = [{ from: null, to: nextStatus, at: timestamp }];
    return this.store.set(videoId, record);
  }

  notify(record) {
    try {
      this.onJobUpdate({ ...record });
    } catch {}
  }

  async saveFailure(candidate, record, stage, error) {
    const timestamp = new Date().toISOString();
    const fields = {
      ...record,
      status: 'FAILED',
      failure_stage: stage,
      error: error?.message || String(error),
      failed_at: timestamp,
      source: candidate.source_name || candidate.username || null,
      video_id: String(candidate.video_id),
    };
    const stored = await this.store.transition(String(candidate.video_id), record?.status || 'DISCOVERED', 'FAILED', fields);
    this.notify(stored);
    return {
      status: 'FAILED',
      failure_stage: stage,
      error: fields.error,
      timestamp,
      source: fields.source,
      video_id: fields.video_id,
      job_id: record?.job_id || null,
    };
  }

  createRunResult({ dryRun, sourceCount, totalCandidates, sourceErrors, duplicates }) {
    return {
      discovered: [],
      analyzed: [],
      approved: [],
      review: [],
      skipped: [],
      downloading: [],
      downloaded: [],
      ready_to_publish: [],
      scheduled: [],
      failed: [],
      duplicates: [...duplicates],
      source_errors: [...sourceErrors],
      source_count: sourceCount,
      total_candidates: totalCandidates,
      dry_run: Boolean(dryRun),
    };
  }

  async runOnce({
    fetcher,
    sourceNames = [],
    dryRun = true,
    maxPostsPerRun = this.maxPostsPerRun,
    onProgress = () => {},
  } = {}) {
    const requestedLimit = Number(maxPostsPerRun);
    const runLimit = Number.isFinite(requestedLimit) ? Math.max(0, requestedLimit) : this.maxPostsPerRun;
    if (typeof fetcher !== 'function' || runLimit === 0) {
      const empty = this.createRunResult({
        dryRun,
        sourceCount: this.registry.getEnabledSources().length,
        totalCandidates: 0,
        sourceErrors: [],
        duplicates: [],
      });
      empty.summary = summarize(empty);
      return empty;
    }

    const discovery = await this.discoveryService.discoverCandidatesWithReport({
      sourceNames,
      fetcher,
      includeSkipped: true,
      maxResults: Math.max(runLimit + 10, 20),
    });
    const result = this.createRunResult({
      dryRun,
      sourceCount: discovery.source_count,
      totalCandidates: discovery.candidates.length,
      sourceErrors: discovery.source_errors,
      duplicates: discovery.duplicates,
    });
    result.discovered = [...new Set([
      ...discovery.candidates.map((candidate) => candidate.video_id),
      ...discovery.duplicates.map((duplicate) => duplicate.video_id),
    ])];
    result.analyzed = discovery.candidates.map((candidate) => candidate.video_id);
    result.total_candidates = result.discovered.length;

    const approvedCandidates = [];
    for (const candidate of discovery.candidates) {
      const videoId = String(candidate.video_id);
      const existingReady = candidate.existing_record?.status === 'READY_TO_PUBLISH';
      if (candidate.status === 'REVIEW') {
        result.review.push(candidate);
        if (!existingReady) {
          await this.store.set(videoId, { ...candidate, video_id: videoId, status: 'REVIEW' });
        }
      } else if (candidate.status === 'SKIPPED') {
        result.skipped.push(candidate);
        if (!existingReady) {
          await this.store.set(videoId, { ...candidate, video_id: videoId, status: 'SKIPPED' });
        }
      } else if (candidate.status === 'APPROVED') {
        result.approved.push(candidate);
        approvedCandidates.push(candidate);
      }
    }

    const emitProgress = () => {
      const summary = summarize(result);
      try { onProgress(summary); } catch {}
    };
    emitProgress();

    let plannedCount = 0;
    for (const candidate of approvedCandidates) {
      if (dryRun && plannedCount >= runLimit) break;
      if (!dryRun && result.scheduled.length >= runLimit) break;

      const videoId = String(candidate.video_id);
      const currentStored = await this.store.get(videoId);
      if (this.publicationLocks.has(videoId)) {
        result.duplicates.push({ video_id: videoId, status: 'PUBLISHING' });
        continue;
      }
      const existingRecord = candidate.existing_record || currentStored;
      const resumeDownloaded = existingRecord && ['COMPLETED', 'READY_TO_PUBLISH'].includes(existingRecord.status);
      const retryableExisting = existingRecord && (
        RESUMABLE_SOURCE_STATES.has(existingRecord.status)
        || (existingRecord.status === 'FAILED' && existingRecord.failure_stage !== 'PUBLISH')
      );
      if (existingRecord && !resumeDownloaded && !retryableExisting) {
        result.duplicates.push({ video_id: videoId, status: 'EXISTING', existing_status: existingRecord.status || 'UNKNOWN' });
        continue;
      }

      const { existing_record: _existingRecord, ...candidateFields } = candidate;
      let record = existingRecord ? {
        ...candidateFields,
        ...existingRecord,
        status: existingRecord.status,
      } : {
        ...candidate,
        job_id: crypto.randomUUID(),
        video_id: videoId,
        source_account: candidate.username || candidate.source_name,
        filter_status: 'APPROVED',
        status: 'DISCOVERED',
      };
      const jobId = record.job_id || crypto.randomUUID();
      record.job_id = jobId;

      try {
        if (!existingRecord) {
          record = await this.setStage(videoId, null, 'DISCOVERED', record);
          this.notify(record);
        }
        record = await this.setStage(videoId, record, 'ANALYZING', { filter_status: 'APPROVED' });
        this.notify({ ...record, job_id: jobId, status: 'ANALYZING' });
        record = await this.setStage(videoId, record, 'APPROVED', { filter_status: 'APPROVED' });
        this.notify({ ...record, job_id: jobId, status: 'APPROVED' });

        if (!resumeDownloaded) {
          if (typeof this.downloadVideo !== 'function') throw new Error('TikTok downloader is not configured');
          const parsed = parseTikTokUrl(candidate.source_url);
          if (parsed.username && candidate.username && parsed.username !== String(candidate.username).replace(/^@/, '').toLowerCase()) {
            throw new Error('TikTok URL account does not match the authorized source');
          }
          if (parsed.videoId && parsed.videoId !== videoId) {
            throw new Error('TikTok URL video_id does not match the discovered candidate');
          }
          const sourceUrl = parsed.normalizedUrl;
          record = await this.setStage(videoId, record, 'DOWNLOADING', {
            source_url: sourceUrl,
            error: null,
            failure_stage: null,
            failed_at: null,
          });
          result.downloading.push({ video_id: videoId, job_id: jobId });
          this.notify({ ...record, job_id: jobId, status: 'DOWNLOADING' });
          emitProgress();

          const file = await withTimeout(
            () => this.downloadVideo(sourceUrl, jobId, { timeoutMs: this.downloadTimeoutMs }),
            this.downloadTimeoutMs,
            `TikTok download timed out after ${this.downloadTimeoutMs}ms`,
          );
          if (!file || typeof file !== 'object') throw new Error('Downloader did not return a completed file');
          if (!file.filename || !String(file.filename).toLowerCase().endsWith('.mp4')) throw new Error('Downloader did not return an MP4 file');
          if (path.basename(file.filename) !== file.filename) throw new Error('Downloader returned an unsafe filename');
          if (typeof this.validateVideo !== 'function') throw new Error('MP4 validator is not configured');
          const validation = await this.validateVideo(file, { maxFileSizeBytes: this.maxFileSizeBytes });
          if (!validation || validation.valid !== true) throw new Error(validation?.error || 'Downloaded MP4 failed validation');
          const fileSize = Number(validation.size ?? file.size);
          if (!Number.isFinite(fileSize) || fileSize <= 0) throw new Error('Downloaded MP4 is empty or has an invalid size');
          if (fileSize > this.maxFileSizeBytes) throw new Error('Video exceeds maximum allowed size');

          record = await this.setStage(videoId, record, 'COMPLETED', {
            filename: file.filename,
            size: fileSize,
          });
          this.notify({ ...record, job_id: jobId, status: 'COMPLETED' });
          result.downloaded.push({ video_id: videoId, job_id: jobId, filename: file.filename, size: record.size });
          emitProgress();
        } else {
          if (typeof this.validateVideo !== 'function') throw new Error('MP4 validator is not configured');
          const validation = await this.validateVideo({ filename: record.filename, size: record.size }, { maxFileSizeBytes: this.maxFileSizeBytes });
          if (!validation || validation.valid !== true) throw new Error(validation?.error || 'Stored MP4 failed validation');
          if (!result.downloaded.some((item) => item.video_id === videoId)) {
            result.downloaded.push({ video_id: videoId, job_id: jobId, filename: record.filename, size: record.size, resumed: true });
          }
        }

        let downloadUrl = record.download_url;
        if (!downloadUrl) {
          if (typeof this.publicUrlBuilder !== 'function') throw new Error('Public video URL is not configured');
          downloadUrl = await this.publicUrlBuilder(record.filename, record);
        }
        downloadUrl = resolveHttpsUrl(downloadUrl);

        const caption = record.caption || this.captionGenerator({
          title: candidate.title || record.title || '',
          author: candidate.source_name || candidate.username || record.source_account || '',
          source: candidate.source_name || candidate.username || record.source_account || '',
          category: candidate.content_category || record.content_category || 'christian',
          score: candidate.christian_score ?? record.christian_score,
        });
        const postingTime = record.publication_date && record.time_source
          ? {
              best_posting_datetime: record.publication_date,
              timezone: record.timezone || this.timezone,
              provider: record.time_source === 'fallback' ? 'fixed_fallback' : record.time_source,
              recommended: record.time_source !== 'fallback',
            }
          : await this.bestPostingTimeProvider.getNextBestTime({ timezone: this.timezone });
        const timeSource = postingTime.provider === 'metricool' ? 'metricool' : 'fallback';
        const publicationDate = postingTime.best_posting_datetime;

        record = await this.setStage(videoId, record, 'READY_TO_PUBLISH', {
          job_id: jobId,
          video_id: videoId,
          filename: record.filename,
          size: record.size,
          download_url: downloadUrl,
          caption,
          publication_date: publicationDate,
          timezone: postingTime.timezone || this.timezone,
          time_source: timeSource,
          christian_score: candidate.christian_score,
          content_category: candidate.content_category || 'christian',
          source_account: candidate.username || candidate.source_name || record.source_account,
          filter_status: 'APPROVED',
        });
        result.ready_to_publish.push({
          status: 'READY_TO_PUBLISH',
          planned: Boolean(dryRun),
          published: false,
          source_account: record.source_account,
          video_id: videoId,
          christian_score: record.christian_score,
          publication_date: publicationDate,
          timezone: record.timezone,
          time_source: timeSource,
          download_url: downloadUrl,
          caption,
          job_id: jobId,
        });
        this.notify({ ...record, status: 'READY_TO_PUBLISH' });
        emitProgress();
        plannedCount += 1;

        const beforePublish = await this.store.get(videoId);
        if (this.publicationLocks.has(videoId) || (beforePublish && beforePublish.status !== 'READY_TO_PUBLISH')) {
          result.duplicates.push({ video_id: videoId, status: beforePublish?.status || 'PUBLISHING' });
          continue;
        }
        this.publicationLocks.add(videoId);
        try {
        const publishing = await this.setStage(videoId, record, 'PUBLISHING', {});
        record = publishing;
        this.notify({ ...publishing, job_id: jobId, status: 'PUBLISHING' });
        const publication = await this.publisher({
          job: {
            ...publishing,
            job_id: jobId,
            video_id: videoId,
            filter_status: 'APPROVED',
            status: 'APPROVED',
            caption,
            download_url: downloadUrl,
            video_url: downloadUrl,
            publication_date: publicationDate,
            target_network: 'facebook_page',
          },
          publicationDate,
          brandId: this.brandId,
          timezone: postingTime.timezone || this.timezone,
          dryRun: Boolean(dryRun),
          idempotencyMap: dryRun ? new Map() : this.publisherIdempotencyMap,
        });

        if (!publication?.success) {
          throw new Error(publication?.error || 'Publisher did not confirm scheduling');
        }
        if (dryRun || publication.dry_run) {
          const plannedJob = {
            ...publishing,
            job_id: jobId,
            video_id: videoId,
            filter_status: 'APPROVED',
            status: 'APPROVED',
            caption,
            download_url: downloadUrl,
            publication_date: publicationDate,
          };
          const { user_id: _userId, ...plannedPayload } = buildMetricoolPostPayload({
            job: plannedJob,
            videoUrl: downloadUrl,
            publicationDate,
            brandId: this.brandId,
            timezone: postingTime.timezone || this.timezone,
          });
          const planned = await this.setStage(videoId, publishing, 'READY_TO_PUBLISH', {
            publication_id: publication.publication_id || null,
            publication_date: publicationDate,
            publisher_status: 'DRY_RUN',
            scheduled_at: null,
            planned: true,
            published: false,
            planned_publisher_payload: plannedPayload,
          });
          result.ready_to_publish[result.ready_to_publish.length - 1] = {
            ...result.ready_to_publish.at(-1),
            publication_id: publication.publication_id || null,
            publisher_status: 'DRY_RUN',
            publisher_payload: plannedPayload,
          };
          this.notify(planned);
          continue;
        }

        const publisherStatus = String(publication.status || 'SCHEDULED').toUpperCase();
        if (!['SCHEDULED', 'PUBLISHED'].includes(publisherStatus)) {
          throw new Error(`Publisher did not confirm an accepted schedule (status: ${publisherStatus})`);
        }
        const finalStatus = publisherStatus === 'PUBLISHED' ? 'PUBLISHED' : 'SCHEDULED';
        const scheduledAt = publication.scheduled_at || publication.publication_date || publicationDate;
        const accepted = await this.setStage(videoId, publishing, finalStatus, {
          publication_id: publication.publication_id,
          publication_date: publicationDate,
          publisher_status: publisherStatus,
          scheduled_at: scheduledAt,
          time_source: timeSource,
          planned: false,
          published: finalStatus === 'PUBLISHED',
        });
        this.publisherIdempotencyMap.set(jobId, publication);
        const output = {
          status: finalStatus,
          planned: false,
          published: finalStatus === 'PUBLISHED',
          source_account: accepted.source_account,
          video_id: videoId,
          job_id: jobId,
          publication_id: publication.publication_id,
          publication_date: publicationDate,
          timezone: accepted.timezone,
          time_source: timeSource,
          publisher_status: publisherStatus,
          scheduled_at: scheduledAt,
        };
        if (finalStatus === 'PUBLISHED') result.published = [...(result.published || []), output];
        result.scheduled.push(output);
        this.notify(accepted);
        emitProgress();
        } finally {
          this.publicationLocks.delete(videoId);
        }
      } catch (error) {
        const failed = await this.saveFailure(candidate, record, record?.status === 'PUBLISHING' ? 'PUBLISH' : 'DOWNLOAD_OR_PREPARE', error);
        if (failed.failure_stage === 'PUBLISH') failed.status = 'PUBLISH_FAILED';
        result.failed.push(failed);
        if (failed.failure_stage === 'PUBLISH') {
          const stored = await this.store.get(videoId);
          const publishFailed = await this.store.transition(videoId, stored?.status || 'FAILED', 'PUBLISH_FAILED', {
            ...stored,
            error: failed.error,
            failed_at: failed.timestamp,
            source: failed.source,
            video_id: videoId,
          });
          this.notify(publishFailed);
        }
        emitProgress();
      }
    }

    result.scheduled_count = result.scheduled.length;
    result.summary = summarize(result);
    result.summary.source_count = result.source_count;
    result.summary.source_errors = result.source_errors;
    result.summary.dry_run = result.dry_run;
    return result;
  }
}

export const defaultAutomationRunner = new AutomationRunner();
