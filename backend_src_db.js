const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20, idleTimeoutMillis: 30000 });
// Read replicas: create a second Pool from READ_DATABASE_URL and use it for report/list queries.
module.exports = { pool, q: (text, params) => pool.query(text, params) };
