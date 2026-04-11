import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function getOwnerSecret(req) {
  const h = req.headers['x-fairshare-owner-secret'];
  if (typeof h === 'string' && h.length > 0) return h;
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

export function requireOwnerSecret(req, res, next) {
  const configured = process.env.ADMIN_PANEL_SECRET;
  if (!configured || configured.length < 24) {
    return res.status(503).json({
      error: 'Owner dashboard disabled',
      hint: 'Set ADMIN_PANEL_SECRET in .env (min 24 characters).',
    });
  }
  if (!timingSafeEqual(getOwnerSecret(req), configured)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function paginateStripe(fetchPage) {
  const all = [];
  let starting_after;
  for (;;) {
    const page = await fetchPage(starting_after);
    all.push(...(page.data || []));
    if (!page.has_more) break;
    starting_after = page.data?.[page.data.length - 1]?.id;
    if (!starting_after) break;
    if (all.length > 5000) break;
  }
  return all;
}

function mrrCentsFromSubscription(sub) {
  let mrr = 0;
  const items = sub.items?.data || [];
  for (const item of items) {
    const price = item.price;
    if (!price?.recurring || price.unit_amount == null) continue;
    const line = price.unit_amount * (item.quantity || 1);
    const interval = price.recurring.interval;
    if (interval === 'month') mrr += line;
    else if (interval === 'year') mrr += Math.round(line / 12);
    else if (interval === 'week') mrr += line * 4;
    else if (interval === 'day') mrr += line * 30;
  }
  return mrr;
}

async function supabaseOwnerStats() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return {
      configured: false,
      message: 'Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for user/project counts.',
    };
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const now = Date.now();
  const d7 = new Date(now - 7 * 86400000).toISOString();
  const d30 = new Date(now - 30 * 86400000).toISOString();

  const { count: profileCount, error: pErr } = await admin.from('profiles').select('*', { count: 'exact', head: true });
  if (pErr) {
    return { configured: true, error: pErr.message };
  }

  const { count: signups7 } = await admin
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', d7);
  const { count: signups30 } = await admin
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', d30);

  const { count: projectCount } = await admin.from('fs_projects').select('*', { count: 'exact', head: true });

  let authUsersTotal = null;
  let activeUsers7d = null;
  let activeUsers30d = null;
  try {
    let page = 1;
    const perPage = 1000;
    let total = 0;
    let a7 = 0;
    let a30 = 0;
    const t7 = now - 7 * 86400000;
    const t30 = now - 30 * 86400000;
    for (;;) {
      const { data: pageData, error } = await admin.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      const users = pageData?.users || [];
      if (!users.length) break;
      total += users.length;
      for (const u of users) {
        const last = u.last_sign_in_at ? new Date(u.last_sign_in_at).getTime() : 0;
        if (last >= t7) a7++;
        if (last >= t30) a30++;
      }
      if (users.length < perPage) break;
      page++;
      if (page > 50) break;
    }
    authUsersTotal = total;
    activeUsers7d = a7;
    activeUsers30d = a30;
  } catch (e) {
    authUsersTotal = null;
    activeUsers7d = null;
    activeUsers30d = null;
    return {
      configured: true,
      profilesTotal: profileCount ?? 0,
      signupsLast7Days: signups7 ?? 0,
      signupsLast30Days: signups30 ?? 0,
      projectsTotal: projectCount ?? 0,
      authUsersNote: `Could not list auth users: ${e.message}`,
    };
  }

  return {
    configured: true,
    profilesTotal: profileCount ?? 0,
    authUsersTotal,
    activeUsersLast7Days: activeUsers7d,
    activeUsersLast30Days: activeUsers30d,
    signupsLast7Days: signups7 ?? 0,
    signupsLast30Days: signups30 ?? 0,
    projectsTotal: projectCount ?? 0,
  };
}

async function stripeOwnerStats(stripe) {
  if (!stripe) {
    return { configured: false, message: 'Set STRIPE_SECRET_KEY for revenue metrics.' };
  }
  const mode = process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'live' : 'test';

  let balance = null;
  try {
    const b = await stripe.balance.retrieve();
    balance = {
      available: b.available?.map((x) => ({ amount: x.amount, currency: x.currency })) || [],
      pending: b.pending?.map((x) => ({ amount: x.amount, currency: x.currency })) || [],
    };
  } catch (e) {
    balance = { error: e.message };
  }

  const subs = await paginateStripe((sa) => stripe.subscriptions.list({ status: 'active', limit: 100, starting_after: sa }));
  let mrrCents = 0;
  let seatsSold = 0;
  for (const s of subs) {
    mrrCents += mrrCentsFromSubscription(s);
    for (const item of s.items?.data || []) {
      seatsSold += item.quantity || 0;
    }
  }

  const since = Math.floor((Date.now() - 30 * 86400000) / 1000);
  const charges = await paginateStripe((sa) =>
    stripe.charges.list({ created: { gte: since }, limit: 100, starting_after: sa })
  );
  let gross30d = 0;
  let succeeded30d = 0;
  let chargeCount = 0;
  for (const c of charges) {
    chargeCount++;
    if (c.paid && c.status === 'succeeded') {
      succeeded30d++;
      gross30d += c.amount || 0;
    }
  }

  return {
    configured: true,
    mode,
    balance,
    activeSubscriptions: subs.length,
    seatsSold,
    estimatedMrrCents: mrrCents,
    estimatedMrrFormatted: (mrrCents / 100).toFixed(2),
    chargesLast30Days: {
      count: chargeCount,
      succeededCount: succeeded30d,
      grossAmountCents: gross30d,
      grossAmountFormatted: (gross30d / 100).toFixed(2),
      note: 'Gross charges before refunds/disputes; not net profit.',
    },
  };
}

export function registerOwnerRoutes(app, stripe) {
  app.get('/api/owner/dashboard', requireOwnerSecret, async (_req, res) => {
    try {
      const [supabase, stripeStats] = await Promise.all([supabaseOwnerStats(), stripeOwnerStats(stripe)]);
      res.json({
        ok: true,
        generatedAt: new Date().toISOString(),
        supabase,
        stripe: stripeStats,
        disclaimer:
          'MRR is estimated from active subscription line items. Profit requires your own COGS; Stripe shows gross charges.',
      });
    } catch (e) {
      console.error('[owner dashboard]', e);
      res.status(500).json({ error: e.message || 'Failed to load dashboard' });
    }
  });
}
