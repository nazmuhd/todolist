/**
 * Per-entity sync.
 *
 * Local state is still the source of truth for the UI. After every save this
 * module:
 *   1. pushes projects/labels/tasks that changed since the last snapshot,
 *      each with the revision it was based on;
 *   2. pulls every record after the last cursor and applies it locally.
 *
 * A stale revision conflicts for that record only; the client retries with
 * the server's revision so the user's latest edit wins. Deletions travel as
 * tombstones, so another device learns about them on its next pull.
 *
 * The sync bookkeeping (cursor, revisions, snapshot) is stored locally, never
 * on the server.
 */
import { store } from './store.js';
import { state, setState } from './state.js';
import { requestRender } from './render.js';

const META_KEY = 'todoist-clone-sync-meta';
const ENTITIES = ['projects', 'labels', 'tasks'];
const DEBOUNCE_MS = 400;
const MAX_PUSH_ATTEMPTS = 3;

let cursor = 0;
let revs = { projects: {}, labels: {}, tasks: {} };
let snapshot = null;
let enabled = false;
let metaLoaded = false;
let running = null;
let timer = null;

function emptyRevs() {
  return { projects: {}, labels: {}, tasks: {} };
}

function currentMaps() {
  const maps = {};
  for (const entity of ENTITIES) {
    const map = {};
    for (const item of state[entity] || []) {
      if (item && item.id) map[item.id] = JSON.stringify(item);
    }
    maps[entity] = map;
  }
  return maps;
}

async function loadMeta() {
  if (metaLoaded) return;
  metaLoaded = true;
  try {
    const meta = store.getLocalDoc
      ? await store.getLocalDoc(META_KEY)
      : await store.getDoc(META_KEY);
    if (!meta || typeof meta !== 'object') return;
    cursor = Number.isInteger(meta.cursor) ? meta.cursor : 0;
    revs = { ...emptyRevs(), ...(meta.revs || {}) };
    for (const entity of ENTITIES) revs[entity] ||= {};
    snapshot = meta.snapshot && typeof meta.snapshot === 'object' ? meta.snapshot : null;
  } catch {
    /* A missing/corrupt meta just means a fresh sync. */
  }
}

async function saveMeta() {
  try {
    const value = { cursor, revs, snapshot };
    if (store.setLocalDoc) await store.setLocalDoc(META_KEY, value);
    else await store.setDoc(META_KEY, value);
  } catch {
    /* Best-effort: the next run can rebuild from the server. */
  }
}

async function request(path, options) {
  const response = await store.send(path, options);
  return store.jsonBody ? store.jsonBody(response) : null;
}

/** Applies a server feed locally; `replace` is used for a fresh device. */
function applyFeed(changes, { replace = false } = {}) {
  const next = replace
    ? { projects: [], labels: [], tasks: [] }
    : {
        projects: [...state.projects],
        labels: [...state.labels],
        tasks: [...state.tasks],
      };

  let changed = replace;

  for (const entity of ENTITIES) {
    const list = next[entity];
    for (const row of changes[entity] || []) {
      const index = list.findIndex(item => item.id === row.id);

      if (row.deleted) {
        if (index !== -1) {
          list.splice(index, 1);
          changed = true;
        }
      } else if (row.data == null) {
        continue;
      } else if (index === -1) {
        list.push(row.data);
        changed = true;
      } else if (JSON.stringify(list[index]) !== JSON.stringify(row.data)) {
        list[index] = row.data;
        changed = true;
      }

      revs[entity][row.id] = row.rev;
    }
  }

  if (!changed) return false;
  setState({ ...state, projects: next.projects, labels: next.labels, tasks: next.tasks });
  return true;
}

function collectChanges() {
  const current = currentMaps();
  const previous = snapshot || { projects: {}, labels: {}, tasks: {} };
  const changes = {};
  let count = 0;

  for (const entity of ENTITIES) {
    const list = [];
    const before = previous[entity] || {};

    for (const [id, json] of Object.entries(current[entity])) {
      if (before[id] !== json) {
        list.push({
          id,
          data: JSON.parse(json),
          baseRev: revs[entity][id] ?? 0,
        });
        count += 1;
      }
    }

    for (const id of Object.keys(before)) {
      if (!(id in current[entity])) {
        list.push({ id, deleted: true, baseRev: revs[entity][id] ?? 0 });
        count += 1;
      }
    }

    if (list.length) changes[entity] = list;
  }

  return { changes, count };
}

/** Pushes dirty records, retrying per-record conflicts with the server rev. */
async function pushChanges() {
  let pending = collectChanges();

  for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS && pending.count; attempt += 1) {
    const body = await request('/sync', { method: 'POST', json: { changes: pending.changes } });
    if (!body) return false;

    for (const applied of body.applied || []) {
      revs[applied.entity][applied.id] = applied.rev;
    }

    const retry = {};
    let retryCount = 0;
    for (const conflict of body.conflicts || []) {
      revs[conflict.entity][conflict.id] = conflict.rev;
      const original = (pending.changes[conflict.entity] || []).find(change => change.id === conflict.id);
      if (!original) continue;
      (retry[conflict.entity] ||= []).push({ ...original, baseRev: conflict.rev });
      retryCount += 1;
    }

    pending = { changes: retry, count: retryCount };
  }

  return pending.count === 0;
}

async function pullChanges() {
  const body = await request(`/sync?since=${cursor}`);
  if (!body) return false;

  const changed = applyFeed(body.changes || {});
  cursor = Number.isInteger(body.cursor) ? body.cursor : cursor;

  if (changed) {
    try { await store.saveState(state); } catch {}
    requestRender();
  }
  return true;
}

/** First sync on this browser: adopt a non-empty server, or seed an empty one. */
async function initialSync() {
  const feed = await request('/sync?since=0');
  if (!feed) return false;

  if (feed.cursor > 0) {
    revs = emptyRevs();
    applyFeed(feed.changes || {}, { replace: true });
    cursor = feed.cursor;
    try { await store.saveState(state); } catch {}
    requestRender();
  } else if (!(await pushChanges())) {
    return false;
  }

  // Pull once more so the cursor covers our own writes and any concurrent ones.
  if (!(await pullChanges())) return false;
  snapshot = currentMaps();
  await saveMeta();
  return true;
}

export async function syncNow() {
  if (!enabled) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (running) return running;

  running = (async () => {
    await loadMeta();
    if (!snapshot) return initialSync();

    if (!(await pushChanges())) return false;
    if (!(await pullChanges())) return false;

    snapshot = currentMaps();
    await saveMeta();
    return true;
  })()
    .catch(() => false)
    .finally(() => { running = null; });

  return running;
}

/** Called after each local save; coalesces bursts into one sync. */
export function scheduleSync() {
  if (!enabled) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    syncNow();
  }, DEBOUNCE_MS);
}

export function initSync() {
  enabled = true;
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
  return syncNow();
}
