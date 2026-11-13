import express from 'express';
// @ts-ignore
import passport from 'passport';
// @ts-ignore
import { Strategy as LocalStrategy } from 'passport-local';
import argon2 from 'argon2';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Resend } from 'resend';
import { getDb } from '../db/index.ts';
import { z } from 'zod';
import { config } from '../config.ts';

const router = express.Router();

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getResetPasswordHtml({
  userName = 'there',
  appName = 'Todolist',
  resetLink,
  appUrl,
  logoUrl,
}: {
  userName?: string;
  appName?: string;
  resetLink: string;
  appUrl: string;
  logoUrl: string;
}) {
  const safeUserName = escapeHtml(userName);
  const safeAppName = escapeHtml(appName);
  const safeResetLink = escapeHtml(resetLink);
  const safeAppUrl = escapeHtml(appUrl);
  const safeLogoUrl = escapeHtml(logoUrl);

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Reset your password</title>
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    body { margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: #f9f9f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #202020; }
    .btn-primary:hover { background-color: #c53727 !important; }
    @media screen and (max-width: 600px) {
      .email-container { width: 100% !important; max-width: 100% !important; }
      .content-padding { padding: 32px 24px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f9f9f9;">
  <div style="display: none; font-size: 1px; line-height: 1px; max-height: 0px; max-width: 0px; opacity: 0; overflow: hidden; mso-hide: all;">
    We received a request to reset your password. This link expires in 1 hour.
    &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847;
  </div>

  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f9f9f9;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="520" class="email-container" style="max-width: 520px; width: 100%; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden;">
          <tr>
            <td align="center" style="padding: 36px 40px 0 40px; text-align: center;" class="content-padding">
              <a href="${safeAppUrl}" target="_blank" style="text-decoration: none; display: inline-block;">
                <span style="display: inline-block; vertical-align: middle;">
                  <img src="${safeLogoUrl}" alt="${safeAppName} Logo" width="28" height="28" style="display: block; border-radius: 6px; font-family: sans-serif; font-size: 14px; font-weight: bold; color: #dc4c3e;">
                </span>
                <span style="display: inline-block; vertical-align: middle; margin-left: 10px; font-size: 18px; font-weight: 700; line-height: 1; color: #202020; letter-spacing: -0.02em;">${safeAppName}</span>
              </a>
            </td>
          </tr>

          <tr>
            <td align="left" style="padding: 28px 40px 36px 40px;" class="content-padding">
              <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 700; line-height: 1.3; color: #202020; letter-spacing: -0.02em;">
                Reset your password
              </h1>

              <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #444444;">
                Hi ${safeUserName},<br><br>
                We received a request to reset the password for your <strong style="font-weight: 600; color: #202020;">${safeAppName}</strong> account. Click the button below to choose a new password and get back to your tasks.
              </p>

              <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
                <tr>
                  <td align="center" bgcolor="#dc4c3e" style="border-radius: 8px;">
                    <a href="${safeResetLink}" target="_blank" class="btn-primary" style="display: inline-block; padding: 14px 24px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; background-color: #dc4c3e;">
                      Reset password
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #666666;">
                For your security, this link will expire in <strong style="font-weight: 600; color: #202020;">1 hour</strong>. If you didn’t request a password reset, you can safely ignore this email—your current password will remain unchanged.
              </p>

              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 0 0 20px 0;">
                <tr>
                  <td style="border-top: 1px solid #e5e7eb; font-size: 0; line-height: 0;">&nbsp;</td>
                </tr>
              </table>

              <p style="margin: 0; font-size: 12px; line-height: 1.6; color: #9ca3af; word-break: break-all;">
                Having trouble with the button? Copy and paste this link into your browser:<br>
                <a href="${safeResetLink}" target="_blank" style="color: #dc4c3e; text-decoration: underline;">${safeResetLink}</a>
              </p>
            </td>
          </tr>
        </table>

        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="520" class="email-container" style="max-width: 520px; width: 100%;">
          <tr>
            <td align="center" style="padding: 24px 16px 0 16px;">
              <p style="margin: 0; font-size: 12px; color: #9ca3af;">
                Sent by ${safeAppName} &bull; <a href="${safeAppUrl}" target="_blank" style="color: #9ca3af; text-decoration: underline;">Open App</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function getResetPasswordText({
  userName = 'there',
  appName = 'Todolist',
  resetLink,
  appUrl,
}: {
  userName?: string;
  appName?: string;
  resetLink: string;
  appUrl: string;
}) {
  return [
    `Hi ${userName},`,
    '',
    `We received a request to reset the password for your ${appName} account.`,
    `Reset your password: ${resetLink}`,
    '',
    'For your security, this link will expire in 1 hour. If you didn’t request a password reset, you can safely ignore this email—your current password will remain unchanged.',
    '',
    `Open ${appName}: ${appUrl}`,
  ].join('\n');
}

let cachedLogoPath: string | null | undefined;
function getLogoPath(): string | null {
  if (cachedLogoPath !== undefined) return cachedLogoPath;
  const candidates = [
    path.resolve(process.cwd(), 'frontend/public/images/logo.png'),
    path.resolve(process.cwd(), '../frontend/public/images/logo.png'),
    path.resolve(process.cwd(), '../../frontend/public/images/logo.png'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        cachedLogoPath = p;
        return p;
      }
    } catch {}
  }
  cachedLogoPath = null;
  return null;
}

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const passwordSchema = z.string().min(8).max(200).refine(
  (v) => /[A-Za-z]/.test(v) && /\d/.test(v),
  'Password must include at least one letter and one number.'
);
const namePartSchema = z.string().trim().max(100);
const registerSchema = z.object({
  firstName: namePartSchema.optional().nullable(),
  lastName: namePartSchema.optional().nullable(),
  name: namePartSchema.optional().nullable(),
  email: z.string(),
  password: z.string(),
}).passthrough();
const loginSchema = z.object({ email: z.string(), password: z.string() }).passthrough();
const forgotSchema = z.object({ email: z.string() }).passthrough();
const resetSchema = z.object({ token: z.string(), email: z.string(), password: z.string() }).passthrough();
const profileSchema = z.object({
  firstName: z.union([z.string(), z.null()]).optional(),
  lastName: z.union([z.string(), z.null()]).optional(),
  name: z.union([z.string(), z.null()]).optional(),
}).passthrough();
const changePasswordSchema = z.object({ currentPassword: z.string(), newPassword: z.string() }).passthrough();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: config.authRateMax, message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' }, standardHeaders: true, legacyHeaders: false });

let stmts: any;
function getStmts() {
  if (!stmts) {
    const db = getDb();
    stmts = {
      findUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
      findUserById: db.prepare('SELECT id, email, name, first_name, last_name, avatar_url, email_verified, created_at FROM users WHERE id = ?'),
      insertUser: db.prepare(`INSERT INTO users (email, name, first_name, last_name, password_hash, hash_algorithm, email_verified) VALUES (?, ?, ?, ?, ?, 'argon2id', 0)`),
      updatePassword: db.prepare(`UPDATE users SET password_hash = ?, hash_algorithm = 'argon2id', updated_at = datetime('now') WHERE id = ?`),
      updateName: db.prepare(`UPDATE users SET name = ?, first_name = ?, last_name = ?, updated_at = datetime('now') WHERE id = ?`),
    };
  }
  return stmts;
}

passport.use(new LocalStrategy({ usernameField: 'email', passwordField: 'password' }, async (email: string, password: string, done: any) => {
  try {
    const user: any = getStmts().findUserByEmail.get(email.toLowerCase().trim());
    if (!user || !user.password_hash) return done(null, false, { message: 'Invalid email or password.' });
    let isValid = false;
    if (user.hash_algorithm === 'argon2id') isValid = await argon2.verify(user.password_hash, password);
    else if (user.hash_algorithm === 'bcrypt') { isValid = await bcrypt.compare(password, user.password_hash); if (isValid) { const h = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 }); getStmts().updatePassword.run(h, user.id); } }
    if (!isValid) return done(null, false, { message: 'Invalid email or password.' });
    return done(null, user);
  } catch (err) { return done(err); }
}));
passport.serializeUser((user: any, done: any) => done(null, user.id));
passport.deserializeUser((id: any, done: any) => { try { done(null, getStmts().findUserById.get(id) || false); } catch (e) { done(e); } });

router.get('/health', (_req, res) => res.json({ ok: true }));

router.get('/csrf', (req, res) => {
  const session: any = (req as any).session;
  if (!session) return res.status(500).json({ error: 'Session unavailable' });
  if (!session.csrfToken) session.csrfToken = crypto.randomBytes(32).toString('hex');
  return res.json({ csrfToken: session.csrfToken });
});

function invalidateUserSessions(userId: number, exceptSid?: string) {
  const db = getDb();
  const uid = Number(userId);
  // sess stores {"passport":{"user":<id>},...}
  try {
    if (exceptSid) db.prepare(`DELETE FROM sessions WHERE sid != ? AND CAST(json_extract(sess, '$.passport.user') AS INTEGER) = ?`).run(exceptSid, uid);
    else db.prepare(`DELETE FROM sessions WHERE CAST(json_extract(sess, '$.passport.user') AS INTEGER) = ?`).run(uid);
    return;
  } catch {}

  // Fallback: narrow candidates, then verify by parsing JSON to avoid LIKE overmatch.
  const like = `%"user":${uid}%`;
  const rows: any[] = (exceptSid
    ? db.prepare(`SELECT sid, sess FROM sessions WHERE sid != ? AND sess LIKE ?`).all(exceptSid, like)
    : db.prepare(`SELECT sid, sess FROM sessions WHERE sess LIKE ?`).all(like)) as any[];
  const del = db.prepare('DELETE FROM sessions WHERE sid = ?');
  for (const row of rows) {
    try {
      const sess = JSON.parse(String(row.sess || ''));
      const sidUser = Number(sess?.passport?.user);
      if (sidUser === uid) del.run(row.sid);
    } catch {}
  }
}

router.post('/register', authLimiter, async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'A valid email address is required.' });
    const { firstName, lastName, name, email, password } = parsed.data;
    const emailParsed = emailSchema.safeParse(email);
    if (!emailParsed.success) return res.status(400).json({ error: 'A valid email address is required.' });
    const pwParsed = passwordSchema.safeParse(password);
    if (!pwParsed.success) return res.status(400).json({ error: pwParsed.error.issues[0]?.message || 'Password must be at least 8 characters long.' });
    const ne = emailParsed.data;
    const existing = getStmts().findUserByEmail.get(ne);
    // Always perform password hashing work to reduce timing differences between
    // existing and new accounts. On conflict we return a generic failure message.
    const h = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    if (existing) {
      return res.status(409).json({ error: 'Registration could not be completed with this email address.' });
    }
    const fn = typeof firstName === 'string' ? firstName.trim() : '';
    const ln = typeof lastName === 'string' ? lastName.trim() : '';
    const fallbackName = typeof name === 'string' ? name.trim() : '';
    const combined = [fn, ln].filter(Boolean).join(' ') || fallbackName;
    const fullName = combined || null;
    let r: any;
    try {
      r = getStmts().insertUser.run(ne, fullName, fn || null, ln || null, h);
    } catch (e: any) {
      if (e?.code === 'ERR_SQLITE_ERROR' && /UNIQUE/i.test(String(e?.message))) {
        return res.status(409).json({ error: 'Registration could not be completed with this email address.' });
      }
      throw e;
    }
    const newUser = { id: Number(r.lastInsertRowid), email: ne, name: fullName, first_name: fn || null, last_name: ln || null, avatar_url: null, email_verified: 0 };
    (req as any).session.regenerate((re: any) => {
      if (re) return res.status(500).json({ error: 'Account created, but automatic login failed.' });
      (req as any).login(newUser, (err: any) => { if (err) return res.status(500).json({ error: 'Account created, but automatic login failed.' }); return res.status(201).json({ message: 'Registration successful.', user: newUser }); });
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error.' }); }
});

router.post('/login', authLimiter, (req, res, next) => {
  passport.authenticate('local', (err: any, user: any, info: any) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid email or password.' });
    (req as any).session.regenerate((e: any) => { if (e) return next(e); (req as any).login(user, (le: any) => { if (le) return next(le); const u = getStmts().findUserById.get(user.id) || user; res.json({ message: 'Logged in successfully.', user: { id: u.id, email: u.email, name: u.name, first_name: u.first_name ?? null, last_name: u.last_name ?? null, avatar_url: u.avatar_url } }); }); });
  })(req, res, next);
});

