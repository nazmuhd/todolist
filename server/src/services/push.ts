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

/**
 * Sends a payload to every stored subscription. Endpoints that the push
 * service reports as gone (404/410) are removed, since the browser will
 * never accept them again.
 */
export async function sendPush(payload: PushPayload): Promise<{ sent: number; removed: number }> {
  if (!ensureConfigured()) return { sent: 0, removed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;

  const subscriptions = listPushSubscriptions();
  await Promise.all(subscriptions.map(async (sub: PushSubscriptionRow) => {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      }, body);
      sent += 1;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        deletePushSubscription(sub.endpoint);
        removed += 1;
        return;
      }
      console.error('Push delivery failed:', err);
    }
  }));

  return { sent, removed };
}

export function pushIsConfigured(): boolean {
  return ensureConfigured();
}

export function publicVapidKey(): string | null {
  return config.hasPush ? (config.VAPID_PUBLIC_KEY as string) : null;
}
