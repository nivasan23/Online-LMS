const router = require('express').Router(); const { z } = require('zod');
const { q, pool } = require('../db'); const { authenticate, requireRole, validate, wrap, audit } = require('../middleware/auth');
const { enqueue } = require('../jobs/queue'); const storage = require('../utils/storage');
const S = requireRole('STUDENT'), T = requireRole('TEACHER', 'ADMIN');
router.use(authenticate);
const isAdm = (req) => req.user.role === 'ADMIN';

/* uploads: validate type and size, return a short-lived signed URL; the client uploads straight to object storage */
router.post('/uploads/sign', T, validate(z.object({ filename: z.string().max(200), contentType: z.string(), size: z.number().int().positive() })), wrap(async (req, res) => {
  const { filename, contentType, size } = req.body, max = storage.ALLOWED[contentType];
  if (!max) return res.status(400).json({ error: 'File type not allowed' });
  if (size > max) return res.status(400).json({ error: 'File too large' });
  const key = `${req.user.id}/${Date.now()}-${filename.replace(/[^\w.\-]/g, '_')}`;
  res.json({ key, uploadUrl: await storage.uploadUrl(key, contentType) });
}));
router.get('/files', wrap(async (req, res) => { // only lesson/submission files the user may access; use CDN signed URLs for video
  const key = String(req.query.key || '');
  const ok = isAdm(req) || key.startsWith(req.user.id + '/') || (await q('SELECT 1 FROM lessons l JOIN modules m ON m.id=l.module_id JOIN enrollments e ON e.course_id=m.course_id AND e.user_id=$2 WHERE l.file_key=$1', [key, req.user.id])).rowCount;
  ok ? res.json({ url: await storage.downloadUrl(key) }) : res.status(403).json({ error: 'No access to this file' });
}));

/* progress: resume position, auto-complete at 90% */
router.put('/progress/lessons/:id', S, validate(z.object({ position: z.number().min(0), duration: z.number().min(1) })), wrap(async (req, res) => {
  const { position, duration } = req.body, done = position / duration >= 0.9;
  const ok = await q('SELECT 1 FROM lessons l JOIN modules m ON m.id=l.module_id JOIN enrollments e ON e.course_id=m.course_id AND e.user_id=$2 WHERE l.id=$1', [req.params.id, req.user.id]);
  if (!ok.rowCount) return res.status(403).json({ error: 'Not enrolled' });
  const { rows } = await q(`INSERT INTO progress(user_id,lesson_id,position_sec,completed,completed_at) VALUES($1,$2,$3,$4,CASE WHEN $4 THEN now() END)
    ON CONFLICT (user_id,lesson_id) DO UPDATE SET position_sec=$3, completed=progress.completed OR $4, completed_at=COALESCE(progress.completed_at, CASE WHEN $4 THEN now() END) RETURNING completed`, [req.user.id, req.params.id, position, done]);
  if (rows[0].completed) await maybeCertify(req.user.id, req.params.id);
  res.json({ completed: rows[0].completed });
}));
async function maybeCertify(uid, lessonId) {
  const c = (await q('SELECT m.course_id FROM lessons l JOIN modules m ON m.id=l.module_id WHERE l.id=$1', [lessonId])).rows[0]; if (!c) return;
  const r = (await q('SELECT COUNT(l.id) total, COUNT(p.id) FILTER (WHERE p.completed) done FROM modules m JOIN lessons l ON l.module_id=m.id LEFT JOIN progress p ON p.lesson_id=l.id AND p.user_id=$1 WHERE m.course_id=$2', [uid, c.course_id])).rows[0];
  if (+r.total > 0 && r.total === r.done) await enqueue('certificate', { userId: uid, courseId: c.course_id }); // generated asynchronously
}
router.get('/progress/courses/:id', S, wrap(async (req, res) => res.json((await q('SELECT l.id lesson_id,l.title,m.title module,COALESCE(p.completed,false) completed,COALESCE(p.position_sec,0) position FROM modules m JOIN lessons l ON l.module_id=m.id LEFT JOIN progress p ON p.lesson_id=l.id AND p.user_id=$1 WHERE m.course_id=$2 ORDER BY m.position,l.position', [req.user.id, req.params.id])).rows)));
router.get('/courses/:id/students', T, wrap(async (req, res) => res.json((await q(`SELECT u.id,u.name,ROUND(100.0*COUNT(p.id) FILTER (WHERE p.completed)/NULLIF(COUNT(l.id),0),0) progress_pct
  FROM courses c JOIN enrollments e ON e.course_id=c.id JOIN users u ON u.id=e.user_id JOIN modules m ON m.course_id=c.id JOIN lessons l ON l.module_id=m.id LEFT JOIN progress p ON p.lesson_id=l.id AND p.user_id=u.id
  WHERE c.id=$1 AND (c.teacher_id=$2 OR $3) GROUP BY u.id`, [req.params.id, req.user.id, isAdm(req)])).rows)));

