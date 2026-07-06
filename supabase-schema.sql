-- ============================================================
-- PlayTest Connect PL — schemat backendu (FAZA 2, Supabase/Postgres)
-- 4 tabele: users, apps, matches, checkins
-- Licznik rejestracji = SELECT count(*) FROM users;
-- ============================================================

create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,             -- 1 konto Google = 1 użytkownik
  nick text not null check (char_length(nick) between 3 and 24),
  is_founder boolean not null default false, -- pierwsze 100 kont
  physical_device_declared boolean not null default false,
  created_at timestamptz not null default now()
);

-- automatyczne nadawanie statusu Założyciela (pierwsze 100)
create or replace function set_founder() returns trigger as $$
begin
  if (select count(*) from users) < 100 then
    new.is_founder := true;
  end if;
  return new;
end $$ language plpgsql;
create trigger trg_founder before insert on users
  for each row execute function set_founder();

create table apps (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  title text not null,
  description text,
  optin_link text not null check (optin_link like 'https://play.google.com/apps/testing/%'),
  status text not null default 'draft' check (status in ('draft','searching','testing','completed')),
  created_at timestamptz not null default now()
);

create table matches (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references apps(id) on delete cascade,
  tester_id uuid not null references users(id) on delete cascade,
  accepted_at timestamptz not null default now(),
  started_at timestamptz,                 -- moment "Pobrałem i uruchomiłem"
  screenshot_url text,                    -- dowód dnia 1 (storage bucket)
  survey_d7 jsonb,                        -- ankieta połówkowa {q1,q2,q3}
  survey_d14 jsonb,                       -- ankieta końcowa
  status text not null default 'active' check (status in ('active','done','abandoned')),
  unique (app_id, tester_id)              -- tester nie może wziąć tej samej gry 2x
);

create table checkins (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches(id) on delete cascade,
  day date not null default current_date,
  note text not null check (char_length(note) >= 10),
  created_at timestamptz not null default now(),
  unique (match_id, day)                  -- max 1 check-in dziennie (anty-spam)
);

-- Widok: aktualna ciągła seria per match (logika "14 dni ciągłych" Google)
create or replace view match_streaks as
with d as (
  select match_id, day,
         day - (row_number() over (partition by match_id order by day))::int * interval '1 day' as grp
  from checkins
)
select match_id,
       count(*) as current_streak,
       max(day) as last_checkin
from d
where grp = (select grp from d d2 where d2.match_id = d.match_id order by day desc limit 1)
group by match_id;

-- RLS (do włączenia przy wdrożeniu): każdy czyta giełdę, pisze tylko swoje
alter table users    enable row level security;
alter table apps     enable row level security;
alter table matches  enable row level security;
alter table checkins enable row level security;
