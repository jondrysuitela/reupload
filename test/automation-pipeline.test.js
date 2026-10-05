import test from 'node:test';
import assert from 'node:assert/strict';

import { AutomationRunner } from '../src/services/automation-runner.js';
import { SourceRegistry } from '../src/services/source-registry.js';
import { publishScheduledVideo } from '../src/services/publisher.js';

function createStore() {
  const records = new Map();
  return {
    records,
    async get(key) { return records.get(key) ?? null; },
    async set(key, value) {
      const record = { ...value };
      if (record.status && !record.status_history) {
        record.status_history = [{ from: null, to: record.status, at: new Date().toISOString() }];
      }
      records.set(key, record);
      return record;
    },
    async transition(key, from, to, metadata = {}) {
      const current = records.get(key) || {};
      const record = {
        ...current,
        ...metadata,
        status: to,
        status_history: [
          ...(current.status_history || []),
          { from: from ?? current.status ?? null, to, at: new Date().toISOString() },
        ],
      };
      records.set(key, record);
      return record;
    },
  };
}

function approvedVideo(videoId, overrides = {}) {
  return {
    video_id: videoId,
    title: 'Yesus Kristus memberkati kita hari ini',
    description: 'Renungan Kristen dan firman Tuhan',
    username: 'source-a',
    author: 'Source A',
    source_url: `https://www.tiktok.com/@source-a/video/${videoId}`,
    ...overrides,
  };
}

