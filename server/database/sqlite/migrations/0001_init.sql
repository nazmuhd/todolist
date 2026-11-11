-- SQLite schema for the single-user backend.
--
-- The app is local-first: the whole state document is synced as one row, and
-- small side documents (settings, filters, reminders) live next to it. This
-- keeps the storage adapter interface unchanged and the feature code untouched.
--
-- There is no auth yet, so there is no owner column. When accounts arrive,
-- these tables gain an `owner_id` and the documents/blobs get composite keys.

create table if not exists documents (
  key        text primary key,
  value      text not null,
  rev        integer not null default 1,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists blobs (
  key        text primary key,
  name       text not null default '',
  mime       text not null default '',
  size       integer not null default 0,
  data       blob not null,
  rev        integer not null default 1,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Named copies of the state, used before imports. `tag` is not unique: each
-- backup keeps its own timestamp.
create table if not exists state_backups (
  id         integer primary key autoincrement,
  tag        text not null,
  value      text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists state_backups_tag_idx on state_backups (tag, created_at);
