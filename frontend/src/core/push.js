/**
 * Web Push registration.
 *
 * The service worker receives `push` events and shows the notification even
 * when no tab is open. This module only asks for permission and hands the
 * browser's subscription to the server; all scheduling stays server-side.
 */
import { store } from './store.js';
import { showToast } from './toasts.js';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function pushSupported() {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

/** The current permission: 'unsupported' | 'default' | 'denied' | 'granted'. */
export function pushPermission() {
  if (!pushSupported()) return 'unsupported';
  return window.Notification.permission;
}

async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.ready; } catch { return null; }
}

async function currentSubscription() {
  const reg = await registration();
  if (!reg) return null;
  try { return await reg.pushManager.getSubscription(); } catch { return null; }
}

export async function isPushEnabled() {
  return Boolean(await currentSubscription());
}

function deviceLabel() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  const platform = /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return platform ? `${browser} on ${platform}` : browser;
}

/** The registered devices (no push keys), for the settings list. */
export async function listPushDevices() {
  const data = await store.jsonBody(await store.send('/push/subscriptions'));
  return Array.isArray(data?.subscriptions) ? data.subscriptions : [];
}

/** Forgets another device's subscription. */
export async function removePushDevice(endpoint) {
  if (!endpoint) return false;
  const response = await store.send('/push/subscribe', {
    method: 'DELETE',
    json: { endpoint },
  });
  return Boolean(response && (response.ok || response.status === 404));
}

export function currentDeviceLabel() {
  return deviceLabel();
}

export async function enablePush() {
  if (!pushSupported()) {
    showToast('This browser does not support push notifications', 'error');
    return false;
  }

  const key = await store.jsonBody(await store.send('/push/key'));
  if (!key || !key.publicKey) {
    showToast('Push is not configured on the server', 'error');
    return false;
  }

  if (window.Notification.permission === 'default') {
    const permission = await window.Notification.requestPermission();
    if (permission !== 'granted') {
      showToast('Notification permission was not granted', 'error');
      return false;
    }
  } else if (window.Notification.permission !== 'granted') {
    showToast('Notifications are blocked in the browser settings', 'error');
    return false;
  }

  const reg = await registration();
  if (!reg) {
    showToast('The service worker is not ready yet', 'error');
    return false;
  }

  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    try {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key.publicKey),
      });
    } catch (err) {
      console.error('Could not subscribe to push:', err);
      showToast('Could not enable push notifications', 'error');
      return false;
    }
  }

  const body = subscription.toJSON();
  body.label = deviceLabel();
  body.userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : null;
  const response = await store.send('/push/subscribe', { method: 'POST', json: body });
  if (!response || !response.ok) {
    showToast('Could not save the push subscription', 'error');
    return false;
  }

  showToast('Reminders will now arrive even when the app is closed', 'info');
  return true;
}

export async function disablePush() {
  const subscription = await currentSubscription();
  if (!subscription) return true;
  await store.send('/push/subscribe', {
    method: 'DELETE',
    json: { endpoint: subscription.endpoint },
  });
  try { await subscription.unsubscribe(); } catch { /* already gone */ }
  return true;
}