function createRig({
  sources = [{ id: 'source-a', name: 'source-a', enabled: true, priority: 10 }],
  videos = [approvedVideo('10001')],
  store = createStore(),
  downloadVideo = async (_url, jobId) => ({ filename: `${jobId}.mp4`, path: `F:/data/${jobId}.mp4`, size: 42 }),
  validateVideo = async (file) => ({ valid: true, size: file.size || 42 }),
  captionGenerator = () => 'Caption rohani siap dipublikasikan',
  bestPostingTimeProvider = {
    async getNextBestTime() {
      return {
        best_posting_datetime: '2026-10-05T10:00:00.000Z',
        timezone: 'Asia/Jayapura',
        provider: 'fixed_fallback',
        recommended: false,
      };
    },
  },
  publisher = async ({ job, dryRun }) => ({
    success: true,
    dry_run: dryRun,
    status: 'SCHEDULED',
    publication_id: `publication-${job.video_id}`,
    publication_date: job.publication_date,
    target_network: 'facebook_page',
  }),
  publicUrlBuilder = async (filename) => `https://media.example.test/api/video/${encodeURIComponent(filename)}`,
  maxPostsPerRun = 1,
  downloadTimeoutMs = 500,
  onJobUpdate = () => {},
} = {}) {
  const registry = new SourceRegistry(sources);
  const runner = new AutomationRunner({
    registry,
    store,
    maxPostsPerRun,
    downloadVideo,
    validateVideo,
    captionGenerator,
    bestPostingTimeProvider,
    publisher,
    publicUrlBuilder,
    maxFileSizeBytes: 1024,
    downloadTimeoutMs,
    timezone: 'Asia/Jayapura',
    brandId: '7241347',
    onJobUpdate,
  });
  return {
    runner,
    store,
    registry,
    async run(options = {}) {
      return runner.runOnce({
        fetcher: async (source) => videos.filter((video) => !video.source_id || video.source_id === source.id),
        dryRun: false,
        ...options,
      });
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('APPROVED video uses the existing downloader and reaches downloaded state', async () => {
  let calls = 0;
  const jobStatuses = [];
  const rig = createRig({ downloadVideo: async (_url, jobId) => {
    calls += 1;
    return { filename: `${jobId}.mp4`, size: 42 };
  }, onJobUpdate: (job) => jobStatuses.push(job.status) });
  const result = await rig.run();
  assert.equal(calls, 1);
  assert.equal(result.downloaded.length, 1);
  assert.equal(result.failed.length, 0);
  for (const status of ['DISCOVERED', 'ANALYZING', 'APPROVED', 'DOWNLOADING', 'COMPLETED', 'READY_TO_PUBLISH', 'PUBLISHING', 'SCHEDULED']) {
    assert.ok(jobStatuses.includes(status), `missing job status ${status}`);
  }
});

test('runner awaits download completion before validation and publishing', async () => {
  let finishDownload;
  let published = 0;
  const rig = createRig({
    downloadVideo: () => new Promise((resolve) => { finishDownload = resolve; }),
    publisher: async () => { published += 1; return { success: true, status: 'SCHEDULED', publication_id: 'p-1' }; },
  });
  const run = rig.run();
  await tick();
  assert.equal(published, 0);
  finishDownload({ filename: 'awaited.mp4', size: 15 });
  const result = await run;
  assert.equal(published, 1);
  assert.equal(result.scheduled.length, 1);
});

test('download timeout is recorded as FAILED and never reaches publisher', async () => {
  let published = 0;
  const rig = createRig({ downloadTimeoutMs: 10, downloadVideo: () => new Promise(() => {}), publisher: async () => { published += 1; } });
  const result = await rig.run();
  assert.equal(result.failed[0].status, 'FAILED');
  assert.equal(result.failed[0].failure_stage, 'DOWNLOAD_OR_PREPARE');
  assert.equal(published, 0);
  assert.equal((await rig.store.get('10001')).status, 'FAILED');
});

test('invalid MP4 validation fails closed before publisher invocation', async () => {
  let published = 0;
  const rig = createRig({
    validateVideo: async () => ({ valid: false, error: 'invalid MP4 stream' }),
    publisher: async () => { published += 1; },
  });
  const result = await rig.run();
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /invalid MP4/i);
  assert.equal(published, 0);
});

test('caption generator receives title, category, source, and Christian score', async () => {
  let captionInput;
  const rig = createRig({ captionGenerator: (input) => {
    captionInput = input;
    return 'Caption yang dihasilkan';
  } });
  await rig.run({ dryRun: true });
  assert.equal(captionInput.title, 'Yesus Kristus memberkati kita hari ini');
  assert.equal(captionInput.category, 'christian');
  assert.equal(captionInput.source, 'source-a');
  assert.ok(captionInput.score >= 90);
  assert.match(captionInput.source, /source-a/);
});

test('BestPostingTimeProvider result is stored with timezone and fallback source', async () => {
  let providerInput;
  const provider = { async getNextBestTime(input) {
    providerInput = input;
    return { best_posting_datetime: '2026-10-05T10:00:00.000Z', timezone: 'Asia/Jayapura', provider: 'fixed_fallback', recommended: false };
  } };
  const rig = createRig({ bestPostingTimeProvider: provider });
  await rig.run({ dryRun: true });
  const record = await rig.store.get('10001');
  assert.equal(providerInput.timezone, 'Asia/Jayapura');
  assert.equal(record.publication_date, '2026-10-05T10:00:00.000Z');
  assert.equal(record.timezone, 'Asia/Jayapura');
  assert.equal(record.time_source, 'fallback');
});

test('publisher receives approved HTTPS video, caption, publication time, brand, and Facebook target', async () => {
  let input;
  const rig = createRig({ publisher: async (options) => {
    input = options;
    return { success: true, dry_run: false, status: 'SCHEDULED', publication_id: 'metricool-1' };
  } });
  const result = await rig.run();
  assert.equal(input.job.filter_status, 'APPROVED');
  assert.equal(input.job.download_url, 'https://media.example.test/api/video/' + encodeURIComponent(input.job.filename));
  assert.equal(input.job.caption, 'Caption rohani siap dipublikasikan');
  assert.equal(input.publicationDate, '2026-10-05T10:00:00.000Z');
  assert.equal(input.brandId, '7241347');
  assert.equal(input.timezone, 'Asia/Jayapura');
  assert.equal(input.job.target_network, 'facebook_page');
  assert.equal(result.scheduled[0].publication_id, 'metricool-1');
});

test('REVIEW content never downloads or publishes', async () => {
  let downloads = 0;
  let publishes = 0;
  const rig = createRig({
    videos: [approvedVideo('20001', {
      title: 'Yesus Kristus memberkati',
      description: 'iman',
    })],
    downloadVideo: async () => { downloads += 1; },
    publisher: async () => { publishes += 1; },
  });
  const result = await rig.run();
  assert.equal(result.review.length, 1);
  assert.equal(downloads, 0);
  assert.equal(publishes, 0);
});

test('SKIPPED content never downloads or publishes', async () => {
  let downloads = 0;
  let publishes = 0;
  const rig = createRig({
    videos: [approvedVideo('20002', { title: 'Funny dance challenge', description: 'memes' })],
    downloadVideo: async () => { downloads += 1; },
    publisher: async () => { publishes += 1; },
  });
  const result = await rig.run();
  assert.equal(result.skipped.length, 1);
  assert.equal(downloads, 0);
  assert.equal(publishes, 0);
});

test('scheduled video_id is a durable duplicate and is not downloaded or published twice', async () => {
  let downloads = 0;
  let publishes = 0;
  const store = createStore();
  const options = {
    store,
    downloadVideo: async (_url, jobId) => { downloads += 1; return { filename: `${jobId}.mp4`, size: 42 }; },
    publisher: async () => { publishes += 1; return { success: true, status: 'SCHEDULED', publication_id: 'once' }; },
  };
  const first = createRig(options);
  const firstRun = await first.run();
  const second = createRig(options);
  const secondRun = await second.run();
  assert.equal(firstRun.scheduled.length, 1);
  assert.equal(secondRun.duplicates.length, 1);
  assert.equal(secondRun.duplicates[0].status, 'EXISTING');
  assert.equal(secondRun.duplicates[0].existing_status, 'SCHEDULED');
  assert.equal(downloads, 1);
  assert.equal(publishes, 1);
});

test('publisher failure becomes PUBLISH_FAILED and is not counted as scheduled', async () => {
  const rig = createRig({ publisher: async () => { throw new Error('Metricool unavailable'); } });
  const result = await rig.run();
  assert.equal(result.failed[0].status, 'PUBLISH_FAILED');
  assert.equal(result.failed[0].failure_stage, 'PUBLISH');
  assert.equal(result.scheduled_count, 0);
  assert.equal((await rig.store.get('10001')).status, 'PUBLISH_FAILED');
});

test('publisher acceptance persists SCHEDULED and publication metadata', async () => {
  const rig = createRig({ publisher: async () => ({
    success: true,
    status: 'SCHEDULED',
    publication_id: 'accepted-1',
    publication_date: '2026-10-05T10:00:00.000Z',
  }) });
  const result = await rig.run();
  const record = await rig.store.get('10001');
  assert.equal(result.scheduled.length, 1);
  assert.equal(record.status, 'SCHEDULED');
  assert.equal(record.publication_id, 'accepted-1');
  assert.equal(record.publisher_status, 'SCHEDULED');
  assert.equal(record.scheduled_at, '2026-10-05T10:00:00.000Z');
});

test('a publisher failure for video A does not prevent video B from scheduling', async () => {
  const rig = createRig({
    videos: [approvedVideo('25001'), approvedVideo('25002')],
    publisher: async ({ job }) => {
      if (job.video_id === '25001') throw new Error('Metricool rejected video A');
      return { success: true, status: 'SCHEDULED', publication_id: 'video-b-accepted' };
    },
  });
  const result = await rig.run();
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].video_id, '25001');
  assert.equal(result.scheduled.length, 1);
  assert.equal(result.scheduled[0].video_id, '25002');
});

