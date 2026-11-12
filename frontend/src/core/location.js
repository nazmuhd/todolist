/**
 * Location reminders: a reminder that fires when you are near a place.
 *
 * A web app cannot geofence in the background (that needs a native app), so
 * these fire while a tab is open and the browser reports a position. The
 * browser's Geolocation API is used, and the reminder is armed as soon as
 * the permission is granted.
 *
 * The reminder shape is `{ id, lat, lon, radius }`, with the radius in
 * metres. It is stored with the task and never leaves the device.
 */
import { state, persistState, setStateChangedHook } from './state.js';
import { taskReminders } from './tasks.js';
import { showToast } from './toasts.js';

const EARTH_RADIUS_M = 6371000;

/** How far you are from a point, in metres (the haversine formula). */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(n => Number.isFinite(n))) return Infinity;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** True when the reminder is a location one. */
export function isLocationReminder(r) {
  return !!r && Number.isFinite(r.lat) && Number.isFinite(r.lon);
}

/** The location reminders of a task. */
export function locationReminders(t) {
  return taskReminders(t).filter(isLocationReminder);
}

export function locationSupported() {
  return 'geolocation' in navigator;
}

/**
 * Asks the browser for the current position.
 * Resolves with { lat, lon } or rejects.
 */
export function currentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!locationSupported()) {
      reject(new Error('This browser cannot report your location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(err.message || 'Could not read your location.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000, ...options }
    );
  });
}

/** True when any task has a location reminder waiting. */
export function hasLocationReminders() {
  return state.tasks.some(t => !t.completed && locationReminders(t).length > 0);
}

/**
 * Fires every location reminder the given position satisfies.
 *
 * A reminder fires once: it is marked as fired so the user is not notified
 * again on the next position update.
 */
export function checkLocationReminders(position) {
  if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lon)) return 0;
  let fired = 0;

  state.tasks.forEach(t => {
    if (t.completed) return;
    locationReminders(t).forEach(r => {
      const radius = Number.isFinite(r.radius) && r.radius > 0 ? r.radius : 150;
      if (distanceMeters(position.lat, position.lon, r.lat, r.lon) > radius) return;
      // The fired key covers every reminder of the task, so a location
      // reminder is not repeated for the other reminders of the same task.
      const key = `loc:${r.id}:${Math.round(r.lat * 1000)}:${Math.round(r.lon * 1000)}`;
      if (t.reminderFiredKey === key) return;      t.reminderFiredKey = key;
      fired += 1;
      showToast(`Reminder: ${t.title} (${r.name || 'near you'})`, 'info', {
        actionLabel: 'View',
        onAction: () => {
          import('../core/services.js').then(({ services }) => services.openTaskModal(t.id));
        },
        duration: 15000,
      });
    });
  });

  if (fired) persistState();
  return fired;
}

let watchId = null;
let watching = false;

/**
 * Starts watching the position, so location reminders fire as you move.
 * Safe to call more than once.
 */
export function startLocationWatch() {
  if (!locationSupported() || watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => checkLocationReminders({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
    () => {
      // A denied or failed permission is not fatal: the reminder simply
      // waits for the next time the browser shares a position.
    },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 }
  );
  watching = true;
}

export function stopLocationWatch() {
  if (watchId === null || !locationSupported()) return;
  navigator.geolocation.clearWatch(watchId);
  watchId = null;
  watching = false;
}

export function isWatchingLocation() {
  return watching;
}

/** Arms the watcher when there is anything to watch for. */
export function syncLocationWatch() {
  if (hasLocationReminders()) startLocationWatch();
  else stopLocationWatch();
}

// A task that gained or lost a location reminder re-arms the watcher.
setStateChangedHook(syncLocationWatch);
