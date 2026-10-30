const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
redis.on('error', (e) => console.error('redis', e.message));
// Cache helper. Redis is only a cache, never the source of truth.
async function cached(key, ttl, fn) {
  try { const hit = await redis.get(key); if (hit) return JSON.parse(hit); } catch {}
  const val = await fn();
  try { await redis.set(key, JSON.stringify(val), 'EX', ttl); } catch {}
  return val;
}
async function clear(prefix) { try { const ks = await redis.keys(prefix + '*'); if (ks.length) await redis.del(...ks); } catch {} }
module.exports = { redis, cached, clear };
