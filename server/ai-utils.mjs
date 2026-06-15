/**
 * FairShare AI — shared utilities
 * buildProjectSnapshot(), selectModel(), verifyJWT()
 */

import { createClient } from '@supabase/supabase-js';
import OpenAI    from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// ── Model clients ─────────────────────────────────────────────────────────────
export function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured.');
  return new OpenAI({ apiKey: key });
}

export function getAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not configured.');
  return new Anthropic({ apiKey: key });
}

export const OPENAI_MODEL    = process.env.OPENAI_MODEL    || 'gpt-4o';
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

/**
 * selectModel — route to the right provider based on task type.
 * - Qualitative / reasoning-heavy tasks → Claude
 * - Structured JSON scoring / fast breakdowns → OpenAI
 */
export function selectModel(taskType) {
  const claudeTasks = new Set(['predict', 'report', 'chat', 'anomaly_narrative']);
  return claudeTasks.has(taskType) ? 'anthropic' : 'openai';
}

// ── Auth ──────────────────────────────────────────────────────────────────────
/**
 * verifyJWT — validates a Supabase JWT from the Authorization header.
 * Returns { user, supabase } where supabase is a user-scoped client (respects RLS).
 */
export async function verifyJWT(authHeader) {
  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new Error('Missing authorization token.');

  const supabaseUrl  = process.env.SUPABASE_URL;
  const serviceKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error('Supabase credentials not configured on server.');

  const adminClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: { user }, error } = await adminClient.auth.getUser(token);
  if (error || !user) throw new Error('Invalid or expired session. Please sign in again.');

  const userClient = createClient(supabaseUrl, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  return { user, supabase: userClient };
}

// ── Project snapshot ──────────────────────────────────────────────────────────
/**
 * buildProjectSnapshot — fetches all project data from Supabase and returns a
 * normalised object that every AI endpoint consumes. All callers share this one
 * function so model prompts are always built from identical data.
 */
export async function buildProjectSnapshot(projectId, supabase) {
  const now = Date.now();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: projRow },
    { data: taskRows },
    { data: actRows },
    { data: docRows },
    { data: chatRows },
    { data: scoreRows },
  ] = await Promise.all([
    supabase.from('fs_projects').select('*').eq('id', projectId).maybeSingle(),
    supabase.from('fs_tasks').select('id, body, created_at, updated_at').eq('project_id', projectId),
    supabase.from('fs_activities').select('body, created_at').eq('project_id', projectId)
      .order('created_at', { ascending: false }).limit(150),
    supabase.from('fs_documents').select('id, body, updated_at').eq('project_id', projectId),
    supabase.from('fs_chat_messages').select('body, created_at').eq('project_id', projectId)
      .order('created_at', { ascending: false }).limit(50),
    // Historical AI scores for trend calculation (may not exist yet — ignore errors)
    supabase.from('ai_scores').select('user_id, score, breakdown, scored_at')
      .eq('project_id', projectId).order('scored_at', { ascending: false }).limit(200),
  ]);

  if (!projRow) throw new Error('Project not found or access denied.');

  const body    = typeof projRow.body === 'string' ? JSON.parse(projRow.body) : (projRow.body || {});
  const members = (body.members || []).map(m => ({
    id:    m.id   || m.email,
    name:  m.name || m.email,
    email: m.email,
    role:  m.role || 'member',
  }));

  // Normalise tasks
  const tasks = (taskRows || []).map(r => {
    const b = typeof r.body === 'string' ? JSON.parse(r.body) : (r.body || {});
    return {
      id:         r.id,
      title:      b.title   || 'Untitled',
      status:     b.status  || 'todo',
      assignedTo: b.assignedTo || null,
      priority:   b.priority   || 'medium',
      due:        b.due         || null,
      isOverdue:  !!(b.due && b.status !== 'done' && new Date(b.due) < now),
      createdAt:  r.created_at,
      updatedAt:  r.updated_at,
    };
  });

  // Normalise activities
  const activities = (actRows || []).map(r => {
    const b = typeof r.body === 'string' ? JSON.parse(r.body) : (r.body || {});
    return { type: b.type, userName: b.userName, detail: b.detail || b.text || null, ts: b.ts || r.created_at };
  });

  // Normalise docs
  const docs = (docRows || []).map(r => {
    const b = typeof r.body === 'string' ? JSON.parse(r.body) : (r.body || {});
    return { id: r.id, title: b.title || 'Untitled', editedBy: b.editedBy || null, updatedAt: r.updated_at };
  });

  // Recent chat (for collaboration signal)
  const chats = (chatRows || []).map(r => {
    const b = typeof r.body === 'string' ? JSON.parse(r.body) : (r.body || {});
    return { userName: b.userName || b.sender || null, ts: r.created_at };
  });

  // Historical scores per member (for trend)
  const historicalScores = (scoreRows || []).reduce((acc, r) => {
    if (!acc[r.user_id]) acc[r.user_id] = [];
    acc[r.user_id].push({ score: r.score, scoredAt: r.scored_at, breakdown: r.breakdown });
    return acc;
  }, {});

  // This-week activities per member
  const recentActs = activities.filter(a => a.ts && new Date(a.ts) > new Date(weekAgo));
  const activityThisWeekByMember = members.reduce((acc, m) => {
    acc[m.name] = recentActs.filter(a => a.userName === m.name).length;
    return acc;
  }, {});

  const totalTasks = tasks.length;
  const done       = tasks.filter(t => t.status === 'done').length;
  const overdue    = tasks.filter(t => t.isOverdue).length;

  return {
    project: {
      id:            projectId,
      name:          body.name          || 'Untitled Project',
      deadline:      body.deadline      || null,
      completionPct: totalTasks ? Math.round(done / totalTasks * 100) : 0,
      createdAt:     projRow.created_at,
    },
    members,
    tasks: {
      total:      totalTasks,
      done,
      inProgress: tasks.filter(t => t.status === 'in_progress').length,
      todo:       tasks.filter(t => t.status === 'todo').length,
      overdue,
      list:       tasks.slice(0, 60),
    },
    activities: {
      all:             activities.slice(0, 50),
      thisWeekByMember: activityThisWeekByMember,
    },
    documents:         docs,
    recentChat:        chats.slice(0, 30),
    historicalScores,
    snapshotAt:        now,
  };
}

// ── Token usage logger (dev only) ─────────────────────────────────────────────
export function logTokens(endpoint, usage) {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[AI tokens] ${endpoint} — prompt:${usage?.prompt_tokens ?? '?'} completion:${usage?.completion_tokens ?? '?'} total:${usage?.total_tokens ?? '?'}`);
  }
}

// ── Shared JSON response helper ───────────────────────────────────────────────
export function ok(res, data) { res.json({ ok: true, ...data }); }
export function fail(res, status, message) { res.status(status).json({ ok: false, error: message }); }
