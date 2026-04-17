-- Realtime sync for tasks and documents so assignees see updates without refresh.
-- If a line errors because the table is already in the publication, skip that line in the SQL editor.
alter publication supabase_realtime add table public.fs_tasks;
alter publication supabase_realtime add table public.fs_documents;
