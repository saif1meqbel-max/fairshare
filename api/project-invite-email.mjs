const json = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

const esc = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.INVITE_EMAIL_FROM || process.env.RESEND_FROM_EMAIL;
  if (!resendKey || !fromEmail) {
    return json(res, 503, {
      error: 'Invite email service not configured',
      hint: 'Set RESEND_API_KEY and INVITE_EMAIL_FROM in Vercel environment variables',
    });
  }

  const body =
    typeof req.body === 'string'
      ? JSON.parse(req.body || '{}')
      : req.body || {};

  const recipientEmails = [...new Set((body.recipientEmails || []).map((e) => String(e || '').trim().toLowerCase()).filter(isEmail))];
  const projectName = String(body.projectName || 'FairShare project').slice(0, 140);
  const inviterName = String(body.inviterName || 'A FairShare user').slice(0, 140);
  const inviterEmail = String(body.inviterEmail || '').slice(0, 320);
  const appUrl = String(body.appUrl || '').trim();
  const websiteUrl = String(body.websiteUrl || '').trim();

  if (!recipientEmails.length) {
    return json(res, 400, { error: 'At least one valid recipient email is required' });
  }

  const subject = `${inviterName} invited you to join "${projectName}" on FairShare`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033">
      <h2 style="margin:0 0 12px">You've been invited to collaborate on FairShare</h2>
      <p style="margin:0 0 12px"><strong>${esc(inviterName)}</strong>${inviterEmail ? ` (${esc(inviterEmail)})` : ''} invited you to work on <strong>${esc(projectName)}</strong>.</p>
      <p style="margin:0 0 16px">Open FairShare to sign in or create your account, then check the Invites section inside the platform.</p>
      <p style="margin:0 0 16px">
        ${appUrl ? `<a href="${esc(appUrl)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#00d4aa;color:#081018;text-decoration:none;font-weight:700">Open FairShare</a>` : ''}
      </p>
      <p style="margin:0 0 8px">Website: ${websiteUrl ? `<a href="${esc(websiteUrl)}">${esc(websiteUrl)}</a>` : 'FairShare'}</p>
      <p style="margin:0;color:#5d6b86;font-size:13px">If you were not expecting this invitation, you can ignore this email.</p>
    </div>
  `;

  try {
    const rr = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: recipientEmails,
        subject,
        html,
      }),
    });
    const data = await rr.json().catch(() => ({}));
    if (!rr.ok) {
      return json(res, 502, { error: data?.message || 'Resend request failed', detail: data });
    }
    return json(res, 200, { ok: true, sent: recipientEmails.length, provider: 'resend', data });
  } catch (error) {
    return json(res, 500, { error: error?.message || 'Invite email request failed' });
  }
}
