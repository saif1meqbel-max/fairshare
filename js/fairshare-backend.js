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
  const mem = Object.create(null);
  let sb = null;
  let remote = false;
  let viewerId = null;
  let flushTimer = null;
  let chatChannel = null;
  let activityChannel = null;
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
    return { ...b, id: r.id, projectId: r.project_id };
  }
  function rowChat(r) {
    const b = r.body || {};
    return { ...b, id: r.id, projectId: r.project_id, channel: r.channel };
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

  async function loadProjectGraph(pids) {
    if (!pids.length) return;
    const [tasks, docs, acts, chats] = await Promise.all([
      sb.from('fs_tasks').select('*').in('project_id', pids),
      sb.from('fs_documents').select('*').in('project_id', pids),
      sb.from('fs_activities').select('*').in('project_id', pids),
      sb.from('fs_chat_messages').select('*').in('project_id', pids),
    ]);
    for (const pid of pids) {
      mem['tasks_' + pid] = (tasks.data || []).filter((r) => r.project_id === pid).map(rowTask);
      mem['docs_' + pid] = (docs.data || []).filter((r) => r.project_id === pid).map(rowDoc);
      mem['activity_' + pid] = (acts.data || []).filter((r) => r.project_id === pid).map(rowAct);
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
    return proj;
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
      mem['projects_' + uid] = projects;

      if (sets?.score_config) mem['score_config'] = sets.score_config;
      mem['notifs_' + uid] = (nrows || []).map(rowNotif);

      const have = new Set((mem['projects_' + uid] || []).map((p) => p.id));
      const need = [
        ...new Set(
          (mem['notifs_' + uid] || [])
            .filter((n) => String(n.type || '').toLowerCase() === 'project_invite' && n.projectId)
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
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'fs_notifications',
          filter: 'user_id=eq.' + userId,
        },
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
        }
      )
      .subscribe();
  }

  function stopNotificationsRealtime() {
    if (notifChannel && sb) {
      sb.removeChannel(notifChannel);
      notifChannel = null;
    }
  }

  async function flushToSupabase() {
    if (!remote || !viewerId) return;
    const keys = Object.keys(mem);
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
        }
      } else if (k.startsWith('tasks_')) {
        const pid = k.slice('tasks_'.length);
        const tasks = mem[k];
        if (!Array.isArray(tasks)) continue;
        await sb.from('fs_tasks').delete().eq('project_id', pid);
        if (tasks.length) {
          await sb.from('fs_tasks').insert(
            tasks.map((t) => ({
              id: t.id,
              project_id: pid,
              body: stripForBody(t, ['id', 'projectId']),
            }))
          );
        }
      } else if (k.startsWith('docs_')) {
        const pid = k.slice('docs_'.length);
        const docs = mem[k];
        if (!Array.isArray(docs)) continue;
        await sb.from('fs_documents').delete().eq('project_id', pid);
        if (docs.length) {
          await sb.from('fs_documents').insert(
            docs.map((d) => ({
              id: d.id,
              project_id: pid,
              body: stripForBody(d, ['id', 'projectId']),
            }))
          );
        }
      } else if (k.startsWith('activity_')) {
        const pid = k.slice('activity_'.length);
        const acts = mem[k];
        if (!Array.isArray(acts)) continue;
        await sb.from('fs_activities').delete().eq('project_id', pid);
        if (acts.length) {
          await sb.from('fs_activities').insert(
            acts.map((a) => ({
              id: a.id,
              project_id: pid,
              body: stripForBody(a, ['id', 'projectId']),
              created_ms: a.ts || Date.now(),
            }))
          );
        }
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
          await sb.from('fs_chat_messages').insert({
            id: m.id,
            project_id: pid,
            channel,
            body: { userId: m.userId, userName: m.userName, text: m.text, ts: m.ts },
          });
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
        await sb.from('fs_notifications').delete().eq('user_id', viewerId);
        if (notifs.length) {
          await sb.from('fs_notifications').insert(
            notifs.map((n) => ({
              id: n.id,
              user_id: viewerId,
              body: stripForBody(n, ['id']),
            }))
          );
        }
      } else if (k === 'score_config') {
        const sc = mem[k];
        if (!sc) continue;
        await sb.from('fs_user_settings').upsert(
          { user_id: viewerId, score_config: sc },
          { onConflict: 'user_id' }
        );
      }
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

  function releaseActivityChannel() {
    if (activityChannel && sb) {
      sb.removeChannel(activityChannel);
      activityChannel = null;
    }
  }

  function subscribeActivities(projectId) {
    if (!remote || !sb || !projectId) return;
    releaseActivityChannel();
    activityChannel = sb
      .channel('fs-activity-' + projectId)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'fs_activities',
          filter: 'project_id=eq.' + projectId,
        },
        (payload) => {
          const row = payload.new;
          if (!row || row.project_id !== projectId) return;
          const o = rowAct(row);
          const key = 'activity_' + projectId;
          const list = mem[key] || [];
          if (list.some((x) => x.id === o.id)) return;
          list.push(o);
          mem[key] = list;
          if (typeof window.refreshFairshareActivityUI === 'function') {
            window.refreshFairshareActivityUI(projectId);
          }
        }
      )
      .subscribe();
  }

  function subscribeChat(projectId, channel) {
    if (!remote || !sb) return;
    if (chatChannel) {
      sb.removeChannel(chatChannel);
      chatChannel = null;
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
          if (typeof window.renderChatMessages === 'function') window.renderChatMessages();
        }
      )
      .subscribe();
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
      return loadProjectRowForSession(projectId);
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

    stopActivitiesRealtime() {
      releaseActivityChannel();
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
