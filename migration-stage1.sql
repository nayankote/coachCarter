-- CoachCarter Stage 1: Active Coaching migration
-- Run this in Supabase SQL Editor against your live DB

create table if not exists daily_metrics (
  id                  uuid primary key default gen_random_uuid(),
  date                date unique not null,
  sleep_score         int,
  sleep_hours         numeric,
  deep_sleep_min      int,
  light_sleep_min     int,
  rem_sleep_min       int,
  awake_min           int,
  sleep_start         timestamptz,
  sleep_end           timestamptz,
  body_battery_start  int,
  body_battery_end    int,
  stress_avg          int,
  created_at          timestamptz default now()
);

create table if not exists daily_nudges (
  id                  uuid primary key default gen_random_uuid(),
  date                date not null,
  session_id          text not null,
  nudge_type          text not null,
  email_message_id    text,
  response            text,
  response_at         timestamptz,
  created_at          timestamptz default now(),
  unique(date, session_id, nudge_type)
);

create table if not exists plan_proposals (
  id                  uuid primary key default gen_random_uuid(),
  source              text not null,
  source_workout_id   uuid references workouts(id),
  plan_week           int,
  status              text default 'proposed',
  proposal_text       text not null,
  revision_of         uuid references plan_proposals(id),
  email_message_id    text,
  athlete_response    text,
  resolved_at         timestamptz,
  created_at          timestamptz default now()
);

alter table weekly_summaries add column if not exists sleep_trend jsonb;
