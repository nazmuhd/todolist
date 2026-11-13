import { Router } from 'express';
import { z } from 'zod';
import { deletePushSubscription, listPushDevices, listPushSubscriptions, savePushSubscription } from '../db/repository.ts';
import { publicVapidKey, pushIsConfigured, sendPushToUser } from '../services/push.ts';

export const pushRouter = Router();
const uid = (req: any) => req.user.id as number;

const subscribeSchema = z.object({
  endpoint: z.string().url().refine(v => /^https?:\/\//.test(v), 'invalid_endpoint'),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  label: z.string().max(80).optional().nullable(),
  userAgent: z.string().max(300).optional().nullable(),
}).strict();

const unsubscribeSchema = z.object({
  endpoint: z.string().min(1),
}).strict();

pushRouter.get('/key', (_req, res) => {
  const key = publicVapidKey();
  if (!key) { res.status(404).json({ error: 'push_disabled' }); return; }
  res.json({ publicKey: key });
});

pushRouter.post('/subscribe', (req, res) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_subscription' }); return; }
  const { endpoint, keys, label, userAgent } = parsed.data;
  savePushSubscription(uid(req), {
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    label: typeof label === 'string' ? label.slice(0, 80) : null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 300) : null,
  });
  res.status(201).json({ ok: true });
});

pushRouter.get('/subscriptions', (req, res) => { res.json({ subscriptions: listPushDevices(uid(req)) }); });

pushRouter.delete('/subscribe', (req, res) => {
  const parsed = unsubscribeSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.endpoint) { res.status(400).json({ error: 'invalid_endpoint' }); return; }
  if (!deletePushSubscription(uid(req), parsed.data.endpoint)) { res.status(404).json({ error: 'not_found' }); return; }
  res.status(204).end();
});

pushRouter.post('/test', async (req, res) => {
  const userId = uid(req);
  if (!pushIsConfigured()) { res.status(404).json({ error: 'push_disabled' }); return; }
  if (!listPushSubscriptions(userId).length) { res.status(409).json({ error: 'no_subscriptions' }); return; }
  const result = await sendPushToUser(userId, { title: 'Todolist', body: 'Push notifications are working.' });
  res.json(result);
});
