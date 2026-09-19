alter table deployments add column if not exists gpu boolean not null default false;
alter table deployments add column if not exists gpu_status text;
alter table deployments add column if not exists gpu_url text;
alter table deployments add column if not exists egress jsonb;
alter table deployments add column if not exists events jsonb not null default '[]';
alter table deployments add column if not exists error text;
alter table deployments add column if not exists public_url text;
alter table deployments add column if not exists dns_name text;
alter table deployments add column if not exists scout_sandbox_id text;
