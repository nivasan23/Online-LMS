require('dotenv').config();
const express = require('express'), helmet = require('helmet'), cors = require('cors'), rl = require('express-rate-limit');
const { q } = require('./db'); const { redis } = require('./redis');
const app = express();
app.set('trust proxy', 1); // behind the load balancer
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: (process.env.CORS_ORIGIN || '').split(',').filter(Boolean) }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', rl({ windowMs: 60000, limit: 300, standardHeaders: true }));
app.use((req, res, next) => { res.setHeader('X-Served-By', process.env.INSTANCE_ID || 'app'); console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, u: req.originalUrl, by: process.env.INSTANCE_ID })); next(); });
// Load-balancer health check: 200 only if dependencies are reachable, so a sick node is taken out of rotation.
app.get('/health', async (req, res) => {
  const s = { instance: process.env.INSTANCE_ID, db: 'down', redis: 'down' };
  try { await q('SELECT 1'); s.db = 'ok'; } catch {} try { await redis.ping(); s.redis = 'ok'; } catch {}
  res.status(s.db === 'ok' && s.redis === 'ok' ? 200 : 503).json(s);
});
app.get('/api/certificates/verify/:code', async (req, res) => { // public verification
  const r = await q('SELECT ce.code,ce.issued_at,u.name student,c.title course FROM certificates ce JOIN users u ON u.id=ce.user_id JOIN courses c ON c.id=ce.course_id WHERE ce.code=$1', [req.params.code]);
  r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'Certificate not found' });
});
app.use('/api/auth', require('./routes/auth'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', require('./routes/learning'));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }); // no stack traces to clients
app.listen(process.env.PORT || 4000, () => console.log('EduLearn API on', process.env.PORT || 4000));
