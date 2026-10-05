import { getNextZonedTime } from './zoned-time.js';

export class FixedTimeProvider {
  constructor({ timezone = process.env.AUTOMATION_TIMEZONE || 'Asia/Jayapura', hour, minute } = {}) {
    this.timezone = timezone;
    const configuredHour = Number(hour ?? process.env.DEFAULT_PUBLICATION_HOUR ?? 19);
    const configuredMinute = Number(minute ?? process.env.DEFAULT_PUBLICATION_MINUTE ?? 0);
    this.hour = Number.isInteger(configuredHour) && configuredHour >= 0 && configuredHour <= 23 ? configuredHour : 19;
    this.minute = Number.isInteger(configuredMinute) && configuredMinute >= 0 && configuredMinute <= 59 ? configuredMinute : 0;
  }

  async getNextBestTime({ referenceDate = new Date(), timezone = this.timezone } = {}) {
    const next = getNextZonedTime({
      now: new Date(referenceDate),
      timezone,
      hour: this.hour,
      minute: this.minute,
    });

    return {
      best_posting_datetime: next.toISOString(),
      timezone,
      provider: 'fixed_fallback',
      recommended: false,
      note: 'Configured fallback time; not a Metricool recommendation.',
    };
  }
}

export class MetricoolBestTimeProvider {
  constructor({ metricoolLookup, fallbackProvider = new FixedTimeProvider() } = {}) {
    this.metricoolLookup = metricoolLookup;
    this.fallbackProvider = fallbackProvider;
  }

  async getNextBestTime(context = {}) {
    if (typeof this.metricoolLookup === 'function') {
      try {
        const result = await this.metricoolLookup(context);
        if (result?.best_posting_datetime) {
          return { ...result, provider: 'metricool', recommended: true };
        }
      } catch {
        return this.fallbackProvider.getNextBestTime(context);
      }
    }

    return this.fallbackProvider.getNextBestTime(context);
  }
}

export const defaultBestPostingTimeProvider = new MetricoolBestTimeProvider();