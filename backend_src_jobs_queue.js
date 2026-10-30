const { redis } = require('../redis');
// Minimal Redis-list queue. Swap for BullMQ or SQS in production.
exports.enqueue = (type, data) => redis.lpush('jobs', JSON.stringify({ type, data })).catch(() => {});