/* assignments */
router.post('/assignments', T, validate(z.object({ course_id: z.number().int(), title: z.string().min(2), instructions: z.string(), due_at: z.string().datetime(), max_points: z.number().default(100) })), wrap(async (req, res) => {
  const b = req.body, own = await q('SELECT 1 FROM courses WHERE id=$1 AND (teacher_id=$2 OR $3)', [b.course_id, req.user.id, isAdm(req)]);
  if (!own.rowCount) return res.status(403).json({ error: 'Not your course' });
  const a = (await q('INSERT INTO assignments(course_id,title,instructions,due_at,max_points) VALUES($1,$2,$3,$4,$5) RETURNING *', [b.course_id, b.title, b.instructions, b.due_at, b.max_points])).rows[0];
  await q('INSERT INTO notifications(user_id,message) SELECT user_id,$2 FROM enrollments WHERE course_id=$1', [b.course_id, 'New assignment: ' + b.title]); res.status(201).json(a);
}));
router.post('/assignments/:id/submit', S, validate(z.object({ text: z.string().max(10000).optional(), file_key: z.string().optional() })), wrap(async (req, res) => {
  const a = (await q('SELECT a.* FROM assignments a JOIN enrollments e ON e.course_id=a.course_id AND e.user_id=$2 WHERE a.id=$1', [req.params.id, req.user.id])).rows[0];
  if (!a) return res.status(404).json({ error: 'Assignment not found' });
  const late = new Date() > new Date(a.due_at);
  const r = await q('INSERT INTO submissions(assignment_id,user_id,text,file_key,late) VALUES($1,$2,$3,$4,$5) ON CONFLICT (assignment_id,user_id) DO UPDATE SET text=$3,file_key=$4,late=$5,submitted_at=now() WHERE submissions.grade IS NULL RETURNING *', [a.id, req.user.id, req.body.text, req.body.file_key, late]);
  r.rowCount ? res.json(r.rows[0]) : res.status(409).json({ error: 'Already graded' });
}));
router.get('/assignments/:id/submissions', T, wrap(async (req, res) => res.json((await q('SELECT s.*,u.name FROM submissions s JOIN users u ON u.id=s.user_id JOIN assignments a ON a.id=s.assignment_id JOIN courses c ON c.id=a.course_id WHERE s.assignment_id=$1 AND (c.teacher_id=$2 OR $3)', [req.params.id, req.user.id, isAdm(req)])).rows)));
router.patch('/submissions/:id/grade', T, validate(z.object({ grade: z.number().min(0).max(1000), feedback: z.string().max(2000).optional() })), wrap(async (req, res) => {
  const r = await q('UPDATE submissions s SET grade=$1,feedback=$2,graded_at=now() FROM assignments a JOIN courses c ON c.id=a.course_id WHERE s.id=$3 AND a.id=s.assignment_id AND (c.teacher_id=$4 OR $5) RETURNING s.user_id', [req.body.grade, req.body.feedback, req.params.id, req.user.id, isAdm(req)]);
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  await q('INSERT INTO notifications(user_id,message) VALUES($1,$2)', [r.rows[0].user_id, `Assignment graded: ${req.body.grade}`]); audit(req.user.id, 'grade', req.params.id); res.json({ ok: true });
}));

