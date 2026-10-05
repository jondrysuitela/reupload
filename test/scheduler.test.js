import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AutomationScheduler } from '../src/services/scheduler.js';
import { FixedTimeProvider, MetricoolBestTimeProvider } from '../src/services/best-posting-time-provider.js';
import { getLocalDateKey, getNextZonedTime } from '../src/services/zoned-time.js';
import { DiscoveryService } from '../src/services/discovery-service.js';
import { SourceRegistry } from '../src/services/source-registry.js';
import { FileKVStore } from '../src/services/persistent-store.js';

const fixedNow = () => new Date('2026-10-05T00:00:00.000Z');

function createMemoryStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); return value; },
    values,
  };
}

function createTimerHarness() {
  const timers = new Set();
  return {
    timers,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) { timers.delete(timer); },
  };
}

function createScheduler(options = {}) {
  const timerHarness = createTimerHarness();
  const scheduler = new AutomationScheduler({
    runner: { async runOnce() { return { approved: [], skipped: [], source_count: 0, total_candidates: 0 }; } },
    store: createMemoryStore(),
    enabled: true,
    timezone: 'Asia/Jayapura',
    hour: 10,
    minute: 0,
    clock: fixedNow,
    setTimer: timerHarness.setTimer,
    clearTimer: timerHarness.clearTimer,
    logger: { info() {}, error() {} },
    ...options,
  });
  return { scheduler, timerHarness };
}

test('scheduler starts once and stops its timer cleanly', async () => {
  const { scheduler, timerHarness } = createScheduler();
  await Promise.all([scheduler.start(), scheduler.start()]);
  assert.equal(timerHarness.timers.size, 1);
  await scheduler.stop();
  assert.equal(timerHarness.timers.size, 0);
  assert.equal(scheduler.getStatus().enabled, true);
  await scheduler.start();
  assert.equal(timerHarness.timers.size, 1);
  await scheduler.stop();
});

test('timezone conversion and next run use Asia/Jayapura local time', () => {
  const next = getNextZonedTime({ now: fixedNow(), timezone: 'Asia/Jayapura', hour: 10, minute: 0 });
  assert.equal(next.toISOString(), '2026-10-05T01:00:00.000Z');
  assert.equal(getLocalDateKey(next, 'Asia/Jayapura'), '2026-10-05');
});

test('scheduler status reports the configured next run in UTC representation', async () => {
  const { scheduler } = createScheduler();
  await scheduler.start();
  assert.equal(scheduler.getStatus().next_run, '2026-10-05T01:00:00.000Z');
  assert.equal(scheduler.getStatus().scheduled_time, '10:00');
  await scheduler.stop();
});

test('overlapping manual runs return RUN_ALREADY_IN_PROGRESS', async () => {
  let finishRun;
  const runner = { runOnce: () => new Promise((resolve) => { finishRun = resolve; }) };
  const { scheduler } = createScheduler({ runner });
  const active = scheduler.runManual();
  await new Promise((resolve) => setImmediate(resolve));
  const overlapping = await scheduler.runManual();
  assert.equal(overlapping.status, 'RUN_ALREADY_IN_PROGRESS');
  finishRun({ approved: [], skipped: [], source_count: 1, total_candidates: 0 });
  assert.equal((await active).success, true);
});

