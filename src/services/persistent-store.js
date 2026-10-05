import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const storeInitializations = new Map();

export class FileKVStore {
  constructor({ dataDir = process.env.DATA_DIR || '/data', namespace = 'automation' } = {}) {
    this.dataDir = path.resolve(dataDir || process.env.DATA_DIR || '/data');
    this.namespace = namespace;
    this.filePath = path.join(this.dataDir, `${namespace}.json`);
    this.data = {};
    this.flushQueue = Promise.resolve();
    this.ready = this.ensureStore();
  }

  async ensureStore() {
    let initialization = storeInitializations.get(this.filePath);
    if (!initialization) {
      initialization = this.initializeStore();
      storeInitializations.set(this.filePath, initialization);
    }

    try {
      this.data = await initialization;
    } catch (error) {
      if (storeInitializations.get(this.filePath) === initialization) {
        storeInitializations.delete(this.filePath);
      }
      throw error;
    }
  }

  async initializeStore() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Persistent store is unreadable: ${error.message}`);
      const initialState = {};
      await this.writeAtomic(JSON.stringify(initialState, null, 2));
      return initialState;
    }
  }

  async load() {
    await this.ready;
    return this.data;
  }

  async flush() {
    await this.ready;
    const write = this.flushQueue.then(() => this.writeAtomic(JSON.stringify(this.data, null, 2)));
    this.flushQueue = write.catch(() => {});
    await write;
  }

  async writeAtomic(contents) {
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, contents, 'utf8');
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async set(key, value) {
    await this.ready;
    const record = value && typeof value === 'object' ? { ...value } : value;
    if (record && typeof record === 'object' && record.status) {
      const history = Array.isArray(record.status_history) ? record.status_history.slice() : [];
      if (!history.length) {
        history.push({ from: null, to: record.status, at: record.updated_at || new Date().toISOString() });
      }
      record.status_history = history;
    }
    this.data[key] = record;
    await this.flush();
    return record;
  }

  async get(key) {
    await this.ready;
    return this.data[key] ?? null;
  }

  async delete(key) {
    await this.ready;
    const deleted = this.data[key];
    delete this.data[key];
    await this.flush();
    return deleted;
  }

  async list() {
    await this.ready;
    return { ...this.data };
  }

  async transition(key, fromStatus, toStatus, metadata = {}) {
    const current = (await this.get(key)) || {};
    const history = Array.isArray(current.status_history) ? current.status_history.slice() : [];
    const timestamp = new Date().toISOString();
    history.push({
      from: fromStatus ?? current.status ?? null,
      to: toStatus,
      at: timestamp,
      ...metadata,
    });

    const next = {
      ...current,
      ...metadata,
      status: toStatus,
      updated_at: timestamp,
      last_transition_at: timestamp,
      status_history: history,
    };

    await this.set(key, next);
    return next;
  }
}

export const defaultDataStore = new FileKVStore();
