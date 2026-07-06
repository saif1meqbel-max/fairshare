/**
 * FairShare backend bridge: optional Supabase (auth + Postgres + realtime chat)
 * and API base URL for Node server (Claude, plagiarism, Daily, Stripe).
 * Falls back to localStorage when Supabase URL/key are not set.
 */
(function () {
  const REMEMBER_KEY = 'fairshare_remember_me';
  /** When set, user chose “Try Demo” — keep STORE on localStorage so refresh stays signed in. */
  const LOCAL_MODE_KEY = 'fairshare_local_mode';
  const PREFIX = 'fs4_';
  /** Separate prefix for the localStorage durability mirror (member projects backup). */
  const BAK_PREFIX = 'fs4_bak_';

  /** Write a value to the localStorage durability mirror for project lists. */
  function bakWrite(k, v) {
    if (!k.startsWith('projects_') && !k.startsWith('member_pids_')) return;
    try { localStorage.setItem(BAK_PREFIX + k, JSON.stringify(v)); } catch (e) {}
  }

  /** Track a project ID that the signed-in user has opened as a member. */
  function bakTrackMemberProject(uid, projectId) {
    try {
      const k = BAK_PREFIX + 'member_pids_' + uid;
      const raw = localStorage.getItem(k);
      const ids = raw ? JSON.parse(raw) : [];
      if (!ids.includes(projectId)) { ids.push(projectId); localStorage.setItem(k, JSON.stringify(ids)); }
    } catch (e) {}
  }

  /** Return the list of project IDs the user has opened as a member (from localStorage). */
  function bakGetMemberProjects(uid) {
    try {
      const raw = localStorage.getItem(BAK_PREFIX + 'member_pids_' + uid);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  /**
   * Merge projects fetched from Supabase with any extra ones stored in the localStorage mirror.
   * Returns the deduplicated union. The Supabase copy wins for any project that appears in both.
   */
  function bakMerge(k, sbProjects) {
    try {
      const raw = localStorage.getItem(BAK_PREFIX + k);
      if (!raw) return sbProjects;
      const cached = JSON.parse(raw);
      if (!Array.isArray(cached) || !cached.length) return sbProjects;
      const sbIds = new Set((sbProjects || []).map((p) => p.id));
      const extra = cached.filter((p) => p && p.id && !sbIds.has(p.id));
      return [...(sbProjects || []), ...extra];
    } catch (e) { return sbProjects; }
  }
  const mem = Object.create(null);
  let sb = null;
  let remote = false;
  let viewerId = null;
  let flushTimer = null;
  let chatChannel = null;
  let activityChannel = null;
  let tasksChannel = null;
  let docsChannel = null;
  /** Realtime Broadcast: peers refetch graph when anyone saves (works if postgres_changes does not). */
  let projectBroadcastChannel = null;
  let notifChannel = null;
  /** Coalesce concurrent hydrations (e.g. signIn + onAuthStateChange). */
  const hydrateInflight = new Map();

  function cfg() {
    return window.__FAIRSHARE__ || {};
  }

  /** FairShare now always keeps users signed in until manual logout. */
  function getRememberPreference() {
    return true;
  }

  function getAuthStorage() {
    return window.localStorage;
  }

  function buildSupabaseClient(createClient) {
    const c = cfg();
    const storage = getAuthStorage();
    return createClient(c.supabaseUrl, c.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
        storage,
      },
    });
  }

  function apiBase() {
    const b = cfg().apiBase;
    if (b != null && String(b).trim() !== '') return String(b).replace(/\/$/, '');
    return '';
  }

  function attachLocalStore() {
    window.STORE = {
      get(k) {
        try {
          return JSON.parse(localStorage.getItem(PREFIX + k) || 'null');
        } catch {
          return null;
        }
      },
      set(k, v) {
        localStorage.setItem(PREFIX + k, JSON.stringify(v));
      },
      del(k) {
        localStorage.removeItem(PREFIX + k);
      },
    };
  }

  function memGet(k) {
    if (!Object.prototype.hasOwnProperty.call(mem, k)) return null;
    const v = mem[k];
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  }

  function stripForBody(obj, omit) {
    const o = { ...obj };
    for (const x of omit) delete o[x];
    return o;
  }

  /** Lowercase emails in members[] so RLS + triggers match profiles.email reliably. */
  function normalizeProjectMembers(members) {
    if (!Array.isArray(members)) return members;
    return members.map((m) => {
      if (!m || typeof m !== 'object') return m;
      const raw = m.email;
      if (raw == null || String(raw).trim() === '') return { ...m };
      return { ...m, email: String(raw).trim().toLowerCase() };
    });
  }

  function memSet(k, v) {
    mem[k] = v === undefined ? null : JSON.parse(JSON.stringify(v));
    bakWrite(k, mem[k]);   // mirror project writes to localStorage
    scheduleFlush();
  }

  function memDel(k) {
    delete mem[k];
    scheduleFlush();
  }

  function scheduleFlush() {
    if (!remote) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flushToSupabase().catch((e) => console.warn('[FSB flush]', e)), 450);
  }

  function rowTask(r) {
    const b = r.body || {};
    return { ...b, id: r.id, projectId: r.project_id };
  }
  function rowDoc(r) {
    const b = r.body || {};
    return { ...b, id: r.id, projectId: r.project_id };
  }
  function rowAct(r) {
    const b = r.body || {};
    const ts =
      b.ts != null ? Number(b.ts) : r.created_ms != null ? Number(r.created_ms) : Date.now();
    return { ...b, id: r.id, projectId: r.project_id, ts };
  }
  function rowChat(r) {
    const b = r.body || {};
    return { ...b, id: r.id, projectId: r.project_id, channel: r.channel };
  }
  function rowAiArtifact(r) {
    const b = parseJsonBody(r.body);
    return { ...b, id: r.id, projectId: r.project_id, feature: r.feature || b.feature || null };
  }
  function parseJsonBody(b) {
    if (b == null) return {};
    if (typeof b === 'string') {
      try {
        return JSON.parse(b);
      } catch {
        return {};
      }
    }
    return typeof b === 'object' ? b : {};
  }

  function rowNotif(r) {
    const b = parseJsonBody(r.body);
    return { ...b, id: r.id };
  }

  /**
   * Merge local rows with server before flush so one member cannot wipe another's tasks/docs/activity
   * with an empty or stale copy (local mem is per-tab).
   */
  function tombKey(table, pid) { return '__del_' + table + '_' + pid; }
  function tombSet(table, pid) {
    const v = mem[tombKey(table, pid)];
    return new Set(Array.isArray(v) ? v : []);
  }

  async function mergeProjectChildRows(table, pid, locals, rowMapper) {
    const { data: remote, error } = await sb.from(table).select('*').eq('project_id', pid);
    if (error) console.warn('[FSB] merge fetch', table, pid, error.message || error);
    const tombs = tombSet(table, pid);            // rows the user explicitly deleted
    const byId = Object.create(null);
    for (const r of remote || []) {
      const o = rowMapper(r);
      if (o && o.id && !tombs.has(o.id)) byId[o.id] = o;   // don't resurrect deleted rows
    }
    for (const t of locals || []) {
      if (t && t.id && !tombs.has(t.id)) {
        byId[t.id] = byId[t.id] ? { ...byId[t.id], ...t, id: t.id, projectId: pid } : { ...t, projectId: pid };
      }
    }
    return Object.values(byId);
  }

  /**
   * C2 — Non-destructive child-row sync. Replaces the old delete-then-reinsert.
   * Upserts each row (conflict on id → row-level last-writer-wins), so a failed or
   * partial write can NEVER destroy other rows or wipe a project. Deletions are
   * explicit via tombstones recorded at delete time. Every write is checked + logged.
   * @returns {Promise<boolean>} true iff all writes succeeded
   */
  async function syncChildRows(table, pid, rows, toRow) {
    let ok = true;
    const tk = tombKey(table, pid);
    const tombs = Array.isArray(mem[tk]) ? mem[tk] : [];
    if (tombs.length) {
      const { error: delErr } = await sb.from(table).delete().in('id', tombs).eq('project_id', pid);
      if (delErr) { ok = false; console.error('[FSB]', table, 'tombstone delete FAILED', pid, delErr.message || delErr); }
      else mem[tk] = [];                          // clear only on confirmed success
    }
    if (rows && rows.length) {
      const { error: upErr } = await sb.from(table).upsert(rows.map(toRow), { onConflict: 'id' });
      if (upErr) {
        ok = false;
        console.error('[FSB]', table, 'upsert FAILED', pid, upErr.message || upErr);
        if (typeof window.onSyncError === 'function') window.onSyncError(table, upErr.message || String(upErr));
      }
    }
    return ok;
  }

  async function loadProjectGraph(pids) {
    if (!pids.length) return;
    const [tasks, docs, acts, chats, aiArtifacts] = await Promise.all([
      sb.from('fs_tasks').select('*').in('project_id', pids),
      sb.from('fs_documents').select('*').in('project_id', pids),
      sb.from('fs_activities').select('*').in('project_id', pids),
      sb.from('fs_chat_messages').select('*').in('project_id', pids),
      sb.from('fs_ai_artifacts').select('*').in('project_id', pids),
    ]);
    if (tasks.error) console.warn('[FSB] fs_tasks load', tasks.error.message || tasks.error);
    if (docs.error) console.warn('[FSB] fs_documents load', docs.error.message || docs.error);
    if (acts.error) console.warn('[FSB] fs_activities load', acts.error.message || acts.error);
    if (chats.error) console.warn('[FSB] fs_chat_messages load', chats.error.message || chats.error);
    if (aiArtifacts.error) console.warn('[FSB] fs_ai_artifacts load', aiArtifacts.error.message || aiArtifacts.error);
    for (const pid of pids) {
      mem['tasks_' + pid] = (tasks.data || []).filter((r) => r.project_id === pid).map(rowTask);
      mem['docs_' + pid] = (docs.data || []).filter((r) => r.project_id === pid).map(rowDoc);
      mem['activity_' + pid] = (acts.data || [])
        .filter((r) => r.project_id === pid)
        .map(rowAct)
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const aiRow = (aiArtifacts.data || []).find((r) => r.project_id === pid && (r.feature || '') === 'bundle');
      mem['ai_artifacts_' + pid] = aiRow ? rowAiArtifact(aiRow).bundle || null : null;
    }
    for (const pid of pids) {
      const msgs = (chats.data || []).filter((r) => r.project_id === pid);
      const byCh = Object.create(null);
      for (const m of msgs) {
        const ch = m.channel || 'general';
        if (!byCh[ch]) byCh[ch] = [];
        const o = rowChat(m);
        byCh[ch].push({
          id: o.id,
          userId: o.userId,
          userName: o.userName,
          text: o.text,
          ts: o.ts || (m.created_at ? new Date(m.created_at).getTime() : Date.now()),
        });
      }
      for (const ch of Object.keys(byCh)) {
        byCh[ch].sort((a, b) => a.ts - b.ts);
        mem['chat_' + pid + '_' + ch] = byCh[ch];
      }
    }
  }

  /**
   * Load one project via RPC (authoritative membership check) or table fallback; merge into mem.
   */
  async function loadProjectRowForSession(projectId) {
    if (!remote || !sb || !viewerId) return null;
    const pid = String(projectId || '').trim();
    if (!pid) return null;
    let row = null;
    const { data: rpcData, error: rpcErr } = await sb.rpc('fs_get_project_for_user', { project_id: pid });
    if (!rpcErr && rpcData != null) {
      const arr = Array.isArray(rpcData) ? rpcData : [rpcData];
      row = arr.find((r) => r && (r.id === pid || r.body)) || arr[0] || null;
    } else if (rpcErr) {
      console.warn('[FSB] fs_get_project_for_user', pid, rpcErr.message || rpcErr);
    }
    if (!row) {
      const { data: fb, error: fbErr } = await sb.from('fs_projects').select('*').eq('id', pid).maybeSingle();
      if (fbErr) console.warn('[FSB] fs_projects fetch fallback', pid, fbErr.message || fbErr);
      else row = fb;
    }
    if (!row) return null;
    const b = parseJsonBody(row.body);
    const proj = {
      ...b,
      id: row.id,
      ownerId: b.ownerId || row.owner_id,
      owner_id: row.owner_id,
    };
    const key = 'projects_' + viewerId;
    const list = Array.isArray(mem[key]) ? [...mem[key]] : [];
    const ix = list.findIndex((p) => p.id === pid);
    if (ix >= 0) list[ix] = proj;
    else list.unshift(proj);
    mem[key] = list;
    bakWrite(key, list);  // persist shared project for member so it survives refresh
    if (viewerId) bakTrackMemberProject(viewerId, pid); // track this project ID independently
    return proj;
  }

  /**
   * Match stored members[] (often email-only) to profiles so inviteUserId is set after refresh.
   */
  async function resolveProjectMembersCore(members) {
    if (!sb || !Array.isArray(members) || !members.length) return members || [];
    const emails = [...new Set(members.map((m) => String(m.email || '').trim().toLowerCase()).filter(Boolean))];
    if (!emails.length) return members;
    const { data, error } = await sb.from('profiles').select('id,email,full_name,role').in('email', emails);
    if (error) throw error;
    const byEmail = new Map((data || []).map((p) => [String(p.email || '').trim().toLowerCase(), p]));
    return members.map((m) => {
      const hit = byEmail.get(String(m.email || '').trim().toLowerCase());
      if (!hit) return m;
      return {
        ...m,
        id: hit.id,
        inviteUserId: hit.id,
        name: hit.full_name || m.name,
        email: hit.email || m.email,
        role: hit.role || m.role,
      };
    });
  }

  /** Ensure the signed-in user's row is linked even if profile email casing differs from member.email. */
  function mergeViewerIntoMembers(members, prof) {
    if (!prof || !prof.id || !prof.email || !Array.isArray(members)) return members || [];
    const le = String(prof.email).trim().toLowerCase();
    return members.map((m) => {
      const em = String(m.email || '').trim().toLowerCase();
      if (em && em === le) {
        return {
          ...m,
          id: prof.id,
          inviteUserId: prof.id,
          name: prof.full_name || m.name,
          email: prof.email || m.email,
          role: prof.role || m.role,
        };
      }
      return m;
    });
  }

  async function enrichProjectMembers(members, prof) {
    const base = Array.isArray(members) ? members : [];
    const resolved = await resolveProjectMembersCore(base);
    return mergeViewerIntoMembers(resolved, prof);
  }

  async function hydrateSession(uid) {
    let run = hydrateInflight.get(uid);
    if (run) return run;

    run = (async () => {
      viewerId = uid;
      mem['session'] = uid;

      const [
        { data: prows, error: pe },
        { data: sets },
        { data: nrows },
        { data: prof },
      ] = await Promise.all([
        sb.from('fs_projects').select('*'),
        sb.from('fs_user_settings').select('*').eq('user_id', uid).maybeSingle(),
        sb.from('fs_notifications').select('*').eq('user_id', uid),
        sb.from('profiles').select('*').eq('id', uid).maybeSingle(),
      ]);
      if (pe) console.warn('[FSB] projects', pe);

      mem['_prof_' + uid] = prof || null;

      const projects = (prows || []).map((r) => {
        const b = parseJsonBody(r.body);
        return {
          ...b,
          id: r.id,
          ownerId: b.ownerId || r.owner_id,
          owner_id: r.owner_id,
        };
      });
      // Merge localStorage durability backup so member projects survive refresh/sign-out
      mem['projects_' + uid] = bakMerge('projects_' + uid, projects);

      if (sets?.score_config) mem['score_config'] = sets.score_config;
      mem['notifs_' + uid] = (nrows || []).map(rowNotif);

      const have = new Set((mem['projects_' + uid] || []).map((p) => p.id));
      /* Any notification with projectId can recover a shared row when SELECT was empty (RPC still allows). */
      const need = [
        ...new Set(
          (mem['notifs_' + uid] || [])
            .filter((n) => n && n.projectId && String(n.projectId).trim())
            .map((n) => String(n.projectId).trim())
            .filter((id) => id)
        ),
      ].filter((id) => !have.has(id));
      for (const nid of need) {
        try {
          await loadProjectRowForSession(nid);
        } catch (e) {
          console.warn('[FSB] invite project merge', nid, e);
        }
      }
      if (need.length) bakWrite('projects_' + uid, mem['projects_' + uid] || []);

      // Also recover via the member_pids index (handles projects where RLS is delayed)
      const memberPids = bakGetMemberProjects(uid);
      const haveNow = new Set((mem['projects_' + uid] || []).map((p) => p.id));
      const stillNeed = memberPids.filter((id) => !haveNow.has(id));
      for (const nid of stillNeed) {
        try {
          await loadProjectRowForSession(nid);
        } catch (e) {
          console.warn('[FSB] member_pids project merge', nid, e);
        }
      }
      if (stillNeed.length) bakWrite('projects_' + uid, mem['projects_' + uid] || []);

      if (remote && sb) {
        const profForEnrich = mem['_prof_' + uid] || null;
        const plist = mem['projects_' + uid] || [];
        for (let i = 0; i < plist.length; i++) {
          try {
            plist[i] = {
              ...plist[i],
              members: await enrichProjectMembers(plist[i].members || [], profForEnrich),
            };
          } catch (e) {
            console.warn('[FSB] enrich members hydrate', plist[i]?.id, e);
          }
        }
        mem['projects_' + uid] = plist;
      }

      const pids = (mem['projects_' + uid] || []).map((p) => p.id);
      let allProf = null;
      if (prof?.role === 'admin' || prof?.role === 'instructor') {
        const { data: ap } = await sb.from('profiles').select('*');
        allProf = ap;
      }
      await loadProjectGraph(pids);

      if (prof?.role === 'admin' || prof?.role === 'instructor') {
        mem['users'] = (allProf || []).map((p) => ({
          id: p.id,
          name: p.full_name,
          email: p.email,
          role: p.role,
          created: new Date(p.created_at).getTime(),
        }));
      } else {
        mem['users'] = prof
          ? [
              {
                id: prof.id,
                name: prof.full_name,
                email: prof.email,
                role: prof.role,
                created: new Date(prof.created_at).getTime(),
              },
            ]
          : [];
      }

      subscribeNotifications(uid);
      refreshNotifBadgeFromMem();
    })();

    hydrateInflight.set(uid, run);
    try {
      await run;
    } finally {
      if (hydrateInflight.get(uid) === run) hydrateInflight.delete(uid);
    }
  }

  function refreshNotifBadgeFromMem() {
    if (typeof document === 'undefined') return;
    const uid = viewerId;
    if (!uid) return;
    const list = mem['notifs_' + uid] || [];
    const unread = list.filter((n) => !n.read).length;
    const btn = document.getElementById('notif-btn');
    if (btn) btn.classList.toggle('notif-dot', unread > 0);
    /* Avoid rendering the notif panel until loginAs() sets currentUser (hydrateSession runs during signIn). */
    const app = typeof document !== 'undefined' ? document.getElementById('app') : null;
    if (app && app.classList.contains('visible') && typeof window.renderNotifications === 'function') {
      window.renderNotifications();
    }
    if (typeof window.renderProjectInvites === 'function') window.renderProjectInvites();
  }

  function subscribeNotifications(userId) {
    if (!remote || !sb) return;
    if (notifChannel) {
      sb.removeChannel(notifChannel);
      notifChannel = null;
    }
    notifChannel = sb
      .channel('fs-notifs-' + userId)
      // New notification arrives
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'fs_notifications', filter: 'user_id=eq.' + userId },
        (payload) => {
          const row = payload.new;
          if (!row) return;
          const n = rowNotif(row);
          const key = 'notifs_' + userId;
          const list = mem[key] || [];
          if (list.some((x) => x.id === n.id)) return;
          list.unshift(n);
          if (list.length > 50) list.length = 50;
          mem[key] = list;
          refreshNotifBadgeFromMem();
          if (typeof window.renderNotifications === 'function') window.renderNotifications();
          if (typeof window.renderProjectInvites === 'function') window.renderProjectInvites();
        }
      )
      // Notification marked read on another device — sync read state
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'fs_notifications', filter: 'user_id=eq.' + userId },
        (payload) => {
          const row = payload.new;
          if (!row) return;
          const key = 'notifs_' + userId;
          const list = mem[key] || [];
          const idx = list.findIndex((x) => x.id === row.id);
          if (idx >= 0) {
            const b = typeof row.body === 'string' ? JSON.parse(row.body) : (row.body || {});
            list[idx] = { ...list[idx], read: b.read ?? row.read ?? list[idx].read };
            mem[key] = list;
          }
          refreshNotifBadgeFromMem();
          if (typeof window.renderNotifications === 'function') window.renderNotifications();
        }
      )
      .subscribe((status) => {
        if (typeof window.updateRTStatus === 'function') window.updateRTStatus('notifs', status);
      });
  }

  function stopNotificationsRealtime() {
    if (notifChannel && sb) {
      sb.removeChannel(notifChannel);
      notifChannel = null;
    }
  }

  /**
   * Notify other browsers on the same project to reload tasks/docs/activity from Postgres.
   * Uses Realtime Broadcast (topic fairshare-project-{id}), not postgres replication.
   */
  async function broadcastGraphRefreshToPeers(projectId) {
    if (!sb || !remote || !projectId) return;
    return new Promise((resolve) => {
      const ch = sb.channel('fairshare-project-' + projectId, {
        config: { broadcast: { self: false } },
      });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          sb.removeChannel(ch);
        } catch (e) {}
        resolve();
      };
      const timer = setTimeout(finish, 8000);
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          ch
            .send({
              type: 'broadcast',
              event: 'graph_refresh',
              payload: { projectId },
            })
            .then(() => finish())
            .catch(() => finish());
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer);
          finish();
        }
      });
    });
  }

  async function flushToSupabase() {
    if (!remote || !viewerId) return;
    const keys = Object.keys(mem);
    const broadcastPids = new Set();
    for (const k of keys) {
      if (k.startsWith('projects_')) {
        const uid = k.slice('projects_'.length);
        if (uid !== viewerId) continue;
        const arr = mem[k];
        if (!Array.isArray(arr)) continue;
        /* Only persist rows this user owns. Shared projects (member view) must not be upserted with viewerId as owner. */
        const owned = arr.filter((p) => {
          const oid = p.ownerId || p.owner_id;
          return oid === viewerId;
        });
        const { data: existing } = await sb.from('fs_projects').select('id').eq('owner_id', viewerId);
        const keep = new Set(owned.map((p) => p.id));
        for (const row of existing || []) {
          if (!keep.has(row.id)) await sb.from('fs_projects').delete().eq('id', row.id);
        }
        for (const p of owned) {
          p.members = normalizeProjectMembers(p.members);
          const body = {
            name: p.name,
            desc: p.desc,
            deadline: p.deadline,
            instructor: p.instructor,
            members: p.members,
            created: p.created,
            status: p.status,
            ownerId: p.ownerId || viewerId,
          };
          const { error: upErr } = await sb.from('fs_projects').upsert(
            { id: p.id, owner_id: viewerId, body },
            { onConflict: 'id' }
          );
          if (upErr) console.warn('[FSB] fs_projects upsert', p.id, upErr);
          else broadcastPids.add(p.id);
        }
      } else if (k.startsWith('tasks_')) {
        const pid = k.slice('tasks_'.length);
        const tasks = mem[k];
        if (!Array.isArray(tasks)) continue;
        const merged = await mergeProjectChildRows('fs_tasks', pid, tasks, rowTask);
        mem[k] = merged;
        await syncChildRows('fs_tasks', pid, merged, (t) => ({
          id: t.id, project_id: pid, body: stripForBody(t, ['id', 'projectId']),
        }));
        broadcastPids.add(pid);
      } else if (k.startsWith('docs_')) {
        const pid = k.slice('docs_'.length);
        const docs = mem[k];
        if (!Array.isArray(docs)) continue;
        const merged = await mergeProjectChildRows('fs_documents', pid, docs, rowDoc);
        mem[k] = merged;
        await syncChildRows('fs_documents', pid, merged, (d) => ({
          id: d.id, project_id: pid, body: stripForBody(d, ['id', 'projectId']),
        }));
        broadcastPids.add(pid);
      } else if (k.startsWith('activity_')) {
        const pid = k.slice('activity_'.length);
        const acts = mem[k];
        if (!Array.isArray(acts)) continue;
        const merged = await mergeProjectChildRows('fs_activities', pid, acts, rowAct);
        mem[k] = merged;
        await syncChildRows('fs_activities', pid, merged, (a) => ({
          id: a.id, project_id: pid, body: stripForBody(a, ['id', 'projectId']), created_ms: a.ts || Date.now(),
        }));
        broadcastPids.add(pid);
      } else if (k.startsWith('chat_')) {
        const rest = k.slice('chat_'.length);
        const idx = rest.lastIndexOf('_');
        if (idx < 0) continue;
        const pid = rest.slice(0, idx);
        const channel = rest.slice(idx + 1);
        const msgs = mem[k];
        if (!Array.isArray(msgs)) continue;
        const { data: dbm } = await sb.from('fs_chat_messages').select('id').eq('project_id', pid).eq('channel', channel);
        const have = new Set((dbm || []).map((r) => r.id));
        for (const m of msgs) {
          if (have.has(m.id)) continue;
          // Capture the write result — never swallow a failed insert silently.
          // (A swallowed RLS error here is why "sender sees the message but it
          //  never persists / the recipient never receives it".)
          const { error: chatErr } = await sb.from('fs_chat_messages').insert({
            id: m.id,
            project_id: pid,
            channel,
            body: { userId: m.userId, userName: m.userName, text: m.text, ts: m.ts },
          });
          if (chatErr) {
            console.error('[FSB] fs_chat_messages insert FAILED', pid, channel, chatErr.message || chatErr);
            if (typeof window.onChatSyncError === 'function') window.onChatSyncError(chatErr.message || String(chatErr));
          } else {
            broadcastPids.add(pid);
          }
        }
      } else if (k.startsWith('notifs_')) {
        const uid = k.slice('notifs_'.length);
        if (uid !== viewerId) continue;
        let notifs = mem[k];
        if (!Array.isArray(notifs)) continue;
        const { data: serverRows } = await sb.from('fs_notifications').select('*').eq('user_id', viewerId);
        const serverList = (serverRows || []).map(rowNotif);
        const byId = Object.create(null);
        for (const r of serverList) {
          if (r && r.id) byId[r.id] = { ...r };
        }
        for (const n of notifs) {
          if (n && n.id) byId[n.id] = { ...byId[n.id], ...n };
        }
        notifs = Object.values(byId)
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))
          .slice(0, 50);
        mem[k] = notifs;
        // per-user notifications: upsert (non-destructive) + verified writes
        if (notifs.length) {
          const { error: nErr } = await sb.from('fs_notifications').upsert(
            notifs.map((n) => ({ id: n.id, user_id: viewerId, body: stripForBody(n, ['id']) })),
            { onConflict: 'id' }
          );
          if (nErr) console.error('[FSB] fs_notifications upsert FAILED', nErr.message || nErr);
        }
      } else if (k.startsWith('ai_artifacts_')) {
        const pid = k.slice('ai_artifacts_'.length);
        const bundle = mem[k];
        if (!bundle || typeof bundle !== 'object') continue;
        // single keyed bundle row → upsert (no destructive delete) + verified write
        const { error: aiErr } = await sb.from('fs_ai_artifacts').upsert(
          { id: `aibundle_${pid}`, project_id: pid, feature: 'bundle', body: { bundle, ts: Date.now() } },
          { onConflict: 'id' }
        );
        if (aiErr) console.error('[FSB] fs_ai_artifacts upsert FAILED', pid, aiErr.message || aiErr);
        broadcastPids.add(pid);
      } else if (k === 'score_config') {
        const sc = mem[k];
        if (!sc) continue;
        await sb.from('fs_user_settings').upsert(
          { user_id: viewerId, score_config: sc },
          { onConflict: 'user_id' }
        );
      }
    }
    for (const pid of broadcastPids) {
      void broadcastGraphRefreshToPeers(pid).catch((e) => console.warn('[FSB] graph broadcast', pid, e));
    }
  }

  function attachRemoteStore() {
    window.STORE = {
      get(k) {
        return memGet(k);
      },
      set(k, v) {
        memSet(k, v);
      },
      del(k) {
        memDel(k);
        scheduleFlush();
      },
    };
  }

  function releaseActivityChannel(projectId) {
    if (typeof window.clearRTChannel === 'function' && projectId) window.clearRTChannel('activity-' + projectId);
    if (activityChannel && sb) {
      sb.removeChannel(activityChannel);
      activityChannel = null;
    }
  }

  function releaseTasksChannel(projectId) {
    if (typeof window.clearRTChannel === 'function' && projectId) window.clearRTChannel('tasks-' + projectId);
    if (tasksChannel && sb) {
      sb.removeChannel(tasksChannel);
      tasksChannel = null;
    }
  }

  function releaseDocsChannel(projectId) {
    if (typeof window.clearRTChannel === 'function' && projectId) window.clearRTChannel('docs-' + projectId);
    if (docsChannel && sb) {
      sb.removeChannel(docsChannel);
      docsChannel = null;
    }
  }

  function releaseProjectBroadcastChannel(projectId) {
    if (typeof window.clearRTChannel === 'function' && projectId) window.clearRTChannel('broadcast-' + projectId);
    if (projectBroadcastChannel && sb) {
      sb.removeChannel(projectBroadcastChannel);
      projectBroadcastChannel = null;
    }
  }

  /** Reload only the project row from Supabase so members[] stays fresh after a join. */
  async function reloadProjectRow(projectId) {
    if (!remote || !sb || !viewerId) return;
    try {
      const { data: row } = await sb.from('fs_projects').select('*').eq('id', projectId).maybeSingle();
      if (!row) return;
      const b = parseJsonBody(row.body);
      const proj = { ...b, id: row.id, ownerId: b.ownerId || row.owner_id, owner_id: row.owner_id };
      const key = 'projects_' + viewerId;
      const list = Array.isArray(mem[key]) ? [...mem[key]] : [];
      const ix = list.findIndex((p) => p.id === projectId);
      if (ix >= 0) list[ix] = proj; else list.unshift(proj);
      mem[key] = list;
      bakWrite(key, list);
    } catch (e) { console.warn('[FSB] reloadProjectRow', e); }
  }

  // ── Reconnect / refocus catch-up for the open project ──────────────────────
  // Broadcast AND postgres_changes can miss events while a tab is backgrounded,
  // the device sleeps, or the network drops without a clean CHANNEL_ERROR cycle
  // (the classic "permanent desync until reload" on mobile / sleeping laptops).
  // Whenever we regain visibility / focus / network / a fresh socket, we pull the
  // authoritative state for the open project so a user is never left stale.
  let _openProjectId = null;
  let _resyncTimer = null;
  let _resyncListenersAttached = false;
  let _resyncInFlight = false;

  async function resyncOpenProject(reason) {
    if (!remote || !sb || !_openProjectId) return;
    if (typeof document !== 'undefined' && document.hidden) return; // wait until visible
    if (_resyncInFlight) return;
    _resyncInFlight = true;
    const pid = _openProjectId;
    try {
      await reloadProjectRow(pid);
      await loadProjectGraph([pid]);
      if (typeof window.refreshFairshareProjectUI === 'function')   window.refreshFairshareProjectUI(pid);
      if (typeof window.refreshFairshareTasksUI === 'function')     window.refreshFairshareTasksUI(pid);
      if (typeof window.refreshFairshareDocumentsUI === 'function') window.refreshFairshareDocumentsUI(pid);
      if (typeof window.refreshFairshareActivityUI === 'function')  window.refreshFairshareActivityUI(pid);
      if (typeof window.renderChatMessages === 'function')          window.renderChatMessages();
    } catch (e) {
      console.warn('[FSB] resyncOpenProject(' + reason + ')', e);
    } finally {
      _resyncInFlight = false;
    }
  }

  function scheduleResync(reason) {
    clearTimeout(_resyncTimer);
    _resyncTimer = setTimeout(() => { resyncOpenProject(reason); }, 350);
  }

  function ensureResyncListeners() {
    if (_resyncListenersAttached || typeof window === 'undefined') return;
    _resyncListenersAttached = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleResync('visible'); });
    window.addEventListener('online', () => scheduleResync('online'));
    window.addEventListener('focus',  () => scheduleResync('focus'));
    // Re-sync when the realtime socket itself reconnects — covers silent reconnects
    // where individual channels don't re-emit SUBSCRIBED.
    try {
      if (sb && sb.realtime && typeof sb.realtime.onOpen === 'function') {
        sb.realtime.onOpen(() => scheduleResync('socket-open'));
      }
    } catch (e) {}
  }

  /** Subscribe to fs_projects postgres_changes so project row updates (member list, name, deadline)
   *  are immediately picked up without relying solely on the Broadcast channel. */
  let projectsRealtimeChannel = null;
  function subscribeProjectsRealtime(projectId) {
    if (!remote || !sb || !projectId) return;
    if (projectsRealtimeChannel) { sb.removeChannel(projectsRealtimeChannel); projectsRealtimeChannel = null; }
    projectsRealtimeChannel = sb
      .channel('fs-projects-row-' + projectId)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'fs_projects', filter: 'id=eq.' + projectId },
        async () => {
          await reloadProjectRow(projectId);
          if (typeof window.refreshFairshareProjectUI === 'function') window.refreshFairshareProjectUI(projectId);
        }
      )
      .subscribe((status) => {
        if (typeof window.updateRTStatus === 'function') window.updateRTStatus('project-row-' + projectId, status);
        // Catch-up: pull the latest project row on every (re)subscribe so member/name/
        // deadline changes missed during a disconnect are recovered.
        if (status === 'SUBSCRIBED') {
          reloadProjectRow(projectId).then(() => {
            if (typeof window.refreshFairshareProjectUI === 'function') window.refreshFairshareProjectUI(projectId);
          }).catch(() => {});
        }
      });
  }
  function releaseProjectsRealtimeChannel(projectId) {
    if (projectsRealtimeChannel) {
      sb.removeChannel(projectsRealtimeChannel);
      projectsRealtimeChannel = null;
    }
    if (typeof window.clearRTChannel === 'function') window.clearRTChannel('project-row-' + projectId);
  }

  /** Subscribe to Broadcast events so teammates' saves trigger a full graph reload. */
  function subscribeProjectBroadcast(projectId) {
    if (!remote || !sb || !projectId) return;
    releaseProjectBroadcastChannel();
    projectBroadcastChannel = sb
      .channel('fairshare-project-' + projectId, {
        config: { broadcast: { self: false } },
      })
      .on('broadcast', { event: 'member_joined' }, async (msg) => {
        // Wait 800ms before reloading — the broadcast can arrive faster than Supabase
        // replicates the DB write, so an immediate reload may still return stale data.
        await new Promise(r => setTimeout(r, 800));
        await reloadProjectRow(projectId);
        await loadProjectGraph([projectId]);
        if (typeof window.refreshFairshareProjectUI === 'function') {
          window.refreshFairshareProjectUI(projectId, msg?.payload);
        }
        // Second reload after 3s to catch any further replication lag
        setTimeout(async () => {
          await reloadProjectRow(projectId);
          if (typeof window.refreshFairshareProjectUI === 'function') {
            window.refreshFairshareProjectUI(projectId, null);
          }
        }, 3000);
      })
      .on('broadcast', { event: 'member_removed' }, (msg) => {
        const removedId = msg?.payload?.removedUserId;
        if (typeof window.onMemberRemovedFromProject === 'function') {
          window.onMemberRemovedFromProject(projectId, removedId);
        }
      })
      .on('broadcast', { event: 'project_deleted' }, (msg) => {
        const deletedPid = msg?.payload?.projectId || projectId;
        // Scrub the deleted project from every member's local state
        if (viewerId) {
          const key = 'projects_' + viewerId;
          if (mem[key]) mem[key] = mem[key].filter((x) => x.id !== deletedPid);
          delete mem['tasks_'    + deletedPid];
          delete mem['docs_'     + deletedPid];
          delete mem['activity_' + deletedPid];
          for (const mk of Object.keys(mem)) {
            if (mk.startsWith('chat_' + deletedPid + '_')) delete mem[mk];
          }
          // Scrub localStorage backup too so it doesn't restore on refresh
          try {
            const bakKey  = BAK_PREFIX + key;
            const rawBak  = localStorage.getItem(bakKey);
            if (rawBak) localStorage.setItem(bakKey, JSON.stringify(JSON.parse(rawBak).filter(x => x.id !== deletedPid)));
            const pidsKey = BAK_PREFIX + 'member_pids_' + viewerId;
            const rawPids = localStorage.getItem(pidsKey);
            if (rawPids) localStorage.setItem(pidsKey, JSON.stringify(JSON.parse(rawPids).filter(id => id !== deletedPid)));
          } catch (e) {}
        }
        // Tell the UI to kick the member back to the projects list
        if (typeof window.onProjectDeleted === 'function') {
          window.onProjectDeleted(deletedPid);
        }
      })
      .on('broadcast', { event: 'graph_refresh' }, async () => {
        // Also reload project row on a generic graph_refresh so member changes propagate
        await reloadProjectRow(projectId);
        await loadProjectGraph([projectId]);
        if (typeof window.refreshFairshareProjectUI === 'function') {
          window.refreshFairshareProjectUI(projectId);
        }
      })
      .subscribe((status) => {
        if (typeof window.updateRTStatus === 'function') window.updateRTStatus('broadcast-' + projectId, status);
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setTimeout(() => {
            releaseProjectBroadcastChannel(projectId);
            subscribeProjectBroadcast(projectId);
          }, 3000);
        }
      });
  }

  function subscribeTasksRealtime(projectId) {
    if (!remote || !sb || !projectId) return;
    releaseTasksChannel();
    const CH = 'tasks-' + projectId;
    let reconnectTimer = null;

    async function reloadTasks() {
      const { data, error } = await sb.from('fs_tasks').select('*').eq('project_id', projectId);
      if (error) { console.warn('[FSB] tasks realtime reload', error.message || error); return; }
      mem['tasks_' + projectId] = (data || []).map(rowTask);
      if (typeof window.refreshFairshareTasksUI === 'function') window.refreshFairshareTasksUI(projectId);
    }

    tasksChannel = sb
      .channel('fs-tasks-' + projectId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fs_tasks', filter: 'project_id=eq.' + projectId }, reloadTasks)
      .subscribe((status) => {
        if (typeof window.updateRTStatus === 'function') window.updateRTStatus(CH, status);
        if (status === 'SUBSCRIBED') {
          clearTimeout(reconnectTimer);
          void reloadTasks();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reconnectTimer = setTimeout(() => { releaseTasksChannel(); subscribeTasksRealtime(projectId); }, 3000);
        }
      });
  }

  function subscribeDocumentsRealtime(projectId) {
    if (!remote || !sb || !projectId) return;
    releaseDocsChannel();
    const CH = 'docs-' + projectId;
    let reconnectTimer = null;

    async function reloadDocs() {
      const { data, error } = await sb.from('fs_documents').select('*').eq('project_id', projectId);
      if (error) { console.warn('[FSB] documents realtime reload', error.message || error); return; }
      mem['docs_' + projectId] = (data || []).map(rowDoc);
      if (typeof window.refreshFairshareDocumentsUI === 'function') window.refreshFairshareDocumentsUI(projectId);
    }

    docsChannel = sb
      .channel('fs-docs-' + projectId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fs_documents', filter: 'project_id=eq.' + projectId }, reloadDocs)
      .subscribe((status) => {
        if (typeof window.updateRTStatus === 'function') window.updateRTStatus(CH, status);
        if (status === 'SUBSCRIBED') {
          clearTimeout(reconnectTimer);
          void reloadDocs();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reconnectTimer = setTimeout(() => { releaseDocsChannel(); subscribeDocumentsRealtime(projectId); }, 3000);
        }
      });
  }

  function subscribeActivities(projectId) {
    if (!remote || !sb || !projectId) return;
    releaseActivityChannel();

    async function reloadActivitiesFromServer() {
      const { data, error } = await sb.from('fs_activities').select('*').eq('project_id', projectId);
      if (error) {
        console.warn('[FSB] activities reload', error.message || error);
        return;
      }
      const list = (data || [])
        .map(rowAct)
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));
      mem['activity_' + projectId] = list;
      if (typeof window.refreshFairshareActivityUI === 'function') {
        window.refreshFairshareActivityUI(projectId);
      }
    }

    void reloadActivitiesFromServer();

    const ACT_CH = 'activity-' + projectId;
    let actReconnectTimer = null;

    activityChannel = sb
      .channel('fs-activity-' + projectId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fs_activities', filter: 'project_id=eq.' + projectId },
        () => { void reloadActivitiesFromServer(); })
      .subscribe((status) => {
        if (typeof window.updateRTStatus === 'function') window.updateRTStatus(ACT_CH, status);
        if (status === 'SUBSCRIBED') {
          clearTimeout(actReconnectTimer);
          void reloadActivitiesFromServer();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          actReconnectTimer = setTimeout(() => { releaseActivityChannel(); subscribeActivities(projectId); }, 3000);
        }
      });
  }

  function subscribeChat(projectId, channel) {
    if (!remote || !sb) return;
    if (chatChannel) {
      sb.removeChannel(chatChannel);
      chatChannel = null;
    }

    let wasDisconnected = false;

    function notifyStatus(s) {
      if (typeof window._chatRealtimeStatus === 'function') window._chatRealtimeStatus(s);
    }

    async function refetchRecent() {
      try {
        const { data } = await sb
          .from('fs_chat_messages')
          .select('*')
          .eq('project_id', projectId)
          .eq('channel', channel)
          .order('created_at', { ascending: false })
          .limit(50);
        if (!data) return;
        const msgs = data.reverse().map((row) => {
          const o = rowChat(row);
          return { id: o.id, userId: o.userId, userName: o.userName, text: o.text,
                   ts: o.ts || (row.created_at ? new Date(row.created_at).getTime() : Date.now()) };
        });
        const key = 'chat_' + projectId + '_' + channel;
        mem[key] = msgs;
        if (typeof window.renderChatMessages === 'function') window.renderChatMessages();
      } catch (e) { console.warn('[FSB] refetchRecent', e); }
    }

    chatChannel = sb
      .channel('fs-chat-' + projectId + '-' + channel)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'fs_chat_messages',
          filter: 'project_id=eq.' + projectId,
        },
        (payload) => {
          const row = payload.new;
          if (!row || row.channel !== channel) return;
          const o = rowChat(row);
          const msg = {
            id: o.id,
            userId: o.userId,
            userName: o.userName,
            text: o.text,
            ts: o.ts || (row.created_at ? new Date(row.created_at).getTime() : Date.now()),
          };
          const key = 'chat_' + projectId + '_' + channel;
          const list = mem[key] || [];
          if (list.some((x) => x.id === msg.id)) return;
          list.push(msg);
          mem[key] = list;
          if (typeof window.appendChatMsg === 'function') window.appendChatMsg(msg);
          else if (typeof window.renderChatMessages === 'function') window.renderChatMessages();
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          notifyStatus('connected');
          if (wasDisconnected) { wasDisconnected = false; refetchRecent(); }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          wasDisconnected = true;
          notifyStatus('disconnected');
        }
      });
  }

  function userFromSession(session) {
    const u = session.user;
    const meta = u.user_metadata || {};
    return {
      id: u.id,
      name: meta.full_name || meta.name || u.email?.split('@')[0] || 'User',
      email: u.email,
      role: meta.role || 'student',
      created: Date.now(),
    };
  }

  async function mapSessionUser(session) {
    const uid = session.user.id;
    let prof = mem['_prof_' + uid];
    if (!prof) {
      const { data } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
      prof = data;
      mem['_prof_' + uid] = prof || null;
    }
    const meta = session.user.user_metadata || {};
    return {
      id: uid,
      name: prof?.full_name || meta.full_name || session.user.email?.split('@')[0] || 'User',
      email: session.user.email,
      role: prof?.role || meta.role || 'student',
      created: prof ? new Date(prof.created_at).getTime() : Date.now(),
    };
  }

  window.FSB = {
    enabled: false,
    client: null,
    apiBase,
    localDemo: false,
    lastUser: null,
    /** True after init when Supabase client exists (even if user is in local demo mode). */
    hasCloud: false,
    _initPromise: null,

    async init() {
      if (this._initPromise) return this._initPromise;
      this._initPromise = this._runInit();
      return this._initPromise;
    },

    async _runInit() {
      this.lastUser = null;
      window.__FAIRSHARE_USE_REMOTE__ = false;
      const c = cfg();
      const { createClient } = window.supabase || {};
      if (!c.supabaseUrl || !c.supabaseAnonKey || typeof createClient !== 'function') {
        attachLocalStore();
        this.enabled = false;
        this.hasCloud = false;
        return;
      }
      sb = buildSupabaseClient(createClient);
      this.client = sb;
      this.authUsesSessionStorageOnly = !getRememberPreference();
      this.hasCloud = true;
      this.enabled = true;
      /* Demo / local accounts use localStorage; cloud-synced accounts use in-memory + Supabase session. */
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem(LOCAL_MODE_KEY) === '1') {
          this.localDemo = true;
          remote = false;
          window.__FAIRSHARE_USE_REMOTE__ = false;
          attachLocalStore();
        } else {
          remote = true;
          window.__FAIRSHARE_USE_REMOTE__ = true;
          attachRemoteStore();
        }
      } catch (e) {
        remote = true;
        window.__FAIRSHARE_USE_REMOTE__ = true;
        attachRemoteStore();
      }

      sb.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_OUT') {
          releaseActivityChannel();
          releaseTasksChannel();
          releaseDocsChannel();
          releaseProjectBroadcastChannel();
          if (chatChannel && sb) {
            sb.removeChannel(chatChannel);
            chatChannel = null;
          }
          stopNotificationsRealtime();
          viewerId = null;
          for (const k of Object.keys(mem)) delete mem[k];
          this.lastUser = null;
          return;
        }
        /* Stay on Try Demo after refresh — don’t apply a leftover Supabase session from the same browser. */
        try {
          if (typeof localStorage !== 'undefined' && localStorage.getItem(LOCAL_MODE_KEY) === '1') {
            if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
          }
        } catch (e) {}
        if (event === 'TOKEN_REFRESHED' && session) {
          try {
            this.lastUser = await mapSessionUser(session);
          } catch (e) {
            console.warn('[FSB] TOKEN_REFRESHED', e);
          }
          return;
        }
        /* OAuth redirect: Supabase emits INITIAL_SESSION with the new session, not always SIGNED_IN.
         * Apply JWT-backed user immediately; hydrate in background (same pattern as password signIn). */
        if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
          try {
            this.lastUser = userFromSession(session);
            if (typeof window._fairShareApplyLogin === 'function') {
              window._fairShareApplyLogin(this.lastUser);
            }
            void hydrateSession(session.user.id)
              .then(async () => {
                const {
                  data: { session: s2 },
                } = await sb.auth.getSession();
                if (!s2?.user?.id) return;
                this.lastUser = await mapSessionUser(s2);
                if (typeof window._fairShareApplyLogin === 'function') {
                  window._fairShareApplyLogin(this.lastUser);
                }
              })
              .catch((e) => console.warn('[FSB] auth state hydrate', e));
          } catch (e) {
            console.warn('[FSB] auth state', event, e);
          }
        }
      });

      if (!this.localDemo) {
        let {
          data: { session },
        } = await sb.auth.getSession();
        if (!session?.user) {
          try {
            const { data: gu, error: uerr } = await sb.auth.getUser();
            if (gu?.user?.id && !uerr) {
              const again = await sb.auth.getSession();
              session = again.data.session;
            }
          } catch (e) {
            console.warn('[FSB] getUser fallback', e);
          }
        }
        if (session?.user) {
          try {
            this.lastUser = userFromSession(session);
          } catch (e) {
            console.warn('[FSB] userFromSession after getSession', e);
          }
          void hydrateSession(session.user.id)
            .then(async () => {
              const {
                data: { session: s2 },
              } = await sb.auth.getSession();
              if (!s2?.user?.id) return;
              try {
                this.lastUser = await mapSessionUser(s2);
                if (typeof window._fairShareRefreshAfterHydrate === 'function') {
                  window._fairShareRefreshAfterHydrate(this.lastUser);
                }
              } catch (e) {
                console.warn('[FSB] mapSessionUser after hydrate', e);
              }
            })
            .catch((e) => console.warn('[FSB] getSession hydrate', e));
        }
      }
    },

    async signInWithGoogle() {
      if (!sb) throw new Error('Supabase not configured');
      this.localDemo = false;
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(LOCAL_MODE_KEY);
      } catch (e) {}
      const redirectTo =
        typeof location !== 'undefined' && location.origin && !location.origin.startsWith('file:')
          ? `${location.origin}${location.pathname}${location.search || ''}`
          : undefined;
      const { data, error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      });
      if (error) throw error;
      return data;
    },

    /**
     * Saves "keep me signed in" without reloading. Never blocks sign-in.
     * (Storage engine is chosen once at page load; changing this takes effect next visit.)
     */
    applyRememberPreferenceFromForm() {
      localStorage.setItem(REMEMBER_KEY, '1');
      return false;
    },

    syncRememberCheckboxes() {
      ['login-remember', 'su-remember'].forEach((id) => {
        const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
        if (el) el.checked = true;
      });
    },

    async resolveProjectMembers(members) {
      return resolveProjectMembersCore(members);
    },

    async sendProjectInvites(project) {
      if (!sb || !project || !Array.isArray(project.members) || !viewerId) return 0;
      const recipients = project.members.filter((m) => m && m.inviteUserId && m.inviteUserId !== viewerId);
      if (!recipients.length) return 0;
      const now = Date.now();
      const rows = recipients.map((m) => ({
        id: `inv_${project.id}_${m.inviteUserId}_${now}_${Math.random().toString(36).slice(2, 8)}`,
        user_id: m.inviteUserId,
        body: {
          title: `Project invite: ${project.name}`,
          type: 'project_invite',
          projectId: project.id,
          projectName: project.name,
          ownerId: viewerId,
          ownerName: project.ownerName || '',
          ts: now,
          read: false,
        },
      }));
      const { error } = await sb.from('fs_notifications').insert(rows);
      if (error) throw error;
      return rows.length;
    },

    /**
     * Notify other project members (with accounts) that a new document was added. Requires migration 006 (RPC).
     */
    async notifyDocumentShared(project, doc) {
      if (!remote || !sb || !viewerId || !project || !doc) return;
      if (this.localDemo) return;
      const pid = String(project.id || '').trim();
      const did = String(doc.id || '').trim();
      if (!pid || !did) return;
      const title = String(doc.title || 'Untitled').slice(0, 200);
      const { error } = await sb.rpc('fs_notify_document_shared', {
        p_project_id: pid,
        p_document_id: did,
        p_document_title: title,
      });
      if (error) console.warn('[FSB] notifyDocumentShared', error.message || error);
    },

    async signIn(email, password) {
      if (!sb) throw new Error('Supabase not configured');
      this.localDemo = false;
      remote = true;
      window.__FAIRSHARE_USE_REMOTE__ = true;
      attachRemoteStore();
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data?.user?.id) throw new Error('Sign in failed: no user returned');

      /* Supabase often omits `session` on the password response; the client session is still persisted — read it back. */
      let session = data.session;
      if (!session?.user) {
        const { data: wrap, error: gsErr } = await sb.auth.getSession();
        if (gsErr) console.warn('[FSB] getSession after signInWithPassword', gsErr);
        session = wrap?.session ?? null;
      }
      if (!session?.user?.id) {
        throw new Error(
          'No stored session after sign-in. Confirm your email if required, or try checking “Keep me signed in” and sign in again.'
        );
      }

      /* Return immediately from JWT/metadata; load data in background (deduped with onAuthStateChange). */
      const userFast = userFromSession(session);
      this.lastUser = userFast;
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(LOCAL_MODE_KEY);
      } catch (e) {}
      void hydrateSession(session.user.id)
        .then(async () => {
          const {
            data: { session: s2 },
          } = await sb.auth.getSession();
          if (!s2?.user?.id) return;
          this.lastUser = await mapSessionUser(s2);
          if (typeof window._fairShareApplyLogin === 'function') {
            window._fairShareApplyLogin(this.lastUser);
          }
        })
        .catch((e) => console.warn('[FSB] hydrate after password sign-in', e));
      return userFast;
    },

    async signUp(email, password, fullName, role) {
      if (!sb) throw new Error('Supabase not configured');
      this.localDemo = false;
      const redirect =
        typeof location !== 'undefined' && location.origin && !location.origin.startsWith('file:')
          ? `${location.origin}${location.pathname}${location.search || ''}`
          : undefined;
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName, role: role || 'student' },
          ...(redirect ? { emailRedirectTo: redirect } : {}),
        },
      });
      if (error) {
        const msg = error.message || error.msg || String(error);
        const err = new Error(msg);
        err.code = error.code;
        err.status = error.status;
        throw err;
      }
      let session = data.session;
      if (!session?.user && data.user?.id) {
        const { data: wrap } = await sb.auth.getSession();
        session = wrap?.session ?? null;
      }
      if (session?.user?.id) {
        remote = true;
        window.__FAIRSHARE_USE_REMOTE__ = true;
        attachRemoteStore();
        await hydrateSession(session.user.id);
        this.lastUser = await mapSessionUser(session);
        try {
          if (typeof localStorage !== 'undefined') localStorage.removeItem(LOCAL_MODE_KEY);
        } catch (e) {}
        return this.lastUser;
      }
      return null;
    },

    async reloadStores() {
      if (!sb) return;
      const {
        data: { session },
      } = await sb.auth.getSession();
      if (!session?.user?.id) return;
      await hydrateSession(session.user.id);
    },

    /**
     * Load one project by id (RLS must allow — e.g. invitee is a member) and merge into session project list.
     * Used when opening a project from an invite if the list was stale.
     */
    async fetchProjectById(projectId) {
      const proj = await loadProjectRowForSession(projectId);
      if (!proj || !remote || !sb) return proj;
      const prof = mem['_prof_' + viewerId] || null;
      const key = 'projects_' + viewerId;
      const list = Array.isArray(mem[key]) ? [...mem[key]] : [];
      const ix = list.findIndex((p) => p && p.id === proj.id);
      if (ix < 0) return proj;
      try {
        list[ix] = { ...list[ix], members: await enrichProjectMembers(list[ix].members || [], prof) };
        mem[key] = list;
        return list[ix];
      } catch (e) {
        console.warn('[FSB] fetchProjectById enrich', e);
        return proj;
      }
    },

    /**
     * Persist full membership for the signed-in user (members[].inviteUserId). Requires migration 008.
     */
    async joinProject(projectId) {
      if (!remote || !sb || !viewerId) throw new Error('Sign in to join a project.');
      const pid = String(projectId || '').trim();
      if (!pid) throw new Error('Missing project id');
      const { data, error } = await sb.rpc('fs_join_project', { p_project_id: pid });
      if (error) throw error;
      const r = data && typeof data === 'object' ? data : {};
      if (r.ok === false) throw new Error(r.error || 'Could not join project');
      // Notify all project members (lead + peers) instantly that someone has joined
      try {
        const ch = sb.channel('fairshare-project-' + pid, { config: { broadcast: { self: false } } });
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 4000);
          ch.subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              clearTimeout(t);
              ch.send({ type: 'broadcast', event: 'member_joined', payload: { projectId: pid, userId: viewerId } })
                .then(resolve).catch(resolve);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(t); resolve(); }
          });
        });
        sb.removeChannel(ch);
      } catch (e) { console.warn('[FSB] member_joined broadcast', e); }
      await hydrateSession(viewerId);
      return r;
    },

    /**
     * Permanently delete a project (owner only). Cascades on DB; clears local mem + realtime channels.
     */
    async deleteProject(projectId) {
      if (!sb || !viewerId) return { ok: false, error: 'Not signed in' };
      const pid = String(projectId || '').trim();
      if (!pid) return { ok: false, error: 'Missing project id' };
      const key = 'projects_' + viewerId;
      const list = mem[key] || [];
      const p = list.find((x) => x.id === pid);
      const oid = p?.ownerId || p?.owner_id;
      if (oid !== viewerId) {
        return { ok: false, error: 'Only the project lead can delete this project' };
      }
      if (remote && window.__FAIRSHARE_USE_REMOTE__) {
        // Broadcast project_deleted BEFORE the DB delete so the channel still exists.
        // All members receive this and immediately clear the project from their state.
        try {
          const ch = sb.channel('fairshare-project-' + pid, { config: { broadcast: { self: false } } });
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 3000);
            ch.subscribe((status) => {
              if (status === 'SUBSCRIBED') {
                clearTimeout(t);
                ch.send({ type: 'broadcast', event: 'project_deleted', payload: { projectId: pid } })
                  .then(resolve).catch(resolve);
              } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(t); resolve(); }
            });
          });
          sb.removeChannel(ch);
        } catch (e) { console.warn('[FSB] project_deleted broadcast', e); }

        const { error } = await sb.from('fs_projects').delete().eq('id', pid);
        if (error) {
          console.warn('[FSB] deleteProject', error);
          return { ok: false, error: error.message || 'Could not delete project' };
        }
      }
      mem[key] = list.filter((x) => x.id !== pid);
      delete mem['tasks_' + pid];
      delete mem['docs_' + pid];
      delete mem['activity_' + pid];
      for (const mk of Object.keys(mem)) {
        if (mk.startsWith('chat_' + pid + '_')) delete mem[mk];
      }

      // Scrub the localStorage durability backup so the deleted project
      // does not get restored by bakMerge() on the next page refresh.
      try {
        // Remove from projects backup list
        const bakKey = BAK_PREFIX + key;
        const rawBak = localStorage.getItem(bakKey);
        if (rawBak) {
          const filtered = JSON.parse(rawBak).filter((x) => x.id !== pid);
          localStorage.setItem(bakKey, JSON.stringify(filtered));
        }
        // Remove from member_pids index
        const pidsKey = BAK_PREFIX + 'member_pids_' + viewerId;
        const rawPids = localStorage.getItem(pidsKey);
        if (rawPids) {
          const filtered = JSON.parse(rawPids).filter((id) => id !== pid);
          localStorage.setItem(pidsKey, JSON.stringify(filtered));
        }
        // Remove any fs4_ keys scoped to this project (tasks, docs, activity, chat)
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const lk = localStorage.key(i);
          if (lk && (lk === PREFIX + 'tasks_' + pid ||
                     lk === PREFIX + 'docs_' + pid ||
                     lk === PREFIX + 'activity_' + pid ||
                     lk.startsWith(PREFIX + 'chat_' + pid + '_'))) {
            localStorage.removeItem(lk);
          }
        }
      } catch (e) {}

      releaseActivityChannel();
      if (chatChannel && sb) {
        sb.removeChannel(chatChannel);
        chatChannel = null;
      }
      return { ok: true };
    },

    async updateProfile({ fullName }) {
      const fn = String(fullName || '').trim();
      if (!fn) throw new Error('Please enter your name');
      if (!sb || !viewerId) throw new Error('Not signed in');
      const { error: e1 } = await sb.auth.updateUser({ data: { full_name: fn } });
      if (e1) throw e1;
      const { error: e2 } = await sb.from('profiles').update({ full_name: fn }).eq('id', viewerId);
      if (e2) throw e2;
      await hydrateSession(viewerId);
      const {
        data: { session },
      } = await sb.auth.getSession();
      if (!session) throw new Error('Session lost');
      return mapSessionUser(session);
    },

    async resendConfirmationEmail(email) {
      if (!sb) throw new Error('Supabase not configured');
      const em = String(email || '')
        .trim()
        .toLowerCase();
      if (!em) throw new Error('Enter your email first');
      const { error } = await sb.auth.resend({ type: 'signup', email: em });
      if (error) throw error;
    },

    async sendPasswordResetEmail(email) {
      if (!sb) throw new Error('Supabase not configured');
      const em = String(email || '')
        .trim()
        .toLowerCase();
      if (!em) throw new Error('Enter your email first');
      const redirect =
        typeof location !== 'undefined' && location.origin && !location.origin.startsWith('file:')
          ? `${location.origin}${location.pathname}${location.search || ''}`
          : undefined;
      const { error } = await sb.auth.resetPasswordForEmail(em, redirect ? { redirectTo: redirect } : undefined);
      if (error) throw error;
    },

    async signOut() {
      this.localDemo = false;
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(LOCAL_MODE_KEY);
      } catch (e) {}
      releaseActivityChannel();
      releaseTasksChannel();
      releaseDocsChannel();
      releaseProjectBroadcastChannel();
      stopNotificationsRealtime();
      if (sb) await sb.auth.signOut();
      viewerId = null;
      this.lastUser = null;
      for (const k of Object.keys(mem)) delete mem[k];
      if (cfg().supabaseUrl && cfg().supabaseAnonKey) {
        remote = true;
        window.__FAIRSHARE_USE_REMOTE__ = true;
        this.enabled = true;
        attachRemoteStore();
      } else {
        remote = false;
        attachLocalStore();
        window.__FAIRSHARE_USE_REMOTE__ = false;
        this.enabled = false;
      }
    },

    async hydrateProject(projectId) {
      if (!remote || !projectId) return;
      await loadProjectGraph([projectId]);
    },

    startChatRealtime(projectId, channel) {
      subscribeChat(projectId, channel);
    },

    startActivitiesRealtime(projectId) {
      subscribeActivities(projectId);
    },

    startTasksRealtime(projectId) {
      subscribeTasksRealtime(projectId);
    },

    startDocumentsRealtime(projectId) {
      subscribeDocumentsRealtime(projectId);
    },

    startProjectBroadcast(projectId) {
      // Mark this as the open project and arm the reconnect/refocus catch-up.
      _openProjectId = projectId;
      ensureResyncListeners();
      subscribeProjectBroadcast(projectId);
      subscribeProjectsRealtime(projectId);
    },

    stopProjectBroadcast(projectId) {
      if (_openProjectId === projectId) _openProjectId = null;
      releaseProjectBroadcastChannel(projectId);
      releaseProjectsRealtimeChannel(projectId);
    },

    /** C2 — record an explicit deletion so the next flush removes the row from
     *  the server (and the merge won't resurrect it). Tables: 'fs_tasks' |
     *  'fs_documents' | 'fs_activities'. */
    tombstoneRow(table, projectId, id) {
      if (!table || !projectId || !id) return;
      const k = '__del_' + table + '_' + projectId;
      const arr = Array.isArray(mem[k]) ? mem[k] : [];
      if (!arr.includes(id)) arr.push(id);
      mem[k] = arr;
      if (typeof scheduleFlush === 'function') scheduleFlush();
    },

    stopActivitiesRealtime() {
      releaseActivityChannel();
    },

    stopTasksRealtime() {
      releaseTasksChannel();
    },

    stopDocumentsRealtime() {
      releaseDocsChannel();
    },

    stopChatRealtime() {
      if (chatChannel && sb) {
        sb.removeChannel(chatChannel);
        chatChannel = null;
      }
    },

    stopNotificationsRealtime() {
      stopNotificationsRealtime();
    },

    async persistNow() {
      await flushToSupabase();
    },

    useLocalDemo() {
      this.localDemo = true;
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(LOCAL_MODE_KEY, '1');
      } catch (e) {}
      remote = false;
      window.__FAIRSHARE_USE_REMOTE__ = false;
      for (const k of Object.keys(mem)) delete mem[k];
      attachLocalStore();
      if (this.hasCloud) {
        this.enabled = true;
      } else {
        this.enabled = false;
      }
    },

    /** Call before email/password or Google sign-in so Supabase is used after "Try Demo". */
    exitLocalDemoForAuth() {
      if (!this.hasCloud) return;
      this.localDemo = false;
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(LOCAL_MODE_KEY);
      } catch (e) {}
      if (!sb) return;
      remote = true;
      window.__FAIRSHARE_USE_REMOTE__ = true;
      this.enabled = true;
      attachRemoteStore();
    },
  };

  attachLocalStore();
})();
