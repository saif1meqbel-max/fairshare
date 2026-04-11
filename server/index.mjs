import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import Anthropic from '@anthropic-ai/sdk';
import { registerOwnerRoutes } from './owner-dashboard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3840;
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const app = express();
app.use(cors({ origin: true, credentials: true }));

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    anthropic: Boolean(anthropic),
    daily: Boolean(process.env.DAILY_API_KEY),
    copyleaks: Boolean(process.env.COPYLEAKS_API_KEY && process.env.COPYLEAKS_EMAIL),
    plagiarismSearch: Boolean(process.env.PLAGIARISMSEARCH_API_KEY),
    stripe: Boolean(stripe && process.env.STRIPE_PRICE_PER_SEAT),
  });
});

app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(503).send('Stripe webhook not configured');
    }
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
      return res.status(400).send(`Webhook signature: ${e.message}`);
    }
    console.log('[stripe webhook]', event.type, event.id);
    res.json({ received: true });
  }
);

app.use(express.json({ limit: '2mb' }));

/** Platform owner metrics — requires X-FairShare-Owner-Secret (see .env ADMIN_PANEL_SECRET) */
registerOwnerRoutes(app, stripe);

/** Claude — AI assistant (excerpt + mode → suggestion text) */
app.post('/api/ai/suggest', async (req, res) => {
  if (!anthropic) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }
  const { mode, excerpt } = req.body || {};
  const text = typeof excerpt === 'string' ? excerpt.slice(0, 120_000) : '';
  const m = mode || 'improve';
  const system = `You are a concise academic writing coach. Respond in plain text only, 2–5 short sentences. Mode: ${m}.`;
  const userMsg = text.trim()
    ? `Here is the document excerpt to work with:\n\n${text}`
    : 'No excerpt was provided; give general guidance for this mode.';
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: userMsg }],
      system,
    });
    const block = msg.content?.find((b) => b.type === 'text');
    const suggestion = block?.type === 'text' ? block.text : '';
    res.json({ suggestion: suggestion || 'No suggestion returned.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Claude request failed' });
  }
});

/** Copyleaks: obtain bearer token */
async function copyleaksLogin() {
  const email = process.env.COPYLEAKS_EMAIL;
  const key = process.env.COPYLEAKS_API_KEY;
  if (!email || !key) return null;
  const r = await fetch('https://id.copyleaks.com/v3/account/login/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, key }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Copyleaks login failed: ${r.status} ${t}`);
  }
  const j = await r.json();
  return j.access_token || j.token || null;
}

/** Plagiarism check — Copyleaks (credits-based) or PlagiarismSearch */
app.post('/api/plagiarism/check', async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }
  const slice = text.slice(0, 50_000);

  if (process.env.PLAGIARISMSEARCH_API_KEY) {
    try {
      const body = new URLSearchParams();
      body.set('key', process.env.PLAGIARISMSEARCH_API_KEY);
      body.set('text', slice);
      const r = await fetch('https://plagiarismsearch.com/api/v2/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(502).json({ error: 'PlagiarismSearch API error', detail: j });
      }
      return res.json({ provider: 'plagiarismsearch', result: j });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'PlagiarismSearch failed' });
    }
  }

  if (process.env.COPYLEAKS_API_KEY && process.env.COPYLEAKS_EMAIL) {
    try {
      const token = await copyleaksLogin();
      if (!token) {
        return res.status(502).json({ error: 'Copyleaks login returned no token' });
      }
      const scanId = crypto.randomUUID();
      const submit = await fetch(`https://api.copyleaks.com/v3/scans/submit/file/${scanId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base64: Buffer.from(slice, 'utf8').toString('base64'),
          filename: 'fairshare.txt',
          properties: {
            webhooks: { status: `${PUBLIC_APP_URL}/api/plagiarism/webhook-copyleaks` },
          },
        }),
      });
      const sj = await submit.json().catch(() => ({}));
      if (!submit.ok) {
        return res.status(502).json({
          error: 'Copyleaks submit failed',
          detail: sj,
          hint: 'Verify credits, product (education/business), and webhook URL in Copyleaks dashboard.',
        });
      }
      return res.json({
        provider: 'copyleaks',
        scanId,
        status: 'submitted',
        message:
          'Scan queued with Copyleaks. For full results use webhooks or poll Copyleaks API; this MVP returns submit acknowledgement.',
        detail: sj,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'Copyleaks failed' });
    }
  }

  return res.status(503).json({
    error: 'No plagiarism provider configured',
    hint: 'Set PLAGIARISMSEARCH_API_KEY or COPYLEAKS_EMAIL + COPYLEAKS_API_KEY in .env',
  });
});

/** Daily.co — create a short-lived room URL for embed */
app.post('/api/video/daily-room', async (req, res) => {
  const key = process.env.DAILY_API_KEY;
  if (!key) {
    return res.status(503).json({ error: 'DAILY_API_KEY not configured' });
  }
  const name = `fs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const r = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        privacy: 'private',
        properties: {
          exp: Math.floor(Date.now() / 1000) + 3600,
          enable_screenshare: true,
          enable_chat: true,
        },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ error: 'Daily room create failed', detail: j });
    }
    const url = j.url || `https://${j.domain || 'demo'}.daily.co/${j.name || name}`;
    res.json({ url, name: j.name || name, config: j.config });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Daily request failed' });
  }
});

/** Stripe Checkout — per-seat subscription (institutional) */
app.post('/api/stripe/checkout', async (req, res) => {
  if (!stripe || !process.env.STRIPE_PRICE_PER_SEAT) {
    return res.status(503).json({ error: 'Stripe not configured (STRIPE_SECRET_KEY + STRIPE_PRICE_PER_SEAT)' });
  }
  const seats = Math.max(1, Math.min(5000, Number(req.body?.seats) || 1));
  const orgName = String(req.body?.orgName || 'Organization').slice(0, 120);
  const customerEmail = req.body?.email ? String(req.body.email).slice(0, 320) : undefined;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: customerEmail,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_PER_SEAT,
          quantity: seats,
        },
      ],
      success_url: `${PUBLIC_APP_URL}/fairshare.html?billing=success`,
      cancel_url: `${PUBLIC_APP_URL}/fairshare.html?billing=cancel`,
      metadata: { org_name: orgName, seats: String(seats) },
      subscription_data: {
        metadata: { org_name: orgName, seats: String(seats) },
      },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Stripe checkout failed' });
  }
});

app.use(express.static(rootDir));

app.listen(PORT, () => {
  console.log(`FairShare API + static at ${PUBLIC_APP_URL} (port ${PORT})`);
  if (process.env.ADMIN_PANEL_SECRET?.length >= 24) {
    console.log(`Owner metrics: ${PUBLIC_APP_URL}/fs-owner-console.html  (header X-FairShare-Owner-Secret)`);
  }
});
