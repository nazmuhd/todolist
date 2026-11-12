/**
 * Priorities: the built-in P1-P4 plus the user's own levels.
 *
 * A task carries the built-in priority in `priority` (1 is the most
 * urgent, 4 means "none") and, when a custom level is used, the id of
 * that level in `customPriorityId`.
 *
 * The custom levels live in `state.priorityLevels`, so they are stored
 * with everything else and travel with the backup.
 */
import { state } from './state.js';
import { uid } from './app.js';
import { PRIORITY_LEVEL_COLORS } from './text.js';

export const BUILT_IN = [
  { id: 'p1', name: 'Priority 1', color: '#db4c3f', priority: 1 },
  { id: 'p2', name: 'Priority 2', color: '#eb8909', priority: 2 },
  { id: 'p3', name: 'Priority 3', color: '#246fe0', priority: 3 },
  { id: 'p4', name: 'Priority 4', color: '#999999', priority: 4 },
];

/** Every level a task can be given: the built-in four, then the custom ones. */
export function priorityLevels() {
  const custom = (state.priorityLevels || [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(l => ({
      id: l.id,
      name: l.name,
      color: l.color,
      priority: null,
      custom: true,
    }));
  return [...BUILT_IN.map(b => ({ ...b, custom: false })), ...custom];
}

/** The level a task uses, or null when it has no priority. */
export function taskLevel(t) {
  if (!t) return null;
  if (t.customPriorityId) {
    const found = (state.priorityLevels || []).find(l => l.id === t.customPriorityId);
    if (found) return { id: found.id, name: found.name, color: found.color, priority: null, custom: true };
  }
  const p = Number(t.priority) || 4;
  const built = BUILT_IN.find(b => b.priority === p);
  if (!built) return null;
  return { ...built, custom: false };
}

/** The label of a task's priority, e.g. "P1" or "Urgent". */
export function taskPriorityName(t) {
  const level = taskLevel(t);
  return level ? level.name : 'No priority';
}

/** The colour of a task's priority. */
export function taskPriorityColor(t) {
  const level = taskLevel(t);
  return level ? level.color : '#999999';
}

/** True when the task has no priority at all (P4 and no custom level). */
export function hasNoPriority(t) {
  return !t || (!t.customPriorityId && (Number(t.priority) || 4) === 4);
}

/**
 * Adds a custom priority level.
 * Returns the new level.
 */
export function addPriorityLevel(name, color) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return null;
  const levels = state.priorityLevels || (state.priorityLevels = []);
  const level = {
    id: 'pl_' + uid(),
    name: clean,
    color: color || PRIORITY_LEVEL_COLORS[levels.length % PRIORITY_LEVEL_COLORS.length],
    order: levels.length,
  };
  levels.push(level);
  return level;
}

/** Removes a custom priority level. Tasks using it fall back to P4. */
export function removePriorityLevel(id) {
  const levels = state.priorityLevels || [];
  const index = levels.findIndex(l => l.id === id);
  if (index === -1) return false;
  levels.splice(index, 1);
  return true;
}
