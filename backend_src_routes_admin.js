const router = require('express').Router(); const bcrypt = require('bcryptjs'); const { z } = require('zod');
const { q } = require('../db'); const { cached } = require('../redis'); const { authenticate, requireRole, validate, wrap, audit } = require('../middleware/auth');
router.use(authenticate, requireRole('ADMIN'));
router.get('/stats', wrap(async (req, res) => res.json(await cached('admin:stats', 30, async () => (await q(`SELECT
 (SELECT COUNT(*) FROM users WHERE role='STUDENT') students,(SELECT COUNT(*) FROM users WHERE role='TEACHER') teachers,
 (SELECT COUNT(*) FROM courses) courses,(SELECT COUNT(*) FROM courses WHERE published) active_courses,
 (SELECT COUNT(*) FROM assignments) assignments,(SELECT COUNT(*) FROM quizzes) quizzes,
 (SELECT ROUND(AVG(percentage)::numeric,1) FROM quiz_attempts) avg_quiz,(SELECT COUNT(*) FROM certificates) certificates`)).rows[0]))));
router.get('/users', wrap(async (req, res) => res.json((await q('SELECT id,name,email,role,active,department,created_at FROM users ORDER BY id LIMIT 200 OFFSET $1', [(Math.max(+req.query.page || 1, 1) - 1) * 200])).rows)));
router.post('/users', validate(z.object({ name: z.string(), email: z.string().email(), password: z.string().min(8), role: z.enum(['ADMIN', 'TEACHER', 'STUDENT']) })), wrap(async (req, res) => {
  const b = req.body, r = await q('INSERT INTO users(name,email,password_hash,role,email_verified) VALUES($1,lower($2),$3,$4,true) RETURNING id,name,email,role', [b.name, b.email, await bcrypt.hash(b.password, 12), b.role]);
  audit(req.user.id, 'user.create', b.email); res.status(201).json(r.rows[0]);
}));
router.patch('/users/:id/active', wrap(async (req, res) => {
  if (+req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot deactivate yourself' });
  const r = await q('UPDATE users SET active=$1 WHERE id=$2 RETURNING id,active', [!!req.body.active, req.params.id]); audit(req.user.id, 'user.active', req.params.id); res.json(r.rows[0]);
}));
router.get('/logs', wrap(async (req, res) => res.json((await q('SELECT l.*,u.name FROM activity_logs l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC LIMIT 200')).rows)));
router.get('/reports/student-performance.csv', wrap(async (req, res) => {
  const rows = (await q(`SELECT u.name,u.department,COUNT(DISTINCT e.course_id) courses,COALESCE(ROUND(AVG(qa.percentage)::numeric,1),0) avg_quiz,COALESCE(ROUND(AVG(s.grade)::numeric,1),0) avg_grade FROM users u LEFT JOIN enrollments e ON e.user_id=u.id LEFT JOIN quiz_attempts qa ON qa.user_id=u.id LEFT JOIN submissions s ON s.user_id=u.id WHERE u.role='STUDENT' GROUP BY u.id`)).rows;
  const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"'; // CSV-injection safe
  res.type('text/csv').send(['name,department,courses,avg_quiz,avg_grade', ...rows.map((r) => Object.values(r).map(cell).join(','))].join('\n'));
}));
module.exports = router;