test('manual execution calls the same runner and enforces the daily post limit', async () => {
  const calls = [];
  const runner = {
    async runOnce(options) {
      calls.push(options);
      return {
        approved: [{ video_id: 'approved-a' }],
        scheduled: [{ video_id: 'approved-a', status: 'SCHEDULED' }],
        scheduled_count: 1,
        summary: { approved: 1, scheduled: 1 },
        skipped: [],
        source_count: 2,
        total_candidates: 1,
      };
    },
  };
  const { scheduler } = createScheduler({ runner, maxPostsPerDay: 1, dryRun: true });
  const result = await scheduler.runManual({ maxPostsPerRun: 5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxPostsPerRun, 1);
  assert.equal(calls[0].dryRun, true);
  assert.equal(result.summary.daily_count, 1);
  assert.equal((await scheduler.runManual()).status, 'DAILY_RUN_ALREADY_STARTED');
});

test('daily count persists across scheduler instances and resets on local date change', async () => {
  const store = createMemoryStore();
  const runner = { async runOnce() {
    return {
      approved: [{ video_id: 'v' }],
      scheduled: [{ video_id: 'v', status: 'SCHEDULED' }],
      scheduled_count: 1,
      summary: { approved: 1, scheduled: 1 },
      skipped: [],
      source_count: 1,
      total_candidates: 1,
    };
  } };
  const first = createScheduler({ store, runner, maxPostsPerDay: 3 }).scheduler;
  await first.runManual();
  const restarted = createScheduler({ store, runner, maxPostsPerDay: 3 }).scheduler;
  await restarted.start();
  assert.equal(restarted.getStatus().daily_count, 1);
  assert.equal((await restarted.runManual()).status, 'DAILY_RUN_ALREADY_STARTED');
  await restarted.stop();

  const nextDay = createScheduler({
    store,
    runner,
    maxPostsPerDay: 3,
    clock: () => new Date('2026-10-05T16:00:00.000Z'),
  }).scheduler;
  await nextDay.start();
  assert.equal(nextDay.getStatus().daily_count, 0);
  await nextDay.stop();
});

test('restart recovery marks interrupted run failed and does not rerun its local date', async () => {
  const store = createMemoryStore({
    _scheduler_state: {
      last_run_started_at: '2026-10-05T00:30:00.000Z',
      last_run_status: 'RUNNING',
      current_run_id: 'interrupted-run',
      last_run_date: '2026-10-05',
      daily_counts: {},
    },
  });
  let runCalls = 0;
  const { scheduler } = createScheduler({ store, runner: { async runOnce() { runCalls += 1; } } });
  await scheduler.start();
  assert.equal(scheduler.getStatus().last_run_status, 'FAILED');
  assert.equal(scheduler.getStatus().current_run_id, null);
  assert.equal(runCalls, 0);
  await scheduler.stop();
});

test('runner failure is recorded and scheduler remains scheduled for the next cycle', async () => {
  const { scheduler, timerHarness } = createScheduler({ runner: { async runOnce() { throw new Error('source adapter failed'); } } });
  const result = await scheduler.runManual();
  assert.equal(result.status, 'FAILED');
  assert.equal(scheduler.getStatus().last_run_status, 'FAILED');
  assert.equal(timerHarness.timers.size, 1);
  await scheduler.stop();
});

test('disabled scheduler does not create timers or run automation', async () => {
  let runCalls = 0;
  const { scheduler, timerHarness } = createScheduler({ enabled: false, runner: { async runOnce() { runCalls += 1; } } });
  await scheduler.start();
  assert.equal(timerHarness.timers.size, 0);
  assert.equal(runCalls, 0);
  assert.equal(scheduler.getStatus().enabled, false);
});

test('graceful stop waits for an active run to finish', async () => {
  let finishRun;
  const { scheduler } = createScheduler({
    runner: { runOnce: () => new Promise((resolve) => { finishRun = resolve; }) },
  });
  const run = scheduler.runManual();
  await new Promise((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  finishRun({ approved: [], skipped: [], source_count: 1, total_candidates: 0 });
  await Promise.all([run, stopping]);
  assert.equal(stopped, true);
});

test('dry-run setting is passed through to AutomationRunner', async () => {
  let observedDryRun;
  const { scheduler } = createScheduler({
    dryRun: true,
    runner: { async runOnce(options) { observedDryRun = options.dryRun; return { approved: [], skipped: [] }; } },
  });
  await scheduler.runManual();
  assert.equal(observedDryRun, true);
  assert.equal(scheduler.getStatus().daily_count, 0);
});

test('scheduler status includes required observability fields without secrets', () => {
  const { scheduler } = createScheduler();
  const status = scheduler.getStatus();
  for (const field of ['enabled', 'timezone', 'scheduled_time', 'running', 'next_run', 'last_run', 'last_run_status', 'last_run_summary', 'current_run_id']) {
    assert.ok(Object.hasOwn(status, field), `missing ${field}`);
  }
  assert.equal(JSON.stringify(status).includes('METRICOOL_API_TOKEN'), false);
  assert.equal(JSON.stringify(status).includes('DOWNLOAD_TOKEN'), false);
});

test('fixed publication-time provider uses configured fallback and labels it non-recommended', async () => {
  const provider = new FixedTimeProvider({ timezone: 'Asia/Jayapura', hour: 19, minute: 15 });
  const result = await provider.getNextBestTime({ referenceDate: fixedNow() });
  assert.equal(result.best_posting_datetime, '2026-10-05T10:15:00.000Z');
  assert.equal(result.provider, 'fixed_fallback');
  assert.equal(result.recommended, false);
  assert.match(result.note, /not a Metricool recommendation/i);

  const metricool = new MetricoolBestTimeProvider({ fallbackProvider: provider });
  assert.equal((await metricool.getNextBestTime({ referenceDate: fixedNow() })).provider, 'fixed_fallback');
});

test('a source failure is recorded while later enabled sources are still processed', async () => {
  const registry = new SourceRegistry([
    { id: 'failed-source', name: 'failed-source', enabled: true },
    { id: 'working-source', name: 'working-source', enabled: true },
  ]);
  const service = new DiscoveryService({ registry, store: { async get() { return null; } } });
  const report = await service.discoverCandidatesWithReport({
    fetcher: async (source) => {
      if (source.id === 'failed-source') throw new Error('network unavailable');
      return [{ video_id: 'good-1', title: 'Yesus Kristus memberkati kita', description: 'Renungan Kristen' }];
    },
  });
  assert.equal(report.source_errors.length, 1);
  assert.equal(report.source_errors[0].source, 'failed-source');
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].video_id, 'good-1');
});

test('persistent scheduler data can be reloaded from the atomic JSON store', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-store-test-'));
  try {
    const first = new FileKVStore({ dataDir, namespace: 'scheduler-test' });
    await first.set('_scheduler_state', { last_run_date: '2026-10-05', daily_counts: { '2026-10-05': 1 } });
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'scheduler-test.json'), 'utf8'));
    const reloaded = new FileKVStore({ dataDir, namespace: 'scheduler-test' });
    assert.deepEqual(await reloaded.get('_scheduler_state'), persisted._scheduler_state);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('status endpoint exposes scheduler state and manual endpoint remains authenticated', async () => {
  const temporaryDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-api-test-'));
  const testDownloadToken = randomUUID();
  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
  const { port } = portServer.address();
  await new Promise((resolve) => portServer.close(resolve));

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: temporaryDataDir,
      DOWNLOAD_TOKEN: testDownloadToken,
      AUTOMATION_ENABLED: 'false',
      AUTOMATION_TIMEZONE: 'Asia/Jayapura',
      PUBLISHER_DRY_RUN: 'true',
    },
    stdio: 'ignore',
  });

  try {
    let response;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/automation/status`, { signal: AbortSignal.timeout(1000) });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    assert.ok(response, 'server did not start within the timeout');
    assert.equal(response.status, 200);
    const status = await response.json();
    for (const field of [
      'enabled', 'timezone', 'scheduled_time', 'running', 'next_run', 'last_run',
      'last_run_status', 'last_run_summary', 'current_run_id', 'current_run',
      'discovered', 'approved', 'downloaded', 'ready_to_publish', 'scheduled', 'failed', 'daily_count',
    ]) {
      assert.ok(Object.hasOwn(status, field), `missing ${field}`);
    }
    assert.equal(status.enabled, false);
    assert.equal(JSON.stringify(status).includes(testDownloadToken), false);

    const manualResponse = await fetch(`http://127.0.0.1:${port}/api/automation/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(manualResponse.status, 401);

    const unauthenticatedPublish = await fetch(`http://127.0.0.1:${port}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unauthenticatedPublish.status, 401);

    const dryRunResponse = await fetch(`http://127.0.0.1:${port}/api/automation/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-download-token': testDownloadToken },
      body: JSON.stringify({}),
    });
    assert.equal(dryRunResponse.status, 200);
    const dryRun = await dryRunResponse.json();
    assert.equal(dryRun.success, true);
    assert.equal(dryRun.dry_run, true);
    assert.equal(dryRun.approved.length, 0);
  } finally {
    const childExited = once(child, 'exit');
    child.kill('SIGTERM');
    await Promise.race([
      childExited,
      new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        timeout.unref();
      }),
    ]);
    await fs.rm(temporaryDataDir, { recursive: true, force: true });
  }
});