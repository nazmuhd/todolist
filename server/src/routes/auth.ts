import express from 'express';
// @ts-ignore
import passport from 'passport';
// @ts-ignore
import { Strategy as LocalStrategy } from 'passport-local';
import argon2 from 'argon2';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { Resend } from 'resend';
import { getDb } from '../db/index.ts';
import { config } from '../config.ts';

const router = express.Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: process.env.AUTH_RATE_MAX ? Number(process.env.AUTH_RATE_MAX) : 10, message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' }, standardHeaders: true, legacyHeaders: false });

let stmts: any;
function getStmts() {
  if (!stmts) {
    const db = getDb();
    stmts = {
      findUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
      findUserById: db.prepare('SELECT id, email, name, avatar_url, email_verified, created_at FROM users WHERE id = ?'),
      insertUser: db.prepare(`INSERT INTO users (email, name, password_hash, hash_algorithm, email_verified) VALUES (?, ?, ?, 'argon2id', 0)`),
      updatePassword: db.prepare(`UPDATE users SET password_hash = ?, hash_algorithm = 'argon2id', updated_at = datetime('now') WHERE id = ?`),
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

function invalidateUserSessions(userId: number, exceptSid?: string) {
  const db = getDb();
  // sess stores {"passport":{"user":<id>},...}
  try {
    if (exceptSid) db.prepare(`DELETE FROM sessions WHERE sid != ? AND CAST(json_extract(sess, '$.passport.user') AS INTEGER) = ?`).run(exceptSid, userId);
    else db.prepare(`DELETE FROM sessions WHERE CAST(json_extract(sess, '$.passport.user') AS INTEGER) = ?`).run(userId);
  } catch {
    const like = `%"user":${Number(userId)}%`;
    if (exceptSid) db.prepare(`DELETE FROM sessions WHERE sid != ? AND sess LIKE ?`).run(exceptSid, like);
    else db.prepare(`DELETE FROM sessions WHERE sess LIKE ?`).run(like);
  }
}

router.post('/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) return res.status(400).json({ error: 'A valid email address is required.' });
    if (!password || typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    const ne = email.toLowerCase().trim();
    if (getStmts().findUserByEmail.get(ne)) return res.status(409).json({ error: 'An account with this email already exists.' });
    const h = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    let r: any;
    try {
      r = getStmts().insertUser.run(ne, name?.trim() || null, h);
    } catch (e: any) {
      if (e?.code === 'ERR_SQLITE_ERROR' && /UNIQUE/i.test(String(e?.message))) {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }
      throw e;
    }
    const newUser = { id: Number(r.lastInsertRowid), email: ne, name: name?.trim() || null, avatar_url: null, email_verified: 0 };
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
    (req as any).session.regenerate((e: any) => { if (e) return next(e); (req as any).login(user, (le: any) => { if (le) return next(le); res.json({ message: 'Logged in successfully.', user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url } }); }); });
  })(req, res, next);
});

router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email is required.' });
    const ne = email.toLowerCase().trim();
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
    const resend = new Resend(config.RESEND_API_KEY!);
    const { error } = await resend.emails.send({ from: config.EMAIL_FROM || 'Security <onboarding@resend.dev>', to: user.email, subject: 'Reset Your Password', html: `<p>We received a request to reset your password.</p><p><a href="${resetLink}">Click here to reset your password</a></p><p>This link will expire in 1 hour.</p>` });
    if (error) { console.error(error); return res.status(502).json({ error: 'Unable to send reset email at this time.' }); }
    return res.json(generic);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error.' }); }
});

router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, email, password } = req.body;
    if (!token || !email || !password || password.length < 8) return res.status(400).json({ error: 'Valid token, email, and a password of at least 8 characters are required.' });
    const ne = email.toLowerCase().trim();
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

router.post('/change-password', authLimiter, async (req, res) => {
  try {
    if (!(req as any).isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || typeof currentPassword !== 'string') return res.status(400).json({ error: 'Current password is required.' });
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
    const userId = (req as any).user?.id;
    const db = getDb();
    const user: any = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !user.password_hash) return res.status(400).json({ error: 'Unable to update password for this account.' });
    let isValid = false;
    if (user.hash_algorithm === 'argon2id') isValid = await argon2.verify(user.password_hash, currentPassword);
    else if (user.hash_algorithm === 'bcrypt') isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) return res.status(401).json({ error: 'Current password is incorrect.' });
    const newHash = await argon2.hash(newPassword, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    getStmts().updatePassword.run(newHash, user.id);
    invalidateUserSessions(user.id, (req as any).sessionID);
    return res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/logout', (req, res, next) => { (req as any).logout((err: any) => { if (err) return next(err); (req as any).session.destroy((de: any) => { if (de) return res.status(500).json({ error: 'Failed to destroy session.' }); res.clearCookie('connect.sid'); return res.json({ message: 'Logged out successfully.' }); }); }); });

export default router;
export { passport };
