const jwt = require('jsonwebtoken');
const { ZodError } = require('zod');
const { q } = require('../db');
// Stateless JWT: any app server behind the load balancer can verify it.
exports.sign = (u) => jwt.sign({ sub: u.id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '8h' });
exports.authenticate = async (req, res, next) => {
  try {
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    const p = jwt.verify(t, process.env.JWT_SECRET);
    const { rows } = await q('SELECT id,name,email,role,active FROM users WHERE id=$1', [p.sub]);
    if (!rows[0] || !rows[0].active) return res.status(401).json({ error: 'Account unavailable' });
    req.user = rows[0]; next();
  } catch { res.status(401).json({ error: 'Please log in' }); }
};
exports.requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not allowed for your role' });
exports.validate = (schema) => (req, res, next) => {
  try { req.body = schema.parse(req.body); next(); }
  catch (e) { res.status(400).json({ error: 'Invalid input', details: e instanceof ZodError ? e.issues : undefined }); }
};
exports.wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
exports.audit = (uid, action, detail) => q('INSERT INTO activity_logs(user_id,action,detail) VALUES($1,$2,$3)', [uid, action, detail ? String(detail) : null]).catch(() => {});
