-- Server-side reminders and Web Push.
--
-- A subscription is the browser's push endpoint plus the two keys it needs to
-- decrypt the payload. `reminder_fired` prevents the worker from sending the
-- same reminder twice (the key mirrors the client's reminderKey).

create table if not exists push_subscriptions (
  endpoint   text primary key,
  p256dh     text not null,
  auth       text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists reminder_fired (
  task_id    text not null,
  reminder   text not null,
  fired_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (task_id, reminder)
);

create index if not exists blobs_updated_idx on blobs (updated_at);
