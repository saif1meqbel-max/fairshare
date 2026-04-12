/**
 * FairShare backend bridge: optional Supabase (auth + Postgres + realtime chat)
 * and API base URL for Node server (Claude, plagiarism, Daily, Stripe).
 * Falls back to localStorage when Supabase URL/key are not set.
 */
(function () {
  const REMEMBER_KEY = 'fairshare_remember_me';
  const PREFIX = 'fs4_';
  const mem = Object.create(null);
  let sb = null;
  let remote = false;
  let viewerId = null;
  let flushTimer = null;
  let chatChannel = null;
  let notifChannel = null;

  function cfg() {
    return window.__FAIRSHARE__ || {};
  }

  /** localStorage key '1' = keep signed in (survives browser restart). '0' = this browser session only. */
  function getRememberPreference() {
    return localStorage.getItem(REMEMBER_KEY) !== '0';
  }

  function getAuthStorage() {
    return getRememberPreference() ? window.localStorage : window.sessionStorage;
  }

  function buildSupabaseClient(createClient) {
    const c = cfg();
    const storage = getAuthStorage();
    return createClient(c.supabaseUrl, c.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
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
  function rowNotif(r) {
    const b = r.body || {};
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

  async function hydrateSession(uid) {
    viewerId = uid;
    mem['session'] = uid;
    const { data: prows, error: pe } = await sb.from('fs_projects').select('*');
    if (pe) console.warn('[FSB] projects', pe);
    const projects = (prows || []).map((r) => {
      const b = r.body || {};
      return {
        ...b,
        id: r.id,
        ownerId: b.ownerId || r.owner_id,
        owner_id: r.owner_id,
      };
    });
    mem['projects_' + uid] = projects;

    const { data: sets } = await sb.from('fs_user_settings').select('*').eq('user_id', uid).maybeSingle();
    if (sets?.score_config) mem['score_config'] = sets.score_config;

    const { data: nrows } = await sb.from('fs_notifications').select('*').eq('user_id', uid);
    mem['notifs_' + uid] = (nrows || []).map(rowNotif);

    const pids = projects.map((p) => p.id);
    await loadProjectGraph(pids);

    const { data: prof } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
    const { data: allProf } = await sb.from('profiles').select('*');
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
  }

  function refreshNotifBadgeFromMem() {
    if (typeof document === 'undefined') return;
    const uid = viewerId;
    if (!uid) return;
    const list = mem['notifs_' + uid] || [];
    const unread = list.filter((n) => !n.read).length;
    const btn = document.getElementById('notif-btn');
    if (btn) btn.classList.toggle('notif-dot', unread > 0);
    if (typeof window.renderNotifications === 'function') window.renderNotifications();
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
        const { data: existing } = await sb.from('fs_projects').select('id').eq('owner_id', viewerId);
        const keep = new Set(arr.map((p) => p.id));
        for (const row of existing || []) {
          if (!keep.has(row.id)) await sb.from('fs_projects').delete().eq('id', row.id);
        }
        for (const p of arr) {
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
          await sb.from('fs_projects').upsert(
            { id: p.id, owner_id: viewerId, body },
            { onConflict: 'id' }
          );
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

  async function mapSessionUser(session) {
    const uid = session.user.id;
    const { data: prof } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
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

    async init() {
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
      remote = true;
      this.enabled = true;
      window.__FAIRSHARE_USE_REMOTE__ = true;
      attachRemoteStore();

      sb.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_OUT') {
          stopNotificationsRealtime();
          viewerId = null;
          for (const k of Object.keys(mem)) delete mem[k];
          this.lastUser = null;
          return;
        }
        if (event === 'TOKEN_REFRESHED' && session) {
          try {
            this.lastUser = await mapSessionUser(session);
          } catch (e) {
            console.warn('[FSB] TOKEN_REFRESHED', e);
          }
          return;
        }
        /* OAuth redirect: Supabase emits INITIAL_SESSION with the new session, not always SIGNED_IN. */
        if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
          try {
            await hydrateSession(session.user.id);
            this.lastUser = await mapSessionUser(session);
            if (typeof window._fairShareApplyLogin === 'function') {
              window._fairShareApplyLogin(this.lastUser);
            }
          } catch (e) {
            console.warn('[FSB] auth state', event, e);
          }
        }
      });

      const {
        data: { session },
      } = await sb.auth.getSession();
      if (session) {
        try {
          await hydrateSession(session.user.id);
          this.lastUser = await mapSessionUser(session);
        } catch (e) {
          console.warn('[FSB] getSession hydrate', e);
        }
      }
    },

    async signInWithGoogle() {
      if (!sb) throw new Error('Supabase not configured');
      this.localDemo = false;
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
      if (typeof document === 'undefined') return false;
      const lr = document.getElementById('login-remember');
      const sr = document.getElementById('su-remember');
      const loginOn = document.getElementById('login-panel')?.classList.contains('active');
      const signupOn = document.getElementById('signup-panel')?.classList.contains('active');
      let checked = true;
      if (loginOn && lr) checked = lr.checked;
      else if (signupOn && sr) checked = sr.checked;
      else if (lr) checked = lr.checked;
      else if (sr) checked = sr.checked;
      localStorage.setItem(REMEMBER_KEY, checked ? '1' : '0');
      return false;
    },

    syncRememberCheckboxes() {
      const remembered = localStorage.getItem(REMEMBER_KEY) !== '0';
      ['login-remember', 'su-remember'].forEach((id) => {
        const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
        if (el) el.checked = remembered;
      });
    },

    async signIn(email, password) {
      if (!sb) throw new Error('Supabase not configured');
      this.localDemo = false;
      remote = true;
      window.__FAIRSHARE_USE_REMOTE__ = true;
      attachRemoteStore();
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await hydrateSession(data.user.id);
      this.lastUser = await mapSessionUser(data.session);
      return this.lastUser;
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
      if (data.session) {
        remote = true;
        window.__FAIRSHARE_USE_REMOTE__ = true;
        attachRemoteStore();
        await hydrateSession(data.user.id);
        this.lastUser = await mapSessionUser(data.session);
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
      if (!this.hasCloud || !sb) return;
      this.localDemo = false;
      remote = true;
      window.__FAIRSHARE_USE_REMOTE__ = true;
      this.enabled = true;
      attachRemoteStore();
    },
  };

  attachLocalStore();
})();
