/**
 * The storage adapter.
 *
 * One singleton for the whole app. ApiStore extends LocalStore: writes go to
 * IndexedDB first (so the app stays local-first and works offline) and sync to
 * the API best-effort. If the API is unreachable, everything still works.
 */
import { ApiStore } from '../storage.js';

export const store = new ApiStore();