/* quizzes: graded on the server; correct answers are never sent to the browser */
router.post('/quizzes', T, validate(z.object({ course_id: z.number().int(), title: z.string(), time_limit_min: z.number().int().default(10), max_attempts: z.number().int().default(2), pass_pct: z.number().default(60), randomize: z.boolean().default(true) })), wrap(async (req, res) => {
  const b = req.body, own = await q('SELECT 1 FROM courses WHERE id=$1 AND (teacher_id=$2 OR $3)', [b.course_id, req.user.id, isAdm(req)]);
  if (!own.rowCount) return res.status(403).json({ error: 'Not your course' });
  res.status(201).json((await q('INSERT INTO quizzes(course_id,title,time_limit_min,max_attempts,pass_pct,randomize) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [b.course_id, b.title, b.time_limit_min, b.max_attempts, b.pass_pct, b.randomize])).rows[0]);
}));
router.post('/quizzes/:id/questions', T, validate(z.object({ type: z.enum(['mcq', 'tf', 'short']), prompt: z.string(), options: z.array(z.string()).optional(), answer: z.string(), topic: z.string().default('General') })), wrap(async (req, res) => {
  const b = req.body, own = await q('SELECT 1 FROM quizzes z JOIN courses c ON c.id=z.course_id WHERE z.id=$1 AND (c.teacher_id=$2 OR $3)', [req.params.id, req.user.id, isAdm(req)]);
  if (!own.rowCount) return res.status(403).json({ error: 'Not your quiz' });
  res.status(201).json((await q('INSERT INTO questions(quiz_id,type,prompt,options,answer,topic) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [req.params.id, b.type, b.prompt, JSON.stringify(b.options || []), b.answer, b.topic])).rows[0]);
}));
router.get('/quizzes/:id', S, wrap(async (req, res) => {
  const quiz = (await q('SELECT z.id,z.title,z.time_limit_min,z.max_attempts,z.pass_pct,z.randomize FROM quizzes z JOIN enrollments e ON e.course_id=z.course_id AND e.user_id=$2 WHERE z.id=$1', [req.params.id, req.user.id])).rows[0];
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  quiz.questions = (await q(`SELECT id,type,prompt,options FROM questions WHERE quiz_id=$1 ORDER BY ${quiz.randomize ? 'random()' : 'id'}`, [quiz.id])).rows; res.json(quiz);
}));
router.post('/quizzes/:id/attempts', S, validate(z.object({ answers: z.record(z.string()) })), wrap(async (req, res) => {
  const quiz = (await q('SELECT z.* FROM quizzes z JOIN enrollments e ON e.course_id=z.course_id AND e.user_id=$2 WHERE z.id=$1', [req.params.id, req.user.id])).rows[0]; if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  const used = +(await q('SELECT COUNT(*) FROM quiz_attempts WHERE quiz_id=$1 AND user_id=$2', [quiz.id, req.user.id])).rows[0].count;
  if (used >= quiz.max_attempts) return res.status(403).json({ error: 'No attempts left' });
  const qs = (await q('SELECT id,answer,topic FROM questions WHERE quiz_id=$1', [quiz.id])).rows, topics = {}; let ok = 0;
  for (const x of qs) { const right = (req.body.answers[x.id] || '').trim().toLowerCase() === x.answer.trim().toLowerCase(); topics[x.topic] = topics[x.topic] || { correct: 0, total: 0 }; topics[x.topic].total++; if (right) { ok++; topics[x.topic].correct++; } }
  const pct = qs.length ? Math.round(ok / qs.length * 100) : 0, passed = pct >= quiz.pass_pct;
  await q('INSERT INTO quiz_attempts(quiz_id,user_id,score,total,percentage,passed,topics) VALUES($1,$2,$3,$4,$5,$6,$7)', [quiz.id, req.user.id, ok, qs.length, pct, passed, JSON.stringify(topics)]);
  await q('INSERT INTO notifications(user_id,message) VALUES($1,$2)', [req.user.id, `Quiz result: ${pct}% (${passed ? 'passed' : 'failed'})`]);
  res.json({ score: ok, total: qs.length, percentage: pct, correct: ok, incorrect: qs.length - ok, status: passed ? 'PASSED' : 'FAILED', topics });
}));

/* attendance */
router.post('/attendance', T, validate(z.object({ course_id: z.number().int(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), records: z.array(z.object({ user_id: z.number().int(), status: z.enum(['P', 'A', 'L']) })) })), wrap(async (req, res) => {
  const own = await q('SELECT 1 FROM courses WHERE id=$1 AND (teacher_id=$2 OR $3)', [req.body.course_id, req.user.id, isAdm(req)]);
  if (!own.rowCount) return res.status(403).json({ error: 'Not your course' });
  const c = await pool.connect();
  try { await c.query('BEGIN');
    for (const r of req.body.records) await c.query('INSERT INTO attendance(course_id,class_date,user_id,status) VALUES($1,$2,$3,$4) ON CONFLICT (course_id,class_date,user_id) DO UPDATE SET status=$4', [req.body.course_id, req.body.date, r.user_id, r.status]);
    await c.query('COMMIT'); res.json({ ok: true });
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}));
router.get('/attendance/me', S, wrap(async (req, res) => res.json((await q("SELECT COUNT(*) total,COUNT(*) FILTER (WHERE status='P') present,COUNT(*) FILTER (WHERE status='A') absent,COUNT(*) FILTER (WHERE status='L') late,ROUND(100.0*COUNT(*) FILTER (WHERE status<>'A')/NULLIF(COUNT(*),0),1) percentage FROM attendance WHERE user_id=$1", [req.user.id])).rows[0])));

/* notifications, announcements, messages, certificates */
router.get('/notifications', wrap(async (req, res) => res.json({ unread: +(await q('SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND NOT read', [req.user.id])).rows[0].count, items: (await q('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id])).rows })));
router.post('/notifications/read', wrap(async (req, res) => { await q('UPDATE notifications SET read=true WHERE user_id=$1', [req.user.id]); res.json({ ok: true }); }));
router.post('/announcements', T, validate(z.object({ course_id: z.number().int().optional(), title: z.string(), body: z.string() })), wrap(async (req, res) => {
  const b = req.body;
  if (b.course_id && !(await q('SELECT 1 FROM courses WHERE id=$1 AND (teacher_id=$2 OR $3)', [b.course_id, req.user.id, isAdm(req)])).rowCount) return res.status(403).json({ error: 'Not your course' });
  const a = (await q('INSERT INTO announcements(course_id,author_id,title,body) VALUES($1,$2,$3,$4) RETURNING *', [b.course_id, req.user.id, b.title, b.body])).rows[0];
  await q("INSERT INTO notifications(user_id,message) SELECT id,$1 FROM users WHERE role='STUDENT' AND ($2::int IS NULL OR id IN (SELECT user_id FROM enrollments WHERE course_id=$2))", ['Announcement: ' + b.title, b.course_id || null]); res.status(201).json(a);
}));
router.post('/messages', validate(z.object({ to: z.number().int(), body: z.string().min(1).max(2000), course_id: z.number().int().optional() })), wrap(async (req, res) => res.status(201).json((await q('INSERT INTO messages(sender_id,recipient_id,course_id,body) VALUES($1,$2,$3,$4) RETURNING *', [req.user.id, req.body.to, req.body.course_id, req.body.body])).rows[0])));
router.get('/messages', wrap(async (req, res) => res.json((await q('SELECT * FROM messages WHERE sender_id=$1 OR recipient_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id])).rows)));
router.get('/certificates/me', S, wrap(async (req, res) => res.json((await q('SELECT ce.code,ce.issued_at,c.title course FROM certificates ce JOIN courses c ON c.id=ce.course_id WHERE ce.user_id=$1', [req.user.id])).rows)));
module.exports = router;
