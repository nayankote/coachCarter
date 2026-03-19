create table if not exists workouts (
  id                      uuid primary key default gen_random_uuid(),
  garmin_activity_id      bigint unique not null,
  sport                   text not null,
  date                    date not null,
  day_of_week             text,
  start_time              timestamptz,
  end_time                timestamptz,
  plan_week               int,
  plan_session_id         text,
  fit_file_path           text,
  duration_min            numeric,
  calories                int,
  avg_hr                  int,
  max_hr                  int,
  hr_drift                int,
  tss                     int,
  avg_power               int,
  normalized_power        int,
  variability_index       numeric,
  intensity_factor        numeric,
  power_distribution      jsonb,
  avg_pace_sec            numeric,
  main_set_pace_sec       numeric,
  distance_km             numeric,
  efficiency              jsonb,
  intervals_detected      jsonb,
  compliance_score        int,
  compliance_breakdown    jsonb,
  email_message_id        text,
  feedback                text,
  feedback_received_at    timestamptz,
  coaching_report         text,
  status                  text default 'synced',
  created_at              timestamptz default now()
);

create table if not exists sync_state (
  id              int primary key default 1,
  last_synced_at  timestamptz
);

insert into sync_state (id, last_synced_at)
values (1, now() - interval '7 days')
on conflict (id) do nothing;

create table if not exists weekly_summaries (
  id                  uuid primary key default gen_random_uuid(),
  plan_week           int,
  week_start_date     date,
  week_end_date       date,
  overall_compliance  int,
  sessions_completed  int,
  sessions_missed     int,
  summary             text,
  created_at          timestamptz default now()
);