router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const parsed = forgotSchema.safeParse(req.body ?? {});
    if (!parsed.success || typeof parsed.data.email !== 'string') return res.status(400).json({ error: 'Email is required.' });
    const emailParsed = emailSchema.safeParse(parsed.data.email);
    if (!emailParsed.success) return res.status(400).json({ error: 'Email is required.' });
    const ne = emailParsed.data;
    const user: any = getStmts().findUserByEmail.get(ne);
    const generic = { message: 'If an account with that email exists, a password reset link has been sent.' };
    if (!user) return res.json(generic);
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const db = getDb();
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(user.id, tokenHash, expiresAt);
    let baseUrl = config.BASE_URL || `http://localhost:${config.PORT}`;
    try { baseUrl = new URL(baseUrl).origin + new URL(baseUrl).pathname.replace(/\/$/, ''); } catch { baseUrl = String(baseUrl).replace(/\/$/, ''); }
    const resetLink = `${baseUrl}/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`;
    if (process.env.EMAIL_DRY_RUN === '1' && !config.isProduction) return res.json({ ...generic, dev_reset_link: resetLink });
    const appUrl = baseUrl;
    const userName = user.first_name || user.name || 'there';
    const appName = 'Todolist';
    const resend = new Resend(config.RESEND_API_KEY!);
    const logoPath = getLogoPath();
    const logoContentId = 'todolist-logo';
    const logoUrl = logoPath ? `cid:${logoContentId}` : `${baseUrl}/images/logo.png`;
    const attachments = logoPath
      ? [{ content: fs.readFileSync(logoPath), filename: 'logo.png', contentId: logoContentId }]
      : undefined;
    const { error } = await resend.emails.send({
      from: config.EMAIL_FROM || 'Todolist <onboarding@resend.dev>',
      to: user.email,
      subject: 'Reset your Todolist password',
      html: getResetPasswordHtml({ userName, appName, resetLink, appUrl, logoUrl }),
      text: getResetPasswordText({ userName, appName, resetLink, appUrl }),
      ...(attachments ? { attachments } : {}),
    });
    if (error) { console.error(error); return res.status(502).json({ error: 'Unable to send reset email at this time.' }); }
    return res.json(generic);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error.' }); }
});

