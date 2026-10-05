import { getNextZonedTime } from './zoned-time.js';

export function calculateBestPostingTime({ timezone = 'Asia/Jayapura', referenceDate = new Date() } = {}) {
  const hour = Number(process.env.DEFAULT_PUBLICATION_HOUR ?? 19);
  const minute = Number(process.env.DEFAULT_PUBLICATION_MINUTE ?? 0);
  const candidate = getNextZonedTime({
    now: new Date(referenceDate),
    timezone,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 19,
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0,
  });

  return {
    timezone,
    best_posting_datetime: candidate.toISOString(),
    provider: 'fixed_fallback',
    recommended: false,
    note: 'Configured fallback time; not a Metricool recommendation.',
  };
}

export function buildMetricoolNativeVideoPayload({ videoUrl, caption, brandId = '7241347', bestPostingTime, timezone = 'Asia/Jayapura' } = {}) {
  return {
    platform: 'facebook_page',
    brand_id: brandId,
    content_type: 'NATIVE_VIDEO',
    video_url: videoUrl,
    caption,
    timezone,
    best_posting_time: bestPostingTime || null,
  };
}

export function getMetricoolConfig({ brandId, timezone, apiBaseUrl } = {}) {
  const configuredBrandId = brandId || process.env.METRICOOL_BRAND_ID || '7241347';
  const configuredTimezone = timezone || process.env.METRICOOL_TIMEZONE || 'Asia/Jayapura';
  const configuredApiBaseUrl = apiBaseUrl || process.env.METRICOOL_API_BASE_URL || 'https://api.metricool.com/v1';

  return {
    api_token: process.env.METRICOOL_API_TOKEN || '',
    user_id: process.env.METRICOOL_USER_ID || '',
    brand_id: configuredBrandId,
    timezone: configuredTimezone,
    api_base_url: configuredApiBaseUrl,
  };
}

export function resolveHttpsUrl(value) {
  if (!value) throw new Error('Video URL is required');

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      throw new Error('Public video URL must use HTTPS.');
    }
    if (!url.hostname || url.username || url.password) {
      throw new Error('Public video URL must not contain credentials and must have a hostname.');
    }
    return url.toString();
  } catch (error) {
    throw new Error(error.message || 'Video URL is invalid');
  }
}

export function shouldAllowPublish(job = {}) {
  if (!job || typeof job !== 'object') {
    return { allowed: false, status: 'INVALID', reason: 'Invalid job payload.' };
  }

  const filterStatus = String(job.filter_status || job.status || '').toUpperCase();
  if (filterStatus === 'APPROVED') {
    return { allowed: true, status: 'APPROVED', reason: 'Job is approved for publication.' };
  }

  if (!job.job_id) {
    return { allowed: false, status: 'INVALID', reason: 'Invalid job_id' };
  }

  if (filterStatus === 'REVIEW') {
    return { allowed: false, status: 'REVIEW', reason: 'Job is under review and cannot be published automatically.' };
  }

  if (filterStatus === 'SKIPPED') {
    return { allowed: false, status: 'SKIPPED', reason: 'Job was filtered out and cannot be published.' };
  }

  return { allowed: false, status: filterStatus || 'REJECTED', reason: 'Job is not approved for publication.' };
}

export function buildMetricoolPostPayload({ job, videoUrl, publicationDate, brandId, timezone, targetNetwork = 'facebook_page', userId } = {}) {
  if (targetNetwork !== 'facebook_page') {
    throw new Error('Only the facebook_page target network is supported.');
  }
  const finalVideoUrl = resolveHttpsUrl(videoUrl || job?.download_url || job?.video_url || '');
  const config = getMetricoolConfig({ brandId, timezone });
  const publicationDateValue = publicationDate || job?.publication_date || null;

  return {
    job_id: job?.job_id || null,
    video_id: job?.video_id || null,
    source_account: job?.source_account || null,
    target_network: targetNetwork,
    target: targetNetwork,
    brand_id: config.brand_id,
    user_id: userId || config.user_id || null,
    type: 'NATIVE_VIDEO',
    post_type: 'native_video',
    content_type: 'NATIVE_VIDEO',
    caption: job?.caption || '',
    publication_date: publicationDateValue,
    scheduled_at: publicationDateValue,
    timezone: timezone || config.timezone,
    media: [{ type: 'video', url: finalVideoUrl, source: 'public_url' }],
  };
}

export async function publishScheduledVideo({
  job,
  publicationDate,
  brandId,
  timezone,
  dryRun = false,
  idempotencyMap = new Map(),
  httpClient = globalThis.fetch,
} = {}) {
  if (!job || !job.job_id) {
    throw new Error('Invalid job_id');
  }

  if (idempotencyMap && idempotencyMap.has(job.job_id)) {
    return idempotencyMap.get(job.job_id);
  }

  const allowResult = shouldAllowPublish(job);
  if (!allowResult.allowed) {
    return {
      success: false,
      dry_run: Boolean(dryRun),
      status: allowResult.status,
      error: allowResult.reason,
      job_id: job.job_id,
    };
  }

  const videoUrl = resolveHttpsUrl(job.download_url || job.video_url || '');

  if (dryRun) {
    const response = {
      success: true,
      dry_run: true,
      status: 'SCHEDULED',
      job_id: job.job_id,
      publication_id: `dry-run-${job.job_id}`,
      target_network: 'facebook_page',
      video_url: videoUrl,
      publication_date: publicationDate || job.publication_date || null,
      timezone: timezone || process.env.METRICOOL_TIMEZONE || 'Asia/Jayapura',
    };

    if (idempotencyMap) idempotencyMap.set(job.job_id, response);
    return response;
  }

  const config = getMetricoolConfig({ brandId, timezone });
  if (!config.api_token || !config.user_id) {
    throw new Error('Metricool credentials not configured. Set METRICOOL_API_TOKEN and METRICOOL_USER_ID.');
  }

  const payload = buildMetricoolPostPayload({
    job,
    videoUrl,
    publicationDate,
    brandId: config.brand_id,
    timezone: config.timezone,
  });

  const endpoint = `${config.api_base_url.replace(/\/+$/, '')}/posts`;
  if (new URL(endpoint).protocol !== 'https:') {
    throw new Error('Metricool API endpoint must use HTTPS.');
  }
  const response = await httpClient(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.api_token}`,
      'Content-Type': 'application/json',
      'X-User-ID': config.user_id,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Metricool API request failed with HTTP ${response.status}.`);
  }

  const data = await response.json().catch(() => ({}));
  const publication = data.publication || data.post || data.data || data;
  const result = {
    success: true,
    dry_run: false,
    status: publication?.status || 'SCHEDULED',
    publication_id: publication?.id || publication?.publication_id || `metricool-${job.job_id}`,
    job_id: job.job_id,
    target_network: 'facebook_page',
    video_url: videoUrl,
    publication_date: publicationDate || job.publication_date || null,
    timezone: timezone || config.timezone,
  };

  if (idempotencyMap) idempotencyMap.set(job.job_id, result);
  return result;
}
