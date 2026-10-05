import crypto from 'node:crypto';
import { getLocalDateKey, getNextZonedTime, getZonedParts } from './zoned-time.js';

const STATE_KEY = '_scheduler_state';

export class AutomationScheduler {
  constructor({
    runner,
    store,
    enabled = process.env.AUTOMATION_ENABLED === 'true',
    timezone = process.env.AUTOMATION_TIMEZONE || 'Asia/Jayapura',
    hour = Number(process.env.AUTOMATION_RUN_HOUR ?? 10),
    minute = Number(process.env.AUTOMATION_RUN_MINUTE ?? 0),
    maxPostsPerDay = Number(process.env.MAX_POSTS_PER_DAY ?? 1),
    dryRun = process.env.AUTOMATION_DRY_RUN === 'true' || process.env.PUBLISHER_DRY_RUN === 'true',
    fetcher,
    clock = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    logger = console,
  } = {}) {
    this.runner = runner;
    this.store = store;
    this.enabled = Boolean(enabled);
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
      this.timezone = timezone;
    } catch {
      this.timezone = 'Asia/Jayapura';
    }
    this.hour = Number.isInteger(Number(hour)) && Number(hour) >= 0 && Number(hour) <= 23 ? Number(hour) : 10;
    this.minute = Number.isInteger(Number(minute)) && Number(minute) >= 0 && Number(minute) <= 59 ? Number(minute) : 0;
    this.maxPostsPerDay = Math.max(0, Number(maxPostsPerDay) || 0);
    this.dryRun = Boolean(dryRun);
    this.fetcher = fetcher;
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.logger = logger;
    this.timer = null;
    this.starting = null;
    this.running = false;
    this.stopping = false;
    this.activeRun = null;
    this.currentRun = null;
    this.state = {
      last_run_started_at: null,
      last_run_completed_at: null,
      last_run_status: null,
      last_run_summary: null,
      current_run_id: null,
      current_run: null,
      last_run_date: null,
      daily_counts: {},
      source_errors: [],
    };
  }

  async loadState() {
    if (!this.store) return;
    const saved = await this.store.get(STATE_KEY);
    if (saved && typeof saved === 'object') {
      this.state = { ...this.state, ...saved };
      if (this.state.last_run_status === 'RUNNING') {
        this.state.last_run_status = 'FAILED';
        this.state.last_run_completed_at = this.clock().toISOString();
        this.state.last_run_summary = { error: 'Process restarted while a run was active.' };
        this.state.current_run_id = null;
        this.state.current_run = null;
        await this.persistState();
      }
    }
  }

  async persistState() {
    if (this.store) await this.store.set(STATE_KEY, this.state);
  }

  getDailyCount(dateKey = getLocalDateKey(this.clock(), this.timezone)) {
    return Number(this.state.daily_counts?.[dateKey] || 0);
  }

  getNextRun(now = this.clock()) {
    if (!this.enabled || this.stopping) return null;
    let next = getNextZonedTime({ now, timezone: this.timezone, hour: this.hour, minute: this.minute });
    const todayKey = getLocalDateKey(now, this.timezone);
    if (this.state.last_run_date === todayKey && next <= now) {
      next = getNextZonedTime({ now: new Date(now.getTime() + 1000), timezone: this.timezone, hour: this.hour, minute: this.minute });
    }
    return next;
  }

  async start() {
    if (this.starting) return this.starting;
    if (this.timer || (this.stopping && this.activeRun)) return this.getStatus();
    this.starting = (async () => {
      await this.loadState();
      if (this.enabled) {
        this.stopping = false;
        await this.scheduleNextTick();
      }
      return this.getStatus();
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async scheduleNextTick() {
    if (!this.enabled || this.stopping || this.timer) return;
    const now = this.clock();
    const local = getZonedParts(now, this.timezone);
    const localMinutes = Number(local.hour) * 60 + Number(local.minute);
    const scheduleMinutes = this.hour * 60 + this.minute;
    const dateKey = getLocalDateKey(now, this.timezone);

    if (localMinutes >= scheduleMinutes && this.state.last_run_date !== dateKey) {
      await this.run({ trigger: 'scheduler' });
      return;
    }

    const nextRun = this.getNextRun(now);
    if (!nextRun) return;
    const delay = Math.max(1000, Math.min(nextRun.getTime() - now.getTime(), 2147483647));
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.scheduleNextTick().catch((error) => this.logError('scheduler_tick_failed', error));
    }, delay);
    this.timer?.unref?.();
  }

  async run({ trigger = 'manual', sourceNames = [], maxPostsPerRun, dryRun = false } = {}) {
    if (this.running) {
      return { success: false, status: 'RUN_ALREADY_IN_PROGRESS', run_id: this.state.current_run_id };
    }
    if (this.stopping) {
      return { success: false, status: 'SCHEDULER_STOPPING' };
    }

    await this.loadState();
    const started = this.clock();
    const dateKey = getLocalDateKey(started, this.timezone);
    if (this.state.last_run_date === dateKey) {
      return { success: false, status: 'DAILY_RUN_ALREADY_STARTED', last_run_date: dateKey };
    }

    const runId = crypto.randomUUID();
    const remaining = Math.max(0, this.maxPostsPerDay - this.getDailyCount(dateKey));
    const requestedLimit = Number(maxPostsPerRun);
    const configuredLimit = Number.isFinite(requestedLimit)
      ? Math.max(0, requestedLimit)
      : Number(process.env.MAX_POSTS_PER_RUN || 1);
    const runLimit = Math.min(Math.max(0, configuredLimit), remaining);
    const effectiveDryRun = this.dryRun || dryRun === true;
    this.running = true;
    this.state = {
      ...this.state,
      last_run_started_at: started.toISOString(),
      last_run_status: 'RUNNING',
      last_run_summary: null,
      current_run_id: runId,
      current_run: {
        run_id: runId,
        status: 'RUNNING',
        started_at: started.toISOString(),
        discovered: 0,
        approved: 0,
        downloaded: 0,
        ready_to_publish: 0,
        scheduled: 0,
        failed: 0,
      },
      last_run_date: dateKey,
    };
    this.currentRun = this.state.current_run;
    await this.persistState();
    this.logger.info?.(JSON.stringify({ event: 'automation_run_started', run_id: runId, started_at: started.toISOString(), trigger }));

    this.activeRun = (async () => {
      let result;
      let error = null;
      try {
        result = await this.runner.runOnce({
          fetcher: this.fetcher,
          sourceNames,
          dryRun: effectiveDryRun,
          maxPostsPerRun: runLimit,
          onProgress: (progress) => {
            this.currentRun = { ...this.currentRun, ...progress };
          },
        });
      } catch (caught) {
        error = caught;
      }

      const completed = this.clock();
      const pipelineSummary = result?.summary || {};
      const approved = Number(pipelineSummary.approved ?? result?.approved?.length ?? 0);
      const scheduled = Number(result?.scheduled_count ?? result?.scheduled?.length ?? 0);
      const summary = {
        source_count: result?.source_count || 0,
        discovered: Number(pipelineSummary.discovered ?? result?.total_candidates ?? 0),
        analyzed: Number(pipelineSummary.analyzed ?? result?.total_candidates ?? 0),
        approved,
        review: Number(pipelineSummary.review ?? result?.review?.length ?? result?.review_count ?? 0),
        skipped: Number(pipelineSummary.skipped ?? result?.skipped?.length ?? 0),
        downloading: Number(pipelineSummary.downloading ?? result?.downloading?.length ?? 0),
        downloaded: Number(pipelineSummary.downloaded ?? result?.downloaded?.length ?? 0),
        ready_to_publish: Number(pipelineSummary.ready_to_publish ?? result?.ready_to_publish?.length ?? 0),
        scheduled,
        failed: Number(pipelineSummary.failed ?? result?.failed?.length ?? 0) + (error ? 1 : 0),
        duplicates: Number(pipelineSummary.duplicates ?? result?.duplicates?.length ?? 0),
        discovered_count: Number(pipelineSummary.discovered ?? result?.total_candidates ?? 0),
        approved_count: approved,
        review_count: Number(pipelineSummary.review ?? result?.review?.length ?? result?.review_count ?? 0),
        skipped_count: Number(pipelineSummary.skipped ?? result?.skipped?.length ?? 0),
        scheduled_count: scheduled,
        failed_count: Number(pipelineSummary.failed ?? result?.failed?.length ?? 0) + (error ? 1 : 0),
        source_errors: result?.source_errors || [],
        daily_limit: this.maxPostsPerDay,
        daily_count: this.getDailyCount(dateKey) + scheduled,
        dry_run: effectiveDryRun,
        ...(error ? { error: error.message || 'Automation run failed' } : {}),
      };

      this.state = {
        ...this.state,
        last_run_completed_at: completed.toISOString(),
        last_run_status: error ? 'FAILED' : summary.failed_count ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
        last_run_summary: summary,
        current_run_id: null,
        current_run: null,
        daily_counts: { [dateKey]: summary.daily_count },
        source_errors: result?.source_errors || [],
      };
      this.running = false;
      this.activeRun = null;
      this.currentRun = null;
      await this.persistState();
      this.logger.info?.(JSON.stringify({ event: 'automation_run_completed', run_id: runId, ended_at: completed.toISOString(), ...summary }));

      if (!this.stopping) await this.scheduleNextTick();
      if (error) return { success: false, status: 'FAILED', run_id: runId, error: summary.error, summary };
      return {
        ...result,
        success: true,
        status: this.state.last_run_status,
        run_id: runId,
        pipeline_summary: result?.summary || null,
        summary,
      };
    })();

    return this.activeRun;
  }

  async runManual(options = {}) {
    return this.run({ ...options, trigger: 'manual' });
  }

  async stop({ waitForActive = true } = {}) {
    this.stopping = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (waitForActive && this.activeRun) await this.activeRun;
    return this.getStatus();
  }

  getStatus() {
    return {
      enabled: this.enabled,
      timezone: this.timezone,
      scheduled_time: `${String(this.hour).padStart(2, '0')}:${String(this.minute).padStart(2, '0')}`,
      running: this.running,
      next_run: this.getNextRun()?.toISOString() || null,
      last_run: this.state.last_run_started_at,
      last_run_completed_at: this.state.last_run_completed_at,
      last_run_status: this.state.last_run_status,
      last_run_summary: this.state.last_run_summary,
      current_run_id: this.state.current_run_id,
      current_run: this.currentRun || this.state.current_run || null,
      discovered: this.currentRun?.discovered ?? this.state.last_run_summary?.discovered ?? 0,
      approved: this.currentRun?.approved ?? this.state.last_run_summary?.approved ?? 0,
      downloaded: this.currentRun?.downloaded ?? this.state.last_run_summary?.downloaded ?? 0,
      ready_to_publish: this.currentRun?.ready_to_publish ?? this.state.last_run_summary?.ready_to_publish ?? 0,
      scheduled: this.currentRun?.scheduled ?? this.state.last_run_summary?.scheduled ?? 0,
      failed: this.currentRun?.failed ?? this.state.last_run_summary?.failed ?? 0,
      daily_count: this.getDailyCount(),
      max_posts_per_day: this.maxPostsPerDay,
      dry_run: this.dryRun,
    };
  }

  logError(event, error) {
    this.logger.error?.(JSON.stringify({ event, error: error?.message || String(error), at: this.clock().toISOString() }));
  }
}