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

export interface PushPayload {
  title: string;
  body: string;
  taskId?: string;
  tag?: string;
}

export interface PushResult {
  sent: number;
  removed: number;
  failed: number;
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 200;

/** 404/410 mean the subscription is permanently gone. */
export function subscriptionGone(status: number | undefined): boolean {
  return status === 404 || status === 410;
}

/** Network errors and 429/5xx responses are worth retrying. */
export function pushRetryable(status: number | undefined): boolean {
  return status === undefined || status === 429 || status >= 500;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function deliver(sub: PushSubscriptionRow, body: string): Promise<{ removed: boolean; failed: boolean }> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      }, body);
      return { removed: false, failed: false };
    } catch (err) {
      lastError = err;
      const status = (err as { statusCode?: number }).statusCode;
      if (subscriptionGone(status)) return { removed: true, failed: false };
      if (!pushRetryable(status) || attempt === MAX_ATTEMPTS - 1) break;
      // Exponential backoff between attempts.
      await wait(RETRY_BASE_MS * 2 ** attempt);
    }
  }

  console.error('Push delivery failed:', lastError);
  return { removed: false, failed: true };
}

/**
 * Sends a payload to every stored subscription. Endpoints that the push
 * service reports as gone (404/410) are removed, since the browser will
 * never accept them again. Transient failures are retried with backoff.
 */
export async function sendPush(payload: PushPayload): Promise<PushResult> {
  if (!ensureConfigured()) return { sent: 0, removed: 0, failed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;
  let failed = 0;

  const subscriptions = listPushSubscriptions();
  await Promise.all(subscriptions.map(async (sub: PushSubscriptionRow) => {
    const result = await deliver(sub, body);
    if (result.removed) {
      deletePushSubscription(sub.endpoint);
      removed += 1;
    } else if (result.failed) {
      failed += 1;
    } else {
      sent += 1;
    }
  }));

  return { sent, removed, failed };
}

export function pushIsConfigured(): boolean {
  return ensureConfigured();
}

export function publicVapidKey(): string | null {
  return config.hasPush ? (config.VAPID_PUBLIC_KEY as string) : null;
}
