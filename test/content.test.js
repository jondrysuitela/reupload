import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { getAllowedTikTokAccounts, isTikTokSourceAllowed, parseTikTokUrl } from '../src/services/tiktok.js';
import { classifyContent, scoreChristianContent } from '../src/services/christian-filter.js';
import {
  shouldAllowPublish,
  buildMetricoolPostPayload,
  publishScheduledVideo,
  resolveHttpsUrl,
  getMetricoolConfig,
} from '../src/services/publisher.js';
import { SourceRegistry } from '../src/services/source-registry.js';
import { FileKVStore } from '../src/services/persistent-store.js';
import { DiscoveryService } from '../src/services/discovery-service.js';
import { AutomationRunner } from '../src/services/automation-runner.js';

test('allowlist accepts legacy and multi-source env values', () => {
  assert.deepEqual(getAllowedTikTokAccounts('wiwelgeng'), ['wiwelgeng']);
  assert.deepEqual(getAllowedTikTokAccounts('wiwelgeng,sumber2,sumber3'), ['wiwelgeng', 'sumber2', 'sumber3']);
  assert.deepEqual(getAllowedTikTokAccounts(''), []);
});

test('source validation allows explicit multi-source usernames when no allowlist is configured', () => {
  assert.equal(isTikTokSourceAllowed('wiwelgeng', []), true);
  assert.equal(isTikTokSourceAllowed('sumber2', []), true);
  assert.equal(isTikTokSourceAllowed('sumber2', ['wiwelgeng']), false);
  assert.equal(isTikTokSourceAllowed('wiwelgeng', ['wiwelgeng', 'sumber2']), true);
});

test('TikTok URL parser requires HTTPS and a TikTok host', () => {
  assert.equal(parseTikTokUrl('https://www.tiktok.com/@wiwelgeng/video/12345').videoId, '12345');
  assert.throws(() => parseTikTokUrl('http://www.tiktok.com/@wiwelgeng/video/12345'), /HTTPS/i);
  assert.throws(() => parseTikTokUrl('https://evil.example/@wiwelgeng/video/12345'), /Only TikTok/i);
});

test('christian scoring identifies faith-based content and rejects irrelevant videos', () => {
  const pass = scoreChristianContent({ title: 'Yesus Kristus memberkati kita hari ini', description: 'Renungan Kristen dan firman Tuhan' });
  const skip = scoreChristianContent({ title: 'Funny dance challenge', description: 'Best memes and comedy' });

  assert.ok(pass.score >= 80);
  assert.equal(pass.status, 'APPROVED');
  assert.equal(skip.status, 'SKIPPED');

  const result = classifyContent({ title: 'Khotbah dan doa Kristen', description: 'Worship untuk keluarga Kristen' });
  assert.equal(result.category, 'christian');
  assert.equal(result.status, 'APPROVED');
});

test('APPROVED jobs may be published and REVIEW or SKIPPED jobs are rejected', () => {
  assert.equal(shouldAllowPublish({ filter_status: 'APPROVED' }).allowed, true);
  assert.equal(shouldAllowPublish({ filter_status: 'REVIEW' }).allowed, false);
  assert.equal(shouldAllowPublish({ filter_status: 'SKIPPED' }).allowed, false);
});

test('Metricool payload requires a public HTTPS video URL and dry-run can be simulated', async () => {
  const url = 'https://example.com/api/video/test.mp4';
  const payload = buildMetricoolPostPayload({
    job: { job_id: 'abc', caption: 'Uji coba', filter_status: 'APPROVED' },
    publicationDate: '2026-10-06T17:00:00+09:00',
    videoUrl: url,
    brandId: '7241347',
    timezone: 'Asia/Jayapura',
  });

  assert.equal(payload.media[0].url, url);
  assert.equal(payload.post_type, 'native_video');

  const dryRun = await publishScheduledVideo({
    job: { job_id: 'dry-1', filter_status: 'APPROVED', caption: 'Tes dry run', download_url: url },
    publicationDate: '2026-10-06T17:00:00+09:00',
    dryRun: true,
  });

  assert.equal(dryRun.success, true);
  assert.equal(dryRun.dry_run, true);
  assert.equal(dryRun.status, 'SCHEDULED');
});