router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const parsed = resetSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Valid token, email, and a password of at least 8 characters are required.' });
    const { token, email, password } = parsed.data;
    const tokenParsed = z.string().min(1).max(512).safeParse(token);
    const emailParsed = emailSchema.safeParse(email);
    const pwParsed = passwordSchema.safeParse(password);
    if (!tokenParsed.success || !emailParsed.success) return res.status(400).json({ error: 'Valid token, email, and a password of at least 8 characters are required.' });
    if (!pwParsed.success) return res.status(400).json({ error: pwParsed.error.issues[0]?.message || 'Password must be at least 8 characters long.' });
    const ne = emailParsed.data;
    const user: any = getStmts().findUserByEmail.get(ne);
    if (!user) return res.status(400).json({ error: 'Invalid or expired password reset token.' });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const db = getDb();
    const resetRecord: any = db.prepare('SELECT * FROM password_resets WHERE user_id = ? AND token_hash = ?').get(user.id, tokenHash);
    if (!resetRecord || new Date(resetRecord.expires_at) < new Date()) return res.status(400).json({ error: 'Invalid or expired password reset token.' });
    const newPasswordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    db.exec('BEGIN IMMEDIATE');
    try { getStmts().updatePassword.run(newPasswordHash, user.id); db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id); db.exec('COMMIT'); }
    catch (txErr) { db.exec('ROLLBACK'); throw txErr; }
    invalidateUserSessions(user.id);
    return res.json({ message: 'Password has been reset successfully. You may now log in.' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error.' }); }
});

