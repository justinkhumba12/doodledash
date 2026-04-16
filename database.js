const mysql = require('mysql2/promise');
const Redis = require('ioredis');
const config = require('./config');

const redis = new Redis(config.REDIS_URL);
const pubClient = redis.duplicate();
const subClient = redis.duplicate();

redis.on('error', (err) => console.error(`[Redis Error]:`, err));

const db = mysql.createPool({ 
    uri: config.MYSQL_URL, 
    timezone: 'Z', 
    waitForConnections: true, 
    connectionLimit: 5,
    connectTimeout: 10000 // Prevent infinite hanging if DB connects slowly
});

module.exports = { db, redis, pubClient, subClient };
