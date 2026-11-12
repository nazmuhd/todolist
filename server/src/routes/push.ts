import { Router } from 'express';
import {
  deletePushSubscription,
  listPushDevices,
  listPushSubscriptions,
  savePushSubscription,
} from '../db/repository.ts';
import { publicVapidKey, pushIsConfigured, sendPush } from '../services/push.ts';

export const pushRouter = Router();

/** The key the browser needs for `pushManager.subscribe`. */
pushRouter.get('/key', (_req, res) => {
  const key = publicVapidKey();
  if (!key) {
    res.status(404).json({ error: 'push_disabled' });
    return;
  }
  res.json({ publicKey: key });
});

pushRouter.post('/subscribe', (req, res) => {
  const body = req.body as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
    label?: unknown;
    userAgent?: unknown;
  } | undefined;

  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
  const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : '';
  const auth = typeof body?.keys?.auth === 'string' ? body.keys.auth : '';
  const label = typeof body?.label === 'string' ? body.label.slice(0, 80) : null;
  const userAgent = typeof body?.userAgent === 'string' ? body.userAgent.slice(0, 300) : null;

  if (!endpoint || !/^https?:\/\//.test(endpoint) || !p256dh || !auth) {
    res.status(400).json({ error: 'invalid_subscription' });
    return;
  }

  savePushSubscription({ endpoint, p256dh, auth, label, userAgent });
  res.status(201).json({ ok: true });
});

/** The registered devices, without their push keys. */
pushRouter.get('/subscriptions', (_req, res) => {
  res.json({ subscriptions: listPushDevices() });
});

pushRouter.delete('/subscribe', (req, res) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
  if (!endpoint) {
    res.status(400).json({ error: 'invalid_endpoint' });
    return;
  }
  if (!deletePushSubscription(endpoint)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
});

/** Sends a test notification to every registered device. */
pushRouter.post('/test', async (_req, res) => {
  if (!pushIsConfigured()) {
    res.status(404).json({ error: 'push_disabled' });
    return;
  }
  if (!listPushSubscriptions().length) {
    res.status(409).json({ error: 'no_subscriptions' });
    return;
  }
  const result = await sendPush({
    title: 'Todolist',
    body: 'Push notifications are working.',
  });
  res.json(result);
});