router.get('/me', (req, res) => { if (!(req as any).isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' }); return res.json({ user: (req as any).user }); });

router.put('/profile', async (req, res) => {
  try {
    if (!(req as any).isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = profileSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid profile data.' });
    const { firstName, lastName, name } = parsed.data;
    if (firstName !== undefined && firstName !== null && typeof firstName !== 'string') return res.status(400).json({ error: 'First name must be a string.' });
    if (lastName !== undefined && lastName !== null && typeof lastName !== 'string') return res.status(400).json({ error: 'Last name must be a string.' });
    if (name !== undefined && name !== null && typeof name !== 'string') return res.status(400).json({ error: 'Name must be a string.' });
    const fn = typeof firstName === 'string' ? firstName.trim().slice(0, 100) : '';
    const ln = typeof lastName === 'string' ? lastName.trim().slice(0, 100) : '';
    const fallbackName = typeof name === 'string' ? name.trim().slice(0, 200) : '';
    const fullName = ([fn, ln].filter(Boolean).join(' ') || fallbackName) || null;
    const userId = (req as any).user?.id;
    getStmts().updateName.run(fullName, fn || null, ln || null, userId);
    const user = getStmts().findUserById.get(userId);
    return res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/change-password', authLimiter, async (req, res) => {
  try {
    if (!(req as any).isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = changePasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Current password is required.' });
    const { currentPassword, newPassword } = parsed.data;
    if (!currentPassword || typeof currentPassword !== 'string' || currentPassword.length > 200) return res.status(400).json({ error: 'Current password is required.' });
    const newPw = passwordSchema.safeParse(newPassword);
    if (!newPw.success) return res.status(400).json({ error: newPw.error.issues[0]?.message || 'New password must be at least 8 characters long.' });
    const userId = (req as any).user?.id;
    const db = getDb();
    const user: any = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !user.password_hash) return res.status(400).json({ error: 'Unable to update password for this account.' });
    let isValid = false;
    if (user.hash_algorithm === 'argon2id') isValid = await argon2.verify(user.password_hash, currentPassword);
    else if (user.hash_algorithm === 'bcrypt') isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) return res.status(401).json({ error: 'Current password is incorrect.' });
    const newHash = await argon2.hash(newPw.data, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    getStmts().updatePassword.run(newHash, user.id);
    invalidateUserSessions(user.id);
    await new Promise<void>((resolve) => {
      (req as any).logout?.((err: any) => {
        if (err) console.error('Logout after password change failed:', err);
        resolve();
      }) ?? resolve();
    });
    await new Promise<void>((resolve) => {
      (req as any).session?.destroy?.((de: any) => {
        if (de) console.error('Session destroy after password change failed:', de);
        resolve();
      }) ?? resolve();
    });
    res.clearCookie('connect.sid');
    return res.json({ message: 'Password updated successfully. Please log in again.', loggedOut: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/logout', (req, res, next) => { (req as any).logout((err: any) => { if (err) return next(err); (req as any).session.destroy((de: any) => { if (de) return res.status(500).json({ error: 'Failed to destroy session.' }); res.clearCookie('connect.sid'); return res.json({ message: 'Logged out successfully.' }); }); }); });

export default router;
export { passport };