test('missing Metricool credentials produce a graceful error and duplicate jobs are idempotent', async () => {
  const original = process.env.METRICOOL_API_TOKEN;
  delete process.env.METRICOOL_API_TOKEN;
  delete process.env.METRICOOL_USER_ID;
  let err;
  try {
    await publishScheduledVideo({
      job: { job_id: 'dup-1', filter_status: 'APPROVED', caption: 'x', download_url: 'https://example.com/video.mp4' },
      publicationDate: '2026-10-06T17:00:00+09:00',
    });
  } catch (e) {
    err = e;
  } finally {
    if (original) process.env.METRICOOL_API_TOKEN = original;
  }

  assert.ok(err instanceof Error);
  assert.match(err.message, /credentials/i);

  const seen = new Map();
  const first = await publishScheduledVideo({
    job: { job_id: 'dup-2', filter_status: 'APPROVED', caption: 'x', download_url: 'https://example.com/video.mp4' },
    publicationDate: '2026-10-06T17:00:00+09:00',
    dryRun: true,
    idempotencyMap: seen,
  });
  const second = await publishScheduledVideo({
    job: { job_id: 'dup-2', filter_status: 'APPROVED', caption: 'x', download_url: 'https://example.com/video.mp4' },
    publicationDate: '2026-10-06T17:00:00+09:00',
    dryRun: true,
    idempotencyMap: seen,
  });

  assert.equal(second.publication_id, first.publication_id);
});

test('invalid or non-HTTPS video URLs are rejected before publishing', () => {
  assert.throws(() => resolveHttpsUrl('http://example.com/video.mp4'), /HTTPS/i);
  assert.throws(() => resolveHttpsUrl('https://user:secret@example.com/video.mp4'), /credentials/i);
  assert.throws(() => buildMetricoolPostPayload({ job: { job_id: 'a' }, videoUrl: 'ftp://example.com/video.mp4' }), /HTTPS/i);
  assert.throws(() => buildMetricoolPostPayload({ job: { job_id: 'a' }, videoUrl: 'https://example.com/video.mp4', targetNetwork: 'instagram' }), /facebook_page/i);
  assert.ok(getMetricoolConfig().brand_id === '7241347' || getMetricoolConfig().brand_id !== undefined);
});

test('Metricool failures and results do not reflect raw response secrets', async () => {
  const names = ['METRICOOL_API_TOKEN', 'METRICOOL_USER_ID', 'METRICOOL_API_BASE_URL'];
  const original = new Map(names.map((name) => [name, process.env[name]]));
  const tokenFixture = `test-${randomUUID()}`;
  const userFixture = `test-user-${randomUUID()}`;
  process.env.METRICOOL_API_TOKEN = tokenFixture;
  process.env.METRICOOL_USER_ID = userFixture;
  process.env.METRICOOL_API_BASE_URL = 'https://metricool.example.test/v1';

  try {
    await assert.rejects(
      publishScheduledVideo({
        job: { job_id: 'safe-error', filter_status: 'APPROVED', download_url: 'https://media.example.test/video.mp4' },
        httpClient: async () => ({
          ok: false,
          status: 500,
          text: async () => tokenFixture,
        }),
      }),
      (error) => error.message.includes('HTTP 500') && !error.message.includes(tokenFixture),
    );

    const result = await publishScheduledVideo({
      job: { job_id: 'safe-result', video_id: '123', filter_status: 'APPROVED', download_url: 'https://media.example.test/video.mp4' },
      httpClient: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ publication: { id: 'accepted-1', status: 'SCHEDULED', api_token: tokenFixture } }),
      }),
    });
    assert.equal(result.publication_id, 'accepted-1');
    assert.equal(Object.hasOwn(result, 'raw'), false);
    assert.equal(JSON.stringify(result).includes(tokenFixture), false);
    assert.equal(JSON.stringify(result).includes(userFixture), false);
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('source registry supports add/enable/disable/list/get operations', () => {
  const registry = new SourceRegistry();
  registry.addSource({ id: 'source-a', name: 'source-a', enabled: true, priority: 3 });
  registry.addSource({ id: 'source-b', name: 'source-b', enabled: false, priority: 1 });

  assert.equal(registry.getSource('source-a').enabled, true);
  assert.equal(registry.listSources().length, 2);

  registry.disableSource('source-a');
  assert.equal(registry.getSource('source-a').enabled, false);

  registry.enableSource('source-a');
  assert.equal(registry.getSource('source-a').enabled, true);

  registry.removeSource('source-b');
  assert.equal(registry.getSource('source-b'), undefined);
});

