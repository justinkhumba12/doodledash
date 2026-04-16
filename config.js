const os = require('os');

module.exports = {
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    MYSQL_URL: process.env.MYSQL_URL || 'mysql://root:password@localhost:3306/db',
    PORT: process.env.PORT || 3000,
    NUM_WORKERS: process.env.WORKERS ? parseInt(process.env.WORKERS) : (os.cpus().length || 8),
    BOT_TOKEN: process.env.BOT_TOKEN,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    CREDITS_PER_STAR: parseInt(process.env.CREDITS_PER_STAR) || 1,
    INK_CONFIG: {
        black: { free: 2500, extra: 2500, cost: 0.5 }
    },
    CORS_OPTIONS: {
        origin: "*",
        methods: ["GET", "POST"]
    }
};