test('a download failure for video A does not prevent video B from scheduling', async () => {
  const rig = createRig({
    videos: [approvedVideo('26001'), approvedVideo('26002')],
    downloadVideo: async (_url, jobId) => {
      if (jobId && (await rig.store.get('26001'))?.job_id === jobId) throw new Error('download failed');
      return { filename: `${jobId}.mp4`, size: 42 };
    },
  });
  const result = await rig.run();
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].video_id, '26001');
  assert.equal(result.scheduled.length, 1);
  assert.equal(result.scheduled[0].video_id, '26002');
});

test('MAX_POSTS_PER_RUN limits accepted schedules, not failed or review candidates', async () => {
  let publishes = 0;
  const rig = createRig({
    videos: [approvedVideo('30001'), approvedVideo('30002')],
    maxPostsPerRun: 1,
    publisher: async ({ job }) => {
      publishes += 1;
      return { success: true, status: 'SCHEDULED', publication_id: `accepted-${job.video_id}` };
    },
  });
  const result = await rig.run();
  assert.equal(result.scheduled.length, 1);
  assert.equal(publishes, 1);
});

test('dry-run downloads, prepares publisher payload, and performs no external request', async () => {
  let requests = 0;
  const rig = createRig({ publisher: (options) => publishScheduledVideo({
    ...options,
    httpClient: async () => { requests += 1; throw new Error('must not be called'); },
  }) });
  const result = await rig.run({ dryRun: true });
  const planned = result.ready_to_publish[0];
  assert.equal(requests, 0);
  assert.equal(planned.status, 'READY_TO_PUBLISH');
  assert.equal(planned.planned, true);
  assert.equal(planned.published, false);
  assert.equal(planned.time_source, 'fallback');
  assert.equal(planned.publisher_payload.target_network, 'facebook_page');
  assert.equal(planned.publisher_payload.media[0].url, planned.download_url);
  assert.equal(Object.hasOwn(planned.publisher_payload, 'user_id'), false);
  assert.equal(result.scheduled_count, 0);
});

test('source A failure is isolated and source B still completes the pipeline', async () => {
  let downloads = 0;
  const rig = createRig({
    sources: [
      { id: 'source-a', name: 'source-a', enabled: true },
      { id: 'source-b', name: 'source-b', enabled: true },
    ],
    videos: [approvedVideo('40001', { username: 'source-b', source_url: 'https://www.tiktok.com/@source-b/video/40001' })],
    downloadVideo: async (_url, jobId) => { downloads += 1; return { filename: `${jobId}.mp4`, size: 42 }; },
  });
  const result = await rig.runner.runOnce({
    fetcher: async (source) => {
      if (source.id === 'source-a') throw new Error('source temporarily unavailable');
      return [approvedVideo('40001', { username: 'source-b', source_url: 'https://www.tiktok.com/@source-b/video/40001' })];
    },
    dryRun: false,
  });
  assert.equal(result.source_errors.length, 1);
  assert.equal(result.scheduled.length, 1);
  assert.equal(downloads, 1);
});