test('persistent storage tracks status transitions for discovered videos', async () => {
  const store = new FileKVStore({ dataDir: './tmp-storage-test' });
  await store.set('video-1', {
    video_id: 'video-1',
    status: 'DISCOVERED',
    title: 'Yesus Kristus memberkati kita',
  });

  await store.transition('video-1', 'DISCOVERED', 'APPROVED', { note: 'Christian scoring threshold met' });
  const record = await store.get('video-1');

  assert.equal(record.status, 'APPROVED');
  assert.equal(record.status_history.length, 2);
});

test('discovery service only keeps approved Christian candidates and deduplicates by video_id', async () => {
  const registry = new SourceRegistry();
  registry.addSource({ id: 'faith-source', name: 'faith-source', enabled: true, priority: 10 });

  const service = new DiscoveryService({ registry, dataDir: './tmp-discovery-test' });
  const candidates = await service.discoverCandidates({
    sourceNames: ['faith-source'],
    fetcher: async () => [{
      video_id: 'v-1',
      title: 'Yesus Kristus memberkati kita hari ini',
      description: 'Renungan Kristen dan firman Tuhan',
      username: 'faithfuel',
    }, {
      video_id: 'v-1',
      title: 'Yesus Kristus memberkati kita hari ini',
      description: 'Renungan Kristen dan firman Tuhan',
      username: 'faithfuel',
    }, {
      video_id: 'v-2',
      title: 'Funny dance challenge',
      description: 'Best memes and comedy',
      username: 'funny',
    }],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].video_id, 'v-1');
  assert.equal(candidates[0].status, 'APPROVED');
});

test('automation runner selects the top approved Christian posts up to maxPostsPerRun', async () => {
  const registry = new SourceRegistry();
  registry.addSource({ id: 'source-1', name: 'source-1', enabled: true, priority: 5 });
  const records = new Map();
  const store = {
    async get(key) { return records.get(key) || null; },
    async set(key, value) { records.set(key, value); return value; },
    async transition(key, _from, to, metadata) {
      const record = { ...(records.get(key) || {}), ...metadata, status: to };
      records.set(key, record);
      return record;
    },
  };

  const runner = new AutomationRunner({
    registry,
    store,
    maxPostsPerRun: 2,
  });

  const result = await runner.runOnce({
    fetcher: async () => [
      { video_id: 'a', title: 'Doa Kristen setiap pagi', description: 'Khotbah dan doa Kristen', username: 'source-1' },
      { video_id: 'b', title: 'Funny dance challenge', description: 'Meme viral', username: 'source-1' },
      { video_id: 'c', title: 'Renungan iman dan kasih karunia', description: 'FaithFuel untuk keluarga Kristen', username: 'source-1' },
    ],
  });

  assert.equal(result.approved.length, 2);
  assert.equal(result.skipped.length, 1);
  assert.ok(result.approved.every((item) => item.status === 'APPROVED'));
});
