import webpush from 'web-push';
import { config } from '../config.ts';
import { deletePushSubscription, listPushSubscriptions, type PushSubscriptionRow } from '../db/repository.ts';

let configured = false;

function ensureConfigured(): boolean {
  if (!config.hasPush) return false;
  if (!configured) {
    webpush.setVapidDetails(
      config.VAPID_SUBJECT || 'mailto:todoist@localhost',
      config.VAPID_PUBLIC_KEY as string,
      config.VAPID_PRIVATE_KEY as string,
    );
    configured = true;
  }
  return true;
}

export interface PushPayload { title: string; body: string; taskId?: string; tag?: string; }
export interface PushResult { sent: number; removed: number; failed: number; }

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 200;

export function subscriptionGone(status: number | undefined): boolean { return status === 404 || status === 410; }
export function pushRetryable(status: number | undefined): boolean { return status === undefined || status === 429 || status >= 500; }
function wait(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function deliver(sub: PushSubscriptionRow & { user_id?: number }, body: string): Promise<{ removed: boolean; failed: boolean }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body);
      return { removed: false, failed: false };
    } catch (err) {
      lastError = err;
      const status = (err as { statusCode?: number }).statusCode;
      if (subscriptionGone(status)) return { removed: true, failed: false };
      if (!pushRetryable(status) || attempt === MAX_ATTEMPTS - 1) break;
      await wait(RETRY_BASE_MS * 2 ** attempt);
    }
  }
  console.error('Push delivery failed:', lastError);
  return { removed: false, failed: true };
}

export async function sendPushToUser(userId: number, payload: PushPayload): Promise<PushResult> {
  if (!ensureConfigured()) return { sent: 0, removed: 0, failed: 0 };
  const body = JSON.stringify(payload);
  let sent = 0, removed = 0, failed = 0;
  const subscriptions = listPushSubscriptions(userId) as (PushSubscriptionRow & { user_id?: number })[];
  await Promise.all(subscriptions.map(async (sub) => {
    const result = await deliver(sub, body);
    if (result.removed) {
      deletePushSubscription(userId, sub.endpoint);
      removed += 1;
    } else if (result.failed) {
      failed += 1;
    } else {
      sent += 1;
    }
  }));
  return { sent, removed, failed };
}

/** Sends to all users' subscriptions (used by global workers if needed). */
export async function sendPushToAll(payload: PushPayload): Promise<PushResult> {
  if (!ensureConfigured()) return { sent: 0, removed: 0, failed: 0 };
  const body = JSON.stringify(payload);
  let sent = 0, removed = 0, failed = 0;
  const subscriptions = listPushSubscriptions() as (PushSubscriptionRow & { user_id?: number })[];
  await Promise.all(subscriptions.map(async (sub) => {
    const userId = (sub as any).user_id as number | undefined;
    const result = await deliver(sub, body);
    if (result.removed && userId != null) {
      deletePushSubscription(userId, sub.endpoint);
      removed += 1;
    } else if (result.failed) {
      failed += 1;
    } else {
      sent += 1;
    }
  }));
  return { sent, removed, failed };
}

export function pushIsConfigured(): boolean { return ensureConfigured(); }
export function publicVapidKey(): string | null { return config.hasPush ? (config.VAPID_PUBLIC_KEY as string) : null; }
