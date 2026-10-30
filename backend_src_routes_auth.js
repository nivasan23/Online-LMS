const router = require('express').Router(); const bcrypt = require('bcryptjs'); const crypto = require('crypto');
const { z } = require('zod'); const rl = require('express-rate-limit');
const { q } = require('../db'); const { sign, authenticate, validate, wrap, audit } = require('../middleware/auth'); const { enqueue } = require('../jobs/queue');
const strict = rl({ windowMs: 15 * 60000, limit: 20 });
const reg = z.object({ name: z.string().min(2).max(100), email: z.string().email(), password: z.string().min(8).max(100), role: z.enum(['STUDENT', 'TEACHER']), department: z.string().max(100).optional() });
router.post('/register', strict, validate(reg), wrap(async (req, res) => {
  const b = req.body, hash = await bcrypt.hash(b.password, 12), tok = crypto.randomBytes(24).toString('hex');
  try {
    const { rows } = await q('INSERT INTO users(name,email,password_hash,role,department,verify_token) VALUES($1,lower($2),$3,$4,$5,$6) RETURNING id', [b.name, b.email, hash, b.role, b.department, tok]);
    await enqueue('email', { to: b.email, subject: 'Verify your email', body: `Token: ${tok}` });
    res.status(201).json({ id: rows[0].id, message: 'Check your email to verify your account' });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' }); throw e; }
}));
router.post('/verify-email', strict, wrap(async (req, res) => {
  const r = await q('UPDATE users SET email_verified=true, verify_token=NULL WHERE verify_token=$1 RETURNING id', [req.body.token || '']);
  r.rowCount ? res.json({ ok: true }) : res.status(400).json({ error: 'Invalid token' });
}));
router.post('/login', strict, validate(z.object({ email: z.string().email(), password: z.string().min(1) })), wrap(async (req, res) => {
  const u = (await q('SELECT * FROM users WHERE email=lower($1)', [req.body.email])).rows[0];
  if (!u || !(await bcrypt.compare(req.body.password, u.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect' });
  if (!u.active) return res.status(403).json({ error: 'Account deactivated' });
  audit(u.id, 'login');
  res.json({ token: sign(u), user: { id: u.id, name: u.name, email: u.email, role: u.role } });
}));
router.post('/forgot', strict, wrap(async (req, res) => {
  const tok = crypto.randomBytes(24).toString('hex');
  const r = await q("UPDATE users SET reset_token=$1, reset_expires=now()+interval '1 hour' WHERE email=lower($2) RETURNING email", [tok, req.body.email || '']);
  if (r.rowCount) await enqueue('email', { to: r.rows[0].email, subject: 'Reset password', body: `Token: ${tok}` });
  res.json({ message: 'If that email exists, a reset link was sent' }); // same answer either way
}));
router.post('/reset', strict, validate(z.object({ token: z.string(), password: z.string().min(8) })), wrap(async (req, res) => {
  const r = await q('UPDATE users SET password_hash=$1, reset_token=NULL WHERE reset_token=$2 AND reset_expires>now() RETURNING id', [await bcrypt.hash(req.body.password, 12), req.body.token]);
  r.rowCount ? res.json({ ok: true }) : res.status(400).json({ error: 'Invalid or expired token' });
}));
router.get('/me', authenticate, (req, res) => res.json(req.user));
module.exports = router;