test('full happy path follows download, validation, caption, time, then publisher order', async () => {
  const events = [];
  const rig = createRig({
    downloadVideo: async (_url, jobId) => { events.push('download'); return { filename: `${jobId}.mp4`, size: 42 }; },
    validateVideo: async () => { events.push('validate'); return { valid: true, size: 42 }; },
    captionGenerator: () => { events.push('caption'); return 'Caption full path'; },
    bestPostingTimeProvider: { async getNextBestTime() {
      events.push('publication-time');
      return { best_posting_datetime: '2026-10-05T10:00:00.000Z', timezone: 'Asia/Jayapura', provider: 'fixed_fallback', recommended: false };
    } },
    publisher: async () => { events.push('publisher'); return { success: true, status: 'SCHEDULED', publication_id: 'full-path' }; },
  });
  const result = await rig.run();
  assert.deepEqual(events, ['download', 'validate', 'caption', 'publication-time', 'publisher']);
  assert.equal(result.summary.scheduled, 1);
});

test('restart with the same persistent store does not duplicate publication', async () => {
  const store = createStore();
  let downloads = 0;
  let publishes = 0;
  const shared = {
    store,
    downloadVideo: async (_url, jobId) => { downloads += 1; return { filename: `${jobId}.mp4`, size: 42 }; },
    publisher: async () => { publishes += 1; return { success: true, status: 'SCHEDULED', publication_id: 'persisted' }; },
  };
  await createRig(shared).run();
  await createRig(shared).run();
  assert.equal(downloads, 1);
  assert.equal(publishes, 1);
});

test('restart resumes a completed download without downloading the video again', async () => {
  const store = createStore();
  await store.set('27001', {
    video_id: '27001',
    job_id: 'existing-download-job',
    status: 'COMPLETED',
    title: 'Yesus Kristus memberkati kita hari ini',
    content_category: 'christian',
    christian_score: 95,
    source_account: 'source-a',
    filename: 'existing-download-job.mp4',
    size: 42,
    source_url: 'https://www.tiktok.com/@source-a/video/27001',
    filter_status: 'APPROVED',
  });
  let downloads = 0;
  const rig = createRig({
    store,
    videos: [approvedVideo('27001')],
    downloadVideo: async () => { downloads += 1; return { filename: 'unexpected.mp4', size: 42 }; },
  });
  const result = await rig.run();
  assert.equal(downloads, 0);
  assert.equal(result.scheduled.length, 1);
  assert.equal(result.scheduled[0].job_id, 'existing-download-job');
});

test('a failed download is eligible for a safe retry on a later pipeline run', async () => {
  const store = createStore();
  await store.set('28001', {
    video_id: '28001',
    job_id: 'retry-download-job',
    status: 'FAILED',
    failure_stage: 'DOWNLOAD_OR_PREPARE',
    source_url: 'https://www.tiktok.com/@source-a/video/28001',
  });
  let downloads = 0;
  const rig = createRig({
    store,
    videos: [approvedVideo('28001')],
    downloadVideo: async (_url, jobId) => {
      downloads += 1;
      return { filename: `${jobId}.mp4`, size: 42 };
    },
  });
  const result = await rig.run();
  assert.equal(downloads, 1);
  assert.equal(result.scheduled.length, 1);
  assert.equal((await store.get('28001')).status, 'SCHEDULED');
});

test('video exceeding MAX_FILE_SIZE_MB is rejected before publishing', async () => {
  let publishes = 0;
  const rig = createRig({
    maxPostsPerRun: 1,
    validateVideo: async () => ({ valid: true, size: 2048 }),
    publisher: async () => { publishes += 1; },
  });
  rig.runner.maxFileSizeBytes = 1024;
  const result = await rig.run();
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /maximum allowed size/i);
  assert.equal(publishes, 0);
});

test('non-TikTok URLs are rejected before the downloader sees them', async () => {
  let downloads = 0;
  const rig = createRig({
    videos: [approvedVideo('50001', { source_url: 'https://evil.example/@source-a/video/50001' })],
    downloadVideo: async () => { downloads += 1; return { filename: 'x.mp4', size: 10 }; },
  });
  const result = await rig.run();
  assert.equal(result.failed.length, 1);
  assert.equal(downloads, 0);
});
