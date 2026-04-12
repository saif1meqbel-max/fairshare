-- Enable Realtime for team activity feed (live dashboard / activity tab).
-- Apply in Supabase: SQL Editor, or `supabase db push` if you use the CLI.
alter publication supabase_realtime add table public.fs_activities;
