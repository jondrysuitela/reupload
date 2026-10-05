import { classifyContent } from './christian-filter.js';
import { FileKVStore } from './persistent-store.js';
import { SourceRegistry } from './source-registry.js';

const RESUMABLE_STATUSES = new Set(['READY_TO_PUBLISH', 'COMPLETED', 'DISCOVERED', 'ANALYZING', 'APPROVED', 'DOWNLOADING']);

export class DiscoveryService {
  constructor({ registry, dataDir, store } = {}) {
    this.registry = registry || new SourceRegistry();
    this.store = store || new FileKVStore({ dataDir });
  }

  async discoverCandidates({ sourceNames = [], fetcher, maxResults = 50, includeSkipped = false } = {}) {
    const report = await this.discoverCandidatesWithReport({ sourceNames, fetcher, maxResults, includeSkipped });
    return report.candidates;
  }

  async discoverCandidatesWithReport({ sourceNames = [], fetcher, maxResults = 50, includeSkipped = false } = {}) {
    if (!fetcher || typeof fetcher !== 'function') {
      return { candidates: [], source_errors: [], source_count: 0 };
    }

    const sources = this.registry.getEnabledSources().filter((source) => {
      if (!sourceNames || sourceNames.length === 0) return true;
      const requested = sourceNames.map(String);
      return requested.includes(source.id) || requested.includes(source.name);
    });

    const seen = new Map();
    const candidates = [];
    const sourceErrors = [];
    const duplicates = [];

    for (const source of sources) {
      let sourceResults;
      try {
        sourceResults = await fetcher(source, source.name, source.id);
      } catch (error) {
        sourceErrors.push({
          source: source.name || source.id,
          error: error?.message || String(error),
          timestamp: new Date().toISOString(),
        });
        continue;
      }
      const items = Array.isArray(sourceResults)
        ? sourceResults
        : Array.isArray(sourceResults?.items)
          ? sourceResults.items
          : sourceResults
            ? [sourceResults]
            : [];

      for (const item of items) {
        const videoId = String(item?.video_id || item?.id || item?.source_url || `${source.id}:${item?.title || item?.url || JSON.stringify(item)}`);
        if (seen.has(videoId)) {
          duplicates.push({ video_id: videoId, status: 'DUPLICATE_IN_DISCOVERY' });
          continue;
        }
        const existingRecord = await this.store.get(videoId);
        const retryableFailure = existingRecord?.status === 'FAILED' && existingRecord.failure_stage !== 'PUBLISH';
        if (existingRecord && !RESUMABLE_STATUSES.has(existingRecord.status) && !retryableFailure) {
          duplicates.push({ video_id: videoId, status: 'EXISTING', existing_status: existingRecord.status || 'UNKNOWN' });
          continue;
        }

        const metadata = {
          title: item?.title || '',
          description: item?.description || '',
          author: item?.author || item?.username || source.name,
          username: item?.username || item?.author || source.name,
        };

        const classification = classifyContent(metadata);
        const record = {
          ...item,
          id: item?.id || videoId,
          video_id: videoId,
          source_id: source.id,
          source_name: source.name,
          title: item?.title || metadata.title,
          description: item?.description || metadata.description,
          author: metadata.author,
          username: metadata.username,
          christian_score: classification.score,
          filter_status: classification.status,
          status: classification.status,
          filter_reason: classification.filter_reason,
          content_category: classification.category,
          discovered_at: new Date().toISOString(),
          ...(existingRecord ? { existing_record: existingRecord } : {}),
        };

        if (record.status === 'SKIPPED' && !includeSkipped) {
          continue;
        }

        seen.set(videoId, record);
        candidates.push(record);
      }
    }

    candidates.sort((a, b) => (Number(b.christian_score) || 0) - (Number(a.christian_score) || 0));
    return {
      candidates: candidates.slice(0, maxResults),
      source_errors: sourceErrors,
      source_count: sources.length,
      duplicates,
    };
  }
}

export const defaultDiscoveryService = new DiscoveryService();
