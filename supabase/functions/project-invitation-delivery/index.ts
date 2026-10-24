import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { sendGmailInvitation } from '../_shared/gmail-smtp.ts';

type InvitationRow = {
  id: string;
  team_id: string;
  shared_project_id: string;
  email: string;
  role: 'admin' | 'member';
  invited_by: string;
  token_hash: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};

const encoder = new TextEncoder();
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function landingBase(): URL | null {
  const value = Deno.env.get('MINGLE_INVITE_JOIN_URL')?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

function emailProvider(): 'smtp' | 'resend' | null {
  const selected = Deno.env.get('MINGLE_INVITE_EMAIL_PROVIDER')?.trim().toLowerCase();
  if (selected && selected !== 'smtp' && selected !== 'resend') return null;
  const smtpUser = Deno.env.get('SMTP_USER')?.trim() ?? '';
  const smtpPassword = Deno.env.get('SMTP_PASSWORD') ?? '';
  const from = Deno.env.get('MINGLE_INVITE_FROM')?.trim() ?? '';
  const smtpAddress = from.match(/^(?:[^<>\r\n]{1,100}\s+)?<([^<>\s]+)>$/)?.[1] ?? from;
  const smtpReady = Boolean(smtpUser && smtpPassword && from && smtpAddress.toLowerCase() === smtpUser.toLowerCase()
    && !/[\r\n\0]/.test(from));
  const resendReady = Boolean(Deno.env.get('RESEND_API_KEY')?.trim() && from && !/[\r\n\0]/.test(from));
  if (selected === 'smtp') return smtpReady ? 'smtp' : null;
  if (selected === 'resend') return resendReady ? 'resend' : null;
  if (smtpReady) return 'smtp';
  if (resendReady) return 'resend';
  return null;
}

function readiness(): { configured: boolean; message?: string; joinUrlBase?: string } {
  const landing = landingBase();
  if (!landing) return { configured: false, message: 'A public HTTPS MINGLE_INVITE_JOIN_URL is required for email invitations.' };
  if (!emailProvider()) return { configured: false, message: 'Configure SMTP_USER, SMTP_PASSWORD, and matching MINGLE_INVITE_FROM for Gmail, or configure a Resend sender.', joinUrlBase: landing.href };
  return { configured: true, joinUrlBase: landing.href };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function safeRepository(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash
      || /%2f|%5c/i.test(url.pathname) || !url.pathname.replace(/\/+$/, '')) return null;
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}

function cleanHeader(value: string, max = 180): string {
  return value.replace(/[\r\n\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || 'Mingle project invitation';
}

async function tokenDigest(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function htmlLanding(): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Join a Mingle project</title><style nonce="${nonce}">body{margin:0;background:#101010;color:#f5f5f5;font:16px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.panel{max-width:30rem;margin:1rem;padding:2rem;border:1px solid #333;border-radius:1rem;background:#181818}button{padding:.8rem 1rem;border:0;border-radius:.6rem;background:#fff;color:#111;font:inherit;font-weight:600;cursor:pointer}.muted{color:#aaa}</style></head><body><main class="panel"><h1>Join a Mingle project</h1><p class="muted">Open Mingle to review this project invitation. The invite is checked against your signed-in email.</p><button id="open" type="button">Open Mingle</button></main><script nonce="${nonce}">(()=>{const value=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname);const button=document.getElementById('open');button.addEventListener('click',()=>{if(!value)return;location.href='mingle://join?token='+encodeURIComponent(value)});if(!value){button.disabled=true;button.textContent='Invitation link is unavailable'}})();</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    },
  });
}

function appendToken(token: string): string {
  const url = landingBase();
  if (!url) throw new Error('landing-unavailable');
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.href;
}

async function deliver(input: {
  provider: 'smtp' | 'resend'; invitation: InvitationRow; token: string;
  projectName: string; repositoryUrl: string;
}): Promise<void> {
  const from = Deno.env.get('MINGLE_INVITE_FROM')?.trim() ?? '';
  const smtpUser = Deno.env.get('SMTP_USER')?.trim() ?? '';
  const subject = cleanHeader(`You're invited to ${input.projectName} on Mingle`);
  const landing = appendToken(input.token);
  const project = escapeHtml(input.projectName);
  const repository = escapeHtml(input.repositoryUrl);
  const link = escapeHtml(landing);
  const html = `<!doctype html><html lang="en"><body><h1>Join ${project} on Mingle</h1><p>You were invited to collaborate on <strong>${project}</strong>.</p><p>Repository: <code>${repository}</code></p><p><a href="${link}">Review project invitation</a></p><p>If the button does not open Mingle, open this link in a browser and choose “Open Mingle”.</p></body></html>`;
  const text = `You were invited to collaborate on ${input.projectName} in Mingle.\nRepository: ${input.repositoryUrl}\nReview the invitation: ${landing}\n`;
  if (input.provider === 'smtp') {
    await sendGmailInvitation({
      user: smtpUser, password: Deno.env.get('SMTP_PASSWORD') ?? '', to: input.invitation.email,
      subject, text, html, messageId: input.invitation.id,
    }, { connect: () => Deno.connectTls({ hostname: 'smtp.gmail.com', port: 465 }), timeoutMs: 35_000 });
    return;
  }

  const apiKey = Deno.env.get('RESEND_API_KEY')?.trim();
  if (!apiKey) throw new Error('sender-unavailable');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [input.invitation.email], subject, text, html }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('sender-rejected');
}

function bearer(request: Request): string | null {
  const value = request.headers.get('authorization');
  const match = value?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

async function authenticatedClient(request: Request) {
  const token = bearer(request);
  const url = Deno.env.get('SUPABASE_URL')?.trim();
  let key = Deno.env.get('SUPABASE_PUBLISHABLE_KEY')?.trim() || '';
  const managedKeys = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
  if (!key && managedKeys) {
    try {
      const parsed: unknown = JSON.parse(managedKeys);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const defaultKey = (parsed as Record<string, unknown>).default;
        if (typeof defaultKey === 'string') key = defaultKey.trim();
        else if (defaultKey && typeof defaultKey === 'object' && !Array.isArray(defaultKey)) {
          const value = (defaultKey as Record<string, unknown>).key;
          if (typeof value === 'string') key = value.trim();
        }
      }
    } catch { /* Fall back to legacy publishable/anon environment keys below. */ }
  }
  key ||= Deno.env.get('SUPABASE_ANON_KEY')?.trim() || '';
  if (!token || !url || !key) return null;
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user || data.user.is_anonymous || !data.user.email || !data.user.email_confirmed_at) return null;
  return { client, user: data.user };
}

