const router = require('express').Router(); const { z } = require('zod');
const { q } = require('../db'); const { cached, clear } = require('../redis');
const { authenticate, requireRole, validate, wrap, audit } = require('../middleware/auth');
const T = requireRole('TEACHER', 'ADMIN');
const body = z.object({ title: z.string().min(3).max(200), description: z.string().max(5000), category_id: z.number().int().optional(), level: z.enum(['Beginner', 'Intermediate', 'Advanced']), prerequisites: z.string().max(500).optional(), thumbnail_key: z.string().max(300).optional() });
const own = async (req, id) => req.user.role === 'ADMIN' || (await q('SELECT teacher_id FROM courses WHERE id=$1', [id])).rows[0]?.teacher_id === req.user.id;
router.get('/', wrap(async (req, res) => { // public catalog: search, filter, paginate, cached
  const { search = '', category, level, teacher, sort = 'new', page = 1 } = req.query, off = (Math.max(+page, 1) - 1) * 12;
  const key = 'courses:' + JSON.stringify([search, category, level, teacher, sort, off]);
  res.json(await cached(key, 60, async () => (await q(`
    SELECT c.id,c.title,c.description,c.level,u.name teacher,cat.name category,COALESCE(ROUND(AVG(r.rating),1),0) rating
    FROM courses c JOIN users u ON u.id=c.teacher_id LEFT JOIN categories cat ON cat.id=c.category_id LEFT JOIN reviews r ON r.course_id=c.id
    WHERE c.status='published' AND c.published AND ($1='' OR c.title ILIKE '%'||$1||'%' OR c.description ILIKE '%'||$1||'%')
      AND ($2::int IS NULL OR c.category_id=$2) AND ($3::text IS NULL OR c.level=$3) AND ($4::int IS NULL OR c.teacher_id=$4)
    GROUP BY c.id,u.name,cat.name ORDER BY ${sort === 'rating' ? 'rating DESC' : 'c.created_at DESC'} LIMIT 12 OFFSET $5`,
    [search, category || null, level || null, teacher || null, off])).rows));
}));
router.get('/:id(\\d+)', wrap(async (req, res) => {
  const c = (await q('SELECT c.*,u.name teacher FROM courses c JOIN users u ON u.id=c.teacher_id WHERE c.id=$1', [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'Course not found' });
  c.modules = (await q(`SELECT m.id,m.title,m.position,COALESCE(json_agg(json_build_object('id',l.id,'title',l.title,'type',l.type,'duration',l.duration_sec) ORDER BY l.position) FILTER (WHERE l.id IS NOT NULL),'[]') lessons FROM modules m LEFT JOIN lessons l ON l.module_id=m.id WHERE m.course_id=$1 GROUP BY m.id ORDER BY m.position`, [c.id])).rows;
  res.json(c);
}));
router.post('/', authenticate, T, validate(body), wrap(async (req, res) => {
  const b = req.body, r = await q('INSERT INTO courses(title,description,category_id,level,prerequisites,thumbnail_key,teacher_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [b.title, b.description, b.category_id, b.level, b.prerequisites, b.thumbnail_key, req.user.id, req.user.role === 'ADMIN' ? 'published' : 'pending']);
  audit(req.user.id, 'course.create', b.title); res.status(201).json(r.rows[0]);
}));
router.patch('/:id', authenticate, T, validate(body.partial()), wrap(async (req, res) => {
  if (!(await own(req, req.params.id))) return res.status(403).json({ error: 'Not your course' });
  const b = req.body, r = await q('UPDATE courses SET title=COALESCE($1,title),description=COALESCE($2,description),level=COALESCE($3,level),prerequisites=COALESCE($4,prerequisites) WHERE id=$5 RETURNING *', [b.title, b.description, b.level, b.prerequisites, req.params.id]);
  await clear('courses:'); res.json(r.rows[0]);
}));
router.patch('/:id/publish', authenticate, T, wrap(async (req, res) => {
  if (!(await own(req, req.params.id))) return res.status(403).json({ error: 'Not your course' });
  await clear('courses:'); res.json((await q('UPDATE courses SET published=$1 WHERE id=$2 RETURNING id,published', [!!req.body.published, req.params.id])).rows[0]);
}));
router.patch('/:id/status', authenticate, requireRole('ADMIN'), validate(z.object({ status: z.enum(['published', 'rejected']) })), wrap(async (req, res) => {
  const r = await q("UPDATE courses SET status=$1::text, published=($1::text='published') WHERE id=$2 RETURNING id,title,teacher_id,status", [req.body.status, req.params.id]);
  if (r.rows[0]) await q('INSERT INTO notifications(user_id,message) VALUES($1,$2)', [r.rows[0].teacher_id, `Course "${r.rows[0].title}" was ${req.body.status}`]);
  await clear('courses:'); audit(req.user.id, 'course.' + req.body.status, req.params.id); res.json(r.rows[0]);
}));
router.delete('/:id', authenticate, T, wrap(async (req, res) => {
  if (!(await own(req, req.params.id))) return res.status(403).json({ error: 'Not your course' });
  await q('DELETE FROM courses WHERE id=$1', [req.params.id]); await clear('courses:'); res.status(204).end();
}));
router.post('/:id/modules', authenticate, T, validate(z.object({ title: z.string().min(1).max(200) })), wrap(async (req, res) => {
  if (!(await own(req, req.params.id))) return res.status(403).json({ error: 'Not your course' });
  res.status(201).json((await q('INSERT INTO modules(course_id,title,position) VALUES($1,$2,COALESCE((SELECT MAX(position)+1 FROM modules WHERE course_id=$1),1)) RETURNING *', [req.params.id, req.body.title])).rows[0]);
}));
router.post('/modules/:mid/lessons', authenticate, T, validate(z.object({ title: z.string().min(1).max(200), type: z.enum(['video', 'pdf', 'doc', 'ppt', 'image', 'text', 'link']), file_key: z.string().optional(), url: z.string().url().optional(), content: z.string().max(20000).optional(), duration_sec: z.number().int().min(0).default(0) })), wrap(async (req, res) => {
  const ok = await q('SELECT 1 FROM modules m JOIN courses c ON c.id=m.course_id WHERE m.id=$1 AND (c.teacher_id=$2 OR $3)', [req.params.mid, req.user.id, req.user.role === 'ADMIN']);
  if (!ok.rowCount) return res.status(403).json({ error: 'Not your course' });
  const b = req.body; res.status(201).json((await q('INSERT INTO lessons(module_id,title,type,file_key,url,content,duration_sec,position) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE((SELECT MAX(position)+1 FROM lessons WHERE module_id=$1),1)) RETURNING *', [req.params.mid, b.title, b.type, b.file_key, b.url, b.content, b.duration_sec])).rows[0]);
}));
router.post('/:id/enroll', authenticate, requireRole('STUDENT'), wrap(async (req, res) => {
  const r = await q('INSERT INTO enrollments(user_id,course_id) SELECT $1,id FROM courses WHERE id=$2 AND published ON CONFLICT DO NOTHING RETURNING id', [req.user.id, req.params.id]);
  if (r.rowCount) await q('INSERT INTO notifications(user_id,message) VALUES($1,$2)', [req.user.id, 'You enrolled in a new course']);
  res.status(r.rowCount ? 201 : 200).json({ enrolled: true });
}));
router.post('/:id/reviews', authenticate, requireRole('STUDENT'), validate(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() })), wrap(async (req, res) => {
  const e = await q('SELECT 1 FROM enrollments WHERE user_id=$1 AND course_id=$2', [req.user.id, req.params.id]);
  if (!e.rowCount) return res.status(403).json({ error: 'Enroll before reviewing' });
  await q('INSERT INTO reviews(course_id,user_id,rating,comment) VALUES($1,$2,$3,$4) ON CONFLICT (course_id,user_id) DO UPDATE SET rating=$3,comment=$4', [req.params.id, req.user.id, req.body.rating, req.body.comment]); res.status(201).json({ ok: true });
}));
module.exports = router;
