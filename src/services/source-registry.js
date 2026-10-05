export class SourceRegistry {
  constructor(initialSources = []) {
    this.sources = new Map();
    for (const source of initialSources) {
      this.addSource(source);
    }
  }

  normalizeSource(source = {}) {
    const sourceName = String(source.name || source.id || source.username || source.account || '').trim();
    const id = String(source.id || source.name || source.username || source.account || sourceName || '').trim();
    const name = String(source.name || source.username || source.account || id || '').trim();

    if (!id && !name) {
      throw new Error('Source name is required');
    }

    return {
      id: id || name,
      name: name || id,
      enabled: source.enabled !== false,
      priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : 0,
      metadata: { ...(source.metadata || {}) },
      ...source,
      id: id || name,
      name: name || id,
      enabled: source.enabled !== false,
      priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : 0,
    };
  }

  addSource(source) {
    const normalized = this.normalizeSource(source);
    this.sources.set(normalized.id, normalized);
    return normalized;
  }

  removeSource(sourceId) {
    return this.sources.delete(sourceId);
  }

  enableSource(sourceId) {
    const source = this.sources.get(sourceId);
    if (!source) return undefined;
    source.enabled = true;
    return source;
  }

  disableSource(sourceId) {
    const source = this.sources.get(sourceId);
    if (!source) return undefined;
    source.enabled = false;
    return source;
  }

  getSource(sourceId) {
    return this.sources.get(sourceId);
  }

  listSources() {
    return [...this.sources.values()].sort((a, b) => {
      if (b.priority !== a.priority) return Number(b.priority) - Number(a.priority);
      return String(a.name).localeCompare(String(b.name));
    });
  }

  getEnabledSources() {
    return this.listSources().filter((source) => source.enabled !== false);
  }
}

export function createSourceRegistryFromEnv(rawSources = '') {
  const values = String(rawSources || '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  return new SourceRegistry(values.map((value) => ({ id: value, name: value, enabled: true, priority: 100 })));
}

export const defaultSourceRegistry = new SourceRegistry();
