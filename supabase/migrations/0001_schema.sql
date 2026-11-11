-- Core schema for the Todoist clone.
--
-- Notes:
--  * The client never talks to Postgres directly: the Express API is the only
--    door, so RLS is enabled with no permissive policies. The API uses the
--    service-role key, which bypasses RLS. Policies for shared projects are
--    added later, together with the collaboration feature.
--  * Every synced row carries `rev` (monotonic per row) and `updated_at`.
--    The client sends the `rev` it based its edit on; a mismatch is a
--    conflict for that row only.

create table if not exists projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null default 'Untitled project',
  color       text not null default '#246fe0',
  pinned      boolean not null default false,
  sections    jsonb not null default '[]'::jsonb,
  rev         bigint not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists labels (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  color       text not null default '#db4c3f',
  pinned      boolean not null default false,
  rev         bigint not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists tasks (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  project_id      uuid references projects (id) on delete set null,
  parent_id       uuid references tasks (id) on delete cascade,
  section_id      text,
  title           text not null default 'Untitled',
  description     text not null default '',
  due             date,
  due_time        time,
  start_date      date,
  recurrence      text,
  recurrence_end  jsonb,
  exceptions      jsonb not null default '[]'::jsonb,
  reminders       jsonb not null default '[]'::jsonb,
  priority        smallint not null default 4,
  duration_minutes integer,
  labels          text[] not null default '{}',
  comments        jsonb not null default '[]'::jsonb,
  attachments     jsonb not null default '[]'::jsonb,
  sort_order      integer not null default 0,
  completed       boolean not null default false,
  completed_at    timestamptz,
  rev             bigint not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create table if not exists task_labels (
  task_id   uuid not null references tasks (id) on delete cascade,
  label_id  uuid not null references labels (id) on delete cascade,
  primary key (task_id, label_id)
);

create table if not exists comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks (id) on delete cascade,
  author_id   uuid references auth.users (id) on delete set null,
  body        text not null,
  rev         bigint not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists attachments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks (id) on delete cascade,
  name        text not null,
  mime        text not null default '',
  size        integer not null default 0,
  storage_key text not null,
  rev         bigint not null default 1,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- Bump `rev` and `updated_at` on every write: the sync feed relies on both.
create or replace function bump_rev() returns trigger as $$
begin
  new.rev := old.rev + 1;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

do $$
declare t text;
begin
  foreach t in array array['projects', 'labels', 'tasks', 'comments', 'attachments'] loop
    execute format(
      'drop trigger if exists %I on %I; create trigger %I before update on %I
       for each row execute function bump_rev();',
      t || '_bump_rev', t, t || '_bump_rev', t);
  end loop;
end;
$$;

create index if not exists tasks_owner_updated_idx on tasks (owner_id, updated_at);
create index if not exists tasks_project_idx on tasks (project_id);
create index if not exists tasks_parent_idx on tasks (parent_id);
create index if not exists projects_owner_updated_idx on projects (owner_id, updated_at);
create index if not exists labels_owner_updated_idx on labels (owner_id, updated_at);
create index if not exists comments_task_idx on comments (task_id);
create index if not exists attachments_task_idx on attachments (task_id);

-- Lock it down: only the service role (the API) can read or write.
alter table projects enable row level security;
alter table labels enable row level security;
alter table tasks enable row level security;
alter table comments enable row level security;
alter table attachments enable row level security;
alter table push_subscriptions enable row level security;
-- No policies are created on purpose: with RLS enabled and no policy, the
-- anon and authenticated roles see nothing. The API's service-role key
-- bypasses RLS. Policies for shared projects arrive with that feature.
