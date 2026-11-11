# Supabase

Everything Supabase-related for this project.

## Layout

```
supabase/
├── migrations/     ← the single source of truth for the SQL schema
│   └── 0001_schema.sql
└── README.md
```

## Applying the migrations

Either with the Supabase CLI:

```bash
supabase db push            # from the repo root
```

or from the API, which keeps the same ordering guarantee as the client's
`MIGRATIONS` (each file upgrades from the previous version):

```bash
cd server && pnpm migrate
```

## The shape of the setup

- **Postgres** holds the data: `projects`, `labels`, `tasks`, `task_labels`,
  `comments`, `attachments`, `push_subscriptions`.
- **Auth** issues the tokens; the API verifies them against Supabase's JWKS.
- **Storage** holds the attachment bytes; the client uploads straight to it
  with a presigned URL, so large files never pass through the API.
- **RLS is enabled with no permissive policies** on purpose: the browser
  never talks to Postgres directly, only the Express API does (with the
  service-role key, which bypasses RLS). Policies for shared projects are
  added together with the collaboration feature.

## Sync contract

Every synced row has `rev` (monotonic per row) and `updated_at`.

- Pull: `GET /api/sync/changes?since=<cursor>` → rows changed since the cursor.
- Push: `POST /api/sync/changes` → `{ id, rev, patch }` per row. A `rev` that
  no longer matches comes back as a conflict **for that row only**.
