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
import { state, setState, defaultState } from './state.js';
import { requestRender } from './render.js';

const META_KEY = 'todoist-clone-sync-meta';
const ENTITIES = ['projects', 'labels', 'tasks', 'templates'];
const DEBOUNCE_MS = 400;
const MAX_PUSH_ATTEMPTS = 3;
const SYNC_PAGE_SIZE = 100;
const MAX_PULL_PAGES = 1000;

let cursor = 0;
let revs = { projects: {}, labels: {}, tasks: {}, templates: {} };
let snapshot = null;
let enabled = false;
let metaLoaded = false;
let running = null;
let timer = null;

function emptyRevs() {
  return { projects: {}, labels: {}, tasks: {}, templates: {} };
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

/**
 * Applies a server feed locally; `replace` is used for a fresh device.
 *
 * Returns the records it wrote, so the caller can fold them into the
 * snapshot: the server is the authority on those.
 */
function applyFeed(changes, { replace = false } = {}) {
  const next = replace
    ? { projects: [], labels: [], tasks: [], templates: [] }
    : {
        projects: [...state.projects],
        labels: [...state.labels],
        tasks: [...state.tasks],
        templates: [...(state.templates || [])],
      };

  let changed = replace;
  const applied = [];

  for (const entity of ENTITIES) {
    const list = next[entity];
    for (const row of changes[entity] || []) {
      const index = list.findIndex(item => item.id === row.id);

      if (row.deleted) {
        if (index !== -1) {
          list.splice(index, 1);
          changed = true;
        }
        applied.push({ entity, id: row.id, json: null });
      } else if (row.data == null) {
        continue;
      } else if (index === -1) {
        list.push(row.data);
        changed = true;
        applied.push({ entity, id: row.id, json: JSON.stringify(row.data) });
      } else if (JSON.stringify(list[index]) !== JSON.stringify(row.data)) {
        list[index] = row.data;
        changed = true;
        applied.push({ entity, id: row.id, json: JSON.stringify(row.data) });
      }

      revs[entity][row.id] = row.rev;
    }
  }

  if (!changed) return { changed: false, applied };
  setState({
    ...state,
    projects: next.projects,
    labels: next.labels,
    tasks: next.tasks,
    templates: next.templates,
  });
  return { changed: true, applied };
}

/**
 * Builds the snapshot of what the server now holds.
 *
 * It starts from the maps as they were when the push ran and then folds in
 * the records the pull delivered. Anything the user created *after* the push
 * is deliberately left out, so the next sync still sees it as a change
 * instead of silently dropping it.
 */
function buildSnapshot(pushed, applied) {
  const snapshot = {
    projects: { ...(pushed?.projects || {}) },
    labels: { ...(pushed?.labels || {}) },
    tasks: { ...(pushed?.tasks || {}) },
    templates: { ...(pushed?.templates || {}) },
  };
  for (const record of applied || []) {
    const bucket = snapshot[record.entity];
    if (!bucket) continue;
    if (record.json === null) delete bucket[record.id];
    else bucket[record.id] = record.json;
  }
  return snapshot;
}

/**
 * True when this browser holds work the server has not seen yet.
 *
 * A device that only has the default projects and labels is "fresh" and may
 * adopt the server's state wholesale. A device with a task of its own may
 * not: that task was never pushed, so replacing the state would lose it.
 */
function hasLocalWork() {
  if ((state.tasks || []).length > 0) return true;
  if ((state.templates || []).length > 0) return true;

  const defaults = defaultState();
  const sameList = (list, seed) => {
    if (!Array.isArray(list) || list.length !== seed.length) return false;
    return seed.every((item) => {
      const found = list.find(x => x && x.id === item.id);
      return !!found && found.name === item.name && found.color === item.color;
    });
  };

  return !sameList(state.projects, defaults.projects) || !sameList(state.labels, defaults.labels);
}

/**
 * The server's view of every record, used as the baseline to diff the local
 * state against when there is no snapshot (the sync metadata was lost, or
 * the first sync never finished). Tombstoned records are left out: they no
 * longer exist on the server.
 */
function baselineFromPages(pages) {
  const baseline = { projects: {}, labels: {}, tasks: {}, templates: {} };
  for (const page of pages) {
    for (const entity of ENTITIES) {
      for (const row of page.changes?.[entity] || []) {
        if (row.deleted || row.data == null) continue;
        baseline[entity][row.id] = JSON.stringify(row.data);
      }
    }
  }
  return baseline;
}

/** The revision each server record is on, used as the base for a push. */
function revsFromPages(pages) {
  const out = emptyRevs();
  for (const page of pages) {
    for (const entity of ENTITIES) {
      for (const row of page.changes?.[entity] || []) {
        out[entity][row.id] = row.rev;
      }
    }
  }
  return out;
}

function collectChanges(baseline, { allowDeletes = true } = {}) {
  const current = currentMaps();
  const previous = baseline || snapshot || { projects: {}, labels: {}, tasks: {}, templates: {} };
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

    if (allowDeletes) {
      for (const id of Object.keys(before)) {
        if (!(id in current[entity])) {
          list.push({ id, deleted: true, baseRev: revs[entity][id] ?? 0 });
          count += 1;
        }
      }
    }

    if (list.length) changes[entity] = list;
  }

  return { changes, count };
}

