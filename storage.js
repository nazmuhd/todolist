/* ============================================================
   STORAGE ADAPTER
   The app never touches localStorage or IndexedDB directly — it
   talks to `store`. Today that is LocalStore (localStorage for the
   documents, IndexedDB for blobs). Moving to a backend later means
   writing an ApiStore with the same interface and changing one line
   in app.js.

   Interface
     loadState()          -> the saved state document (or null)
     saveState(state)     -> persist the state document
     backupState(tag)     -> keep a copy under "<state key>-<tag>"
     getDoc(key)          -> a small side document (settings, prefs…)
     setDoc(key, value)   -> write a small side document
     putBlob(id, blob)    -> store binary data (attachments)
     getBlob(id)          -> read it back
     deleteBlob(id)       -> remove it
     listBlobs()          -> metadata for everything stored
     onChange(fn)         -> notified when another tab changes something

   Everything is asynchronous on purpose: IndexedDB and HTTP are async,
   so the app code does not have to change shape when the backend does.
============================================================ */
(function (global) {
  'use strict';

  const CHANNEL = 'todoist-clone-store';
  const DB_NAME = 'todoist-clone-files';
  const DB_VERSION = 2;
  const STORE = 'files';
  const DOCS = 'docs';

  const DEFAULT_KEYS = {
    state: 'todoist-clone-v1',
    filters: 'todoist-clone-filters',
    settings: 'todoist-clone-settings',
    sectionCollapse: 'todoist-clone-section-collapsed',
    sidebarCollapsed: 'todoist-clone-sidebar-collapsed',
  };

  /** Shared behaviour: change notification and the key set. */
  class BaseStore {
    constructor(keys = {}) {
      this.keys = { ...DEFAULT_KEYS, ...keys };
      this.listeners = new Set();
      this.channel = null;
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          this.channel = new BroadcastChannel(CHANNEL);
          this.channel.onmessage = (event) => {
            const key = event.data && event.data.key;
            if (key) this.emit(key);
          };
        }
      } catch (err) {
        console.warn('BroadcastChannel unavailable:', err);
      }
    }

    onChange(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    emit(key) {
      this.listeners.forEach((fn) => {
        try { fn(key); } catch (err) { console.error(err); }
      });
    }

    /** Tells other tabs that something changed. */
    notifyPeers(key) {
      try { if (this.channel) this.channel.postMessage({ key }); } catch {}
    }

    async loadState() { throw new Error('loadState is not implemented'); }
    async saveState(state) { throw new Error('saveState is not implemented'); }
    async backupState(tag) { throw new Error('backupState is not implemented'); }
    async getDoc(key) { throw new Error('getDoc is not implemented'); }
    async setDoc(key, value) { throw new Error('setDoc is not implemented'); }
    async putBlob(id, blob) { throw new Error('putBlob is not implemented'); }
    async getBlob(id) { throw new Error('getBlob is not implemented'); }
    async deleteBlob(id) { throw new Error('deleteBlob is not implemented'); }
    async listBlobs() { return []; }
  }

  /** The current backend: browser storage. */
  class LocalStore extends BaseStore {
    constructor(keys) {
      super(keys);
      this._db = null;

      // Fallback for browsers without BroadcastChannel: the storage event
      // fires in the other tabs whenever localStorage changes.
      window.addEventListener('storage', (event) => {
        if (!event.key) return;
        this.emit(event.key);
      });
    }

    async getDoc(key) {
      // IndexedDB is the home of the documents; localStorage is only a
      // fallback for browsers without it (and the source of the one-time
      // migration for data saved before this change).
      try {
        const db = await this.db();
        const record = await new Promise((resolve, reject) => {
          const tx = db.transaction(DOCS, 'readonly');
          const request = tx.objectStore(DOCS).get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (record) return record.value;
      } catch (err) {
        // No IndexedDB (private mode, blocked storage) — use localStorage.
        return this.getDocFromLocalStorage(key);
      }

      const legacy = this.getDocFromLocalStorage(key);
      if (legacy !== null) {
        // Move the old copy forward and drop it from localStorage.
        this.setDoc(key, legacy).catch(() => {});
      }
      return legacy;
    }

    getDocFromLocalStorage(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        console.warn('Could not read', key, err);
        return null;
      }
    }

    async setDoc(key, value) {
      try {
        const db = await this.db();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(DOCS, 'readwrite');
          tx.objectStore(DOCS).put({ key, value });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
        try { localStorage.removeItem(key); } catch {}
      } catch (err) {
        console.error('Could not save', key, err);
        if (typeof global.onStorageError === 'function') global.onStorageError(err);
        try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
        throw err;
      }
      this.notifyPeers(key);
    }

    async loadState() {
      return this.getDoc(this.keys.state);
    }

    async saveState(state) {
      await this.setDoc(this.keys.state, state);
    }

    async backupState(tag) {
      const current = await this.getDoc(this.keys.state);
      if (!current) return;
      await this.setDoc(`${this.keys.state}-${tag}`, current);
    }

    /* ---------- blobs (IndexedDB) ---------- */
    db() {
      if (this._db) return this._db;
      this._db = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
          reject(new Error('IndexedDB is not available'));
          return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(DOCS)) db.createObjectStore(DOCS, { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return this._db;
    }

    async putBlob(id, blob) {
      const db = await this.db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({
          id,
          blob,
          name: blob.name || '',
          type: blob.type || '',
          size: blob.size || 0,
          savedAt: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }

    async getBlob(id) {
      const db = await this.db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).get(id);
        request.onsuccess = () => resolve(request.result ? request.result.blob : null);
        request.onerror = () => reject(request.error);
      });
    }

    async deleteBlob(id) {
      const db = await this.db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async listBlobs() {
      try {
        const db = await this.db();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readonly');
          const request = tx.objectStore(STORE).getAll();
          request.onsuccess = () => resolve((request.result || []).map(r => ({
            id: r.id, name: r.name, type: r.type, size: r.size, savedAt: r.savedAt,
          })));
          request.onerror = () => reject(request.error);
        });
      } catch {
        return [];
      }
    }
  }

  /**
   * The backend shape, ready to be filled in. Keeping it here means the
   * swap is: `const store = new ApiStore({ token })`.
   */
  class ApiStore extends BaseStore {
    constructor({ baseUrl = '/api', token = null, keys } = {}) {
      super(keys);
      this.baseUrl = baseUrl;
      this.token = token;
    }

    async request(path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (options.body !== undefined && !(options.body instanceof Blob)) {
        headers['Content-Type'] = 'application/json';
      }
      const response = await fetch(`${this.baseUrl}${path}`, { ...options, headers });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    }

    async loadState() {
      const response = await this.request('/state');
      return response.json();
    }

    async saveState(state) {
      await this.request('/state', { method: 'PUT', body: JSON.stringify(state) });
      this.notifyPeers(this.keys.state);
    }

    async backupState(tag) {
      await this.request(`/state/backup/${tag}`, { method: 'POST' }).catch(() => {});
    }

    async getDoc(key) {
      const response = await this.request(`/docs/${encodeURIComponent(key)}`);
      return response.json();
    }

    async setDoc(key, value) {
      await this.request(`/docs/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(value) });
      this.notifyPeers(key);
    }

    async putBlob(id, blob) {
      await this.request(`/files/${encodeURIComponent(id)}`, { method: 'PUT', body: blob });
    }

    async getBlob(id) {
      const response = await this.request(`/files/${encodeURIComponent(id)}`);
      return response.blob();
    }

    async deleteBlob(id) {
      await this.request(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }

    async listBlobs() {
      const response = await this.request('/files');
      return response.json();
    }
  }

  global.TodoStore = { BaseStore, LocalStore, ApiStore, DEFAULT_KEYS };
})(window);
