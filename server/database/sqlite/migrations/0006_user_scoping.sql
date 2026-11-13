-- Per-user data isolation.
-- Adds user_id scoping to entities, documents, blobs, push subscriptions,
-- reminder bookkeeping, backups, and sync cursors.

PRAGMA foreign_keys = OFF;

-- entities: (entity,id) -> (user_id,entity,id), per-user sequence in seq values
CREATE TABLE entities_new (
  user_id    integer not null,
  entity     text not null check (entity in ('projects', 'labels', 'tasks')),
  id         text not null,
  data       text,
  rev        integer not null default 1,
  seq        integer not null,
  deleted    integer not null default 0,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (user_id, entity, id),
  foreign key (user_id) references users(id) on delete cascade
);
INSERT INTO entities_new (user_id, entity, id, data, rev, seq, deleted, updated_at)
SELECT (SELECT id FROM users ORDER BY id LIMIT 1), entity, id, data, rev, seq, deleted, updated_at
FROM entities
WHERE (SELECT id FROM users ORDER BY id LIMIT 1) IS NOT NULL;
DROP TABLE entities;
ALTER TABLE entities_new RENAME TO entities;
CREATE INDEX IF NOT EXISTS entities_user_seq_idx ON entities (user_id, seq);

-- sync_meta: global sequence -> per-user sequence
CREATE TABLE sync_meta_new (
  user_id integer not null,
  key     text not null,
  value   text not null,
  primary key (user_id, key),
  foreign key (user_id) references users(id) on delete cascade
);
INSERT INTO sync_meta_new (user_id, key, value)
SELECT (SELECT id FROM users ORDER BY id LIMIT 1), key, value
FROM sync_meta
WHERE (SELECT id FROM users ORDER BY id LIMIT 1) IS NOT NULL;
DROP TABLE sync_meta;
ALTER TABLE sync_meta_new RENAME TO sync_meta;

-- documents
CREATE TABLE documents_new (
  user_id    integer not null,
  key        text not null,
  value      text not null,
  rev        integer not null default 1,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (user_id, key),
  foreign key (user_id) references users(id) on delete cascade
);
INSERT INTO documents_new (user_id, key, value, rev, updated_at)
SELECT (SELECT id FROM users ORDER BY id LIMIT 1), key, value, rev, updated_at
FROM documents
WHERE (SELECT id FROM users ORDER BY id LIMIT 1) IS NOT NULL;
DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;

-- blobs
CREATE TABLE blobs_new (
  user_id    integer not null,
  key        text not null,
  name       text not null default '',
  mime       text not null default '',
  size       integer not null default 0,
  data       blob not null,
  rev        integer not null default 1,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (user_id, key),
  foreign key (user_id) references users(id) on delete cascade
);
INSERT INTO blobs_new (user_id, key, name, mime, size, data, rev, updated_at)
SELECT (SELECT id FROM users ORDER BY id LIMIT 1), key, name, mime, size, data, rev, updated_at
FROM blobs
WHERE (SELECT id FROM users ORDER BY id LIMIT 1) IS NOT NULL;
DROP TABLE blobs;
ALTER TABLE blobs_new RENAME TO blobs;
CREATE INDEX IF NOT EXISTS blobs_user_updated_idx ON blobs (user_id, updated_at);

-- push subscriptions
CREATE TABLE push_subscriptions_new (
  user_id     integer not null,
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  label       text,
  user_agent  text,
  last_seen_at text,
  created_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (user_id, endpoint),
  foreign key (user_id) references users(id) on delete cascade
);
INSERT INTO push_subscriptions_new (user_id, endpoint, p256dh, auth, label, user_agent, last_seen_at, created_at)
SELECT (SELECT id FROM users ORDER BY id LIMIT 1), endpoint, p256dh, auth, label, user_agent, last_seen_at, created_at
FROM push_subscriptions
WHERE (SELECT id FROM users ORDER BY id LIMIT 1) IS NOT NULL;
DROP TABLE push_subscriptions;
ALTER TABLE push_subscriptions_new RENAME TO push_subscriptions;

-- reminder_fired
CREATE TABLE reminder_fired_new (
  user_id    integer not null,
  task_id    text not null,
  reminder   text not null,
  fired_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (user_id, task_id, reminder),
  foreign key (user_id) references users(id) on delete cascade
);
INSERT INTO reminder_fired_new (user_id, task_id, reminder, fired_at)
SELECT (SELECT id FROM users ORDER BY id LIMIT 1), task_id, reminder, fired_at
FROM reminder_fired
WHERE (SELECT id FROM users ORDER BY id LIMIT 1) IS NOT NULL;
DROP TABLE reminder_fired;
ALTER TABLE reminder_fired_new RENAME TO reminder_fired;

-- state_backups
CREATE TABLE state_backups_new (
  id         integer primary key autoincrement,
  user_id    integer not null,
  tag        text not null,
  value      text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  foreign key (user_id) references users(id) on delete cascade
);
INSERT INTO state_backups_new (id, user_id, tag, value, created_at)
SELECT id, (SELECT id FROM users ORDER BY id LIMIT 1), tag, value, created_at
FROM state_backups
WHERE (SELECT id FROM users ORDER BY id LIMIT 1) IS NOT NULL;
DROP TABLE state_backups;
ALTER TABLE state_backups_new RENAME TO state_backups;
CREATE INDEX IF NOT EXISTS state_backups_user_tag_idx ON state_backups (user_id, tag, created_at);

PRAGMA foreign_keys = ON;