/** Pushes dirty records, retrying per-record conflicts with the server rev. */
async function pushChanges(baseline, options) {
  let pending = collectChanges(baseline, options);

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
  let changed = false;
  const applied = [];
  let pages = 0;

  while (pages < MAX_PULL_PAGES) {
    const body = await request(`/sync?since=${cursor}&limit=${SYNC_PAGE_SIZE}`);
    if (!body) return { ok: false, applied };

    const result = applyFeed(body.changes || {});
    if (result.changed) changed = true;
    applied.push(...result.applied);
    if (Number.isInteger(body.cursor)) cursor = body.cursor;
    pages += 1;

    if (!body.hasMore) break;
  }

  if (changed) {
    try { await store.saveState(state); } catch {}
    requestRender();
  }
  return { ok: true, applied };
}

/** First sync on this browser: adopt a non-empty server, or seed an empty one. */
async function initialSync() {
  let feed = await request(`/sync?since=0&limit=${SYNC_PAGE_SIZE}`);
  if (!feed) return false;

  // The maps as they are now, before anything is pushed or pulled.
  const local = currentMaps();
  let applied = [];

  if (feed.cursor > 0) {
    // Collect every page of the server's records first: they are the
    // baseline the local state is compared against.
    const pages = [feed];
    let last = feed.cursor;
    let more = feed.hasMore;
    let pageCount = 1;
    while (more && pageCount < MAX_PULL_PAGES) {
      feed = await request(`/sync?since=${last}&limit=${SYNC_PAGE_SIZE}`);
      if (!feed) return false;
      pages.push(feed);
      if (Number.isInteger(feed.cursor)) last = feed.cursor;
      more = feed.hasMore;
      pageCount += 1;
    }

    revs = revsFromPages(pages);

    if (hasLocalWork()) {
      // This device holds work the server has not seen (a task created
      // while offline, or before the first sync ever finished). Push it
      // against the server's own records, then re-read the server, so
      // nothing local is dropped: the work is kept and uploaded.
      //
      // Deletions are not pushed here: this device may simply not know
      // about a record, and deleting it on the server would lose it for
      // every other device too.
      const baseline = baselineFromPages(pages);
      if (!(await pushChanges(baseline, { allowDeletes: false }))) return false;
      cursor = 0; // re-read everything, so our own push comes back too
    } else {
      // A device with nothing of its own may take the server's data as is.
      applied.push(...applyFeed(pages[0].changes || {}, { replace: true }).applied);
      for (let i = 1; i < pages.length; i += 1) applied.push(...applyFeed(pages[i].changes || {}).applied);
      cursor = last;
    }

    try { await store.saveState(state); } catch {}
    requestRender();
  } else if (!(await pushChanges())) {
    return false;
  }

  // Pull once more so the cursor covers our own writes and any concurrent ones.
  const pull = await pullChanges();
  if (!pull.ok) return false;
  applied.push(...pull.applied);

  // The snapshot is what the server holds. Anything created after the push
  // is left out on purpose, so the next sync still sends it.
  snapshot = buildSnapshot(local, applied);
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

    // The maps as they are before the push, so a task created while the
    // push is in flight is not mistaken for one the server already has.
    const local = currentMaps();

    if (!(await pushChanges())) return false;
    const pull = await pullChanges();
    if (!pull.ok) return false;

    snapshot = buildSnapshot(local, pull.applied);
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
