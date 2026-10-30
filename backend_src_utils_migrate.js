require('dotenv').config(); const fs = require('fs'), path = require('path'); const { pool } = require('../db');
(async () => { const dir = '/database/migrations';
  for (const f of fs.readdirSync(dir).sort()) { console.log('applying', f); await pool.query(fs.readFileSync(path.join(dir, f), 'utf8')); }
  await pool.end(); })();
