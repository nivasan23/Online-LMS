require('dotenv').config();
const Redis = require('ioredis'); const { q } = require('../db');
const handlers = {
  email: async ({ to, subject, body }) => console.log(`[email] to=${to} subject=${subject}\n${body}`), // plug in SES/SendGrid here
  certificate: async ({ userId, courseId }) => {
    const code = 'EDU-' + new Date().getFullYear() + '-' + String(Date.now()).slice(-6);
    const r = await q('INSERT INTO certificates(code,user_id,course_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING code', [code, userId, courseId]);
    if (r.rows[0]) await q('INSERT INTO notifications(user_id,message) VALUES($1,$2)', [userId, 'Certificate generated: ' + code]);
  },
  report: async (d) => console.log('[report] generating', d),
};
(async function loop() {
  const r = new Redis(process.env.REDIS_URL);
  for (;;) {
    const item = await r.brpop('jobs', 5); if (!item) continue;
    try { const j = JSON.parse(item[1]); await handlers[j.type](j.data); } catch (e) { console.error('job failed', e); }
  }
})();
