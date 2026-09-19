create table if not exists deployments (
  id uuid primary key default gen_random_uuid(),
  repo_url text not null,
  commit_sha text,
  slug text unique not null,
  status text not null default 'scouting',
  sandbox_id text,
  port integer,
  preview_url text,
  preview_token text,
  dns_record_id text,
  plan jsonb,
  lockdown jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists deployments_slug_idx on deployments (slug);