async function handle(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname.endsWith('/open')) return htmlLanding();
  if (request.method !== 'POST') return json(404, { error: 'Not found.' });
  const authenticated = await authenticatedClient(request);
  if (!authenticated) return json(401, { error: 'A currently verified Mingle account is required.' });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json(400, { error: 'Invalid request.' });
    body = parsed as Record<string, unknown>;
  } catch { return json(400, { error: 'Invalid request.' }); }
  if (body.action === 'status') return json(200, readiness());
  if (body.action !== 'send' || typeof body.invitationId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.invitationId)
    || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(body.token)) {
    return json(400, { error: 'Invalid invitation delivery request.' });
  }
  const ready = readiness();
  if (!ready.configured) return json(200, { status: 'not_configured', message: ready.message });

  const { client, user } = authenticated;
  const { data: invitationData, error: invitationError } = await client.from('mingle_project_invitations')
    .select('id,team_id,shared_project_id,email,role,invited_by,token_hash,expires_at,accepted_at,revoked_at')
    .eq('id', body.invitationId).eq('invited_by', user.id).maybeSingle();
  if (invitationError || !invitationData) return json(404, { status: 'failed', message: 'The pending project invitation is unavailable.' });
  const invitation = invitationData as InvitationRow;
  if (invitation.accepted_at || invitation.revoked_at || Date.parse(invitation.expires_at) <= Date.now()
    || invitation.token_hash !== await tokenDigest(body.token)) {
    return json(404, { status: 'failed', message: 'The pending project invitation is unavailable.' });
  }
  const { data: role, error: roleError } = await client.from('mingle_members').select('role')
    .eq('team_id', invitation.team_id).eq('user_id', user.id).eq('role', 'owner').is('revoked_at', null).maybeSingle();
  if (roleError || !role) return json(403, { status: 'failed', message: 'Only the active project leader can deliver this invitation.' });
  const { data: projectData, error: projectError } = await client.from('mingle_projects').select('name,repository_url')
    .eq('id', invitation.shared_project_id).eq('team_id', invitation.team_id).maybeSingle();
  if (projectError || !projectData) return json(404, { status: 'failed', message: 'The shared project is unavailable.' });
  const repositoryUrl = safeRepository(projectData.repository_url);
  if (!repositoryUrl || typeof projectData.name !== 'string') return json(409, { status: 'failed', message: 'The shared repository URL is not safe to include in an invitation.' });
  const digest = await tokenDigest(body.token);
  const { data: claim, error: claimError } = await client.rpc('claim_mingle_project_invitation_delivery', {
    p_invitation_id: invitation.id, p_token_hash: digest,
  });
  if (claimError || !claim || typeof claim !== 'object') return json(404, { status: 'failed', message: 'The pending project invitation is unavailable.' });
  const claimResult = claim as Record<string, unknown>;
  if (claimResult.claimed !== true) {
    const cooldown = claimResult.reason === 'cooldown';
    const ownerHourly = claimResult.reason === 'owner_hourly_limit';
    const ownerDaily = claimResult.reason === 'owner_daily_limit';
    const limitMessage = cooldown
      ? 'Wait briefly before retrying delivery to this address.'
      : ownerHourly
        ? 'The account delivery limit for this hour has been reached. Share the join link instead.'
        : ownerDaily
          ? 'The account delivery limit for today has been reached. Share the join link instead.'
          : 'The delivery limit for this invitation address has been reached. Share the join link instead.';
    return json(429, { status: 'failed', message: limitMessage,
      ...(typeof claimResult.retry_after_seconds === 'number' ? { retryAfterSeconds: claimResult.retry_after_seconds } : {}) });
  }
  try {
    await deliver({ provider: emailProvider()!, invitation, token: body.token,
      projectName: cleanHeader(projectData.name, 100), repositoryUrl });
    return json(200, { status: 'sent', message: 'The configured sender accepted the project invitation for delivery.' });
  } catch {
    // Do not return or log SMTP/HTTP details: provider errors can include recipient
    // information, headers, credentials, or a URL containing the one-time token.
    return json(502, { status: 'failed', message: 'The configured email sender did not confirm delivery. Copy the project invite link or check sender configuration.' });
  }
}

Deno.serve((request) => handle(request).catch(() => json(500, { error: 'Project invitation service is temporarily unavailable.' })));
