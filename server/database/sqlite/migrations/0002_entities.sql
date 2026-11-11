-- Per-entity sync.
--
-- Each project, label and task is its own row with a revision and a global
-- sequence number. Clients pull everything with `seq > cursor` and push
-- individual records with the `rev` they last saw. A mismatch is a conflict
-- for that record only.
--
-- Rows are never hard-deleted: `deleted = 1` is a tombstone, so other clients
-- learn about the deletion on their next pull.

create table if not exists entities (
  entity     text not null check (entity in ('projects', 'labels', 'tasks')),
  id         text not null,
  data       text,              -- JSON for a live row, null for a tombstone
  rev        integer not null default 1,
  seq        integer not null,
  deleted    integer not null default 0,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (entity, id)
);

create index if not exists entities_seq_idx on entities (seq);

create table if not exists sync_meta (
  key   text primary key,
  value text not null
);

insert or ignore into sync_meta (key, value) values ('sequence', '0');
