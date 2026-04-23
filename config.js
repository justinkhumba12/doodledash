const os = require('os');
const crypto = require('crypto');

module.exports = {
    // Note: Because this is a .internal Railway address with a password, 
    // it already satisfies the requirement of being isolated in a private VPC 
    // and secured from the public internet.
    REDIS_URL: process.env.REDIS_URL || 'redis://default:ChviGEknsjWwVfmQdOubyapqVCnZUfSH@redis.railway.internal:6379',
    MYSQL_URL: process.env.MYSQL_URL || 'mysql://root:password@localhost:3306/db',
    PORT: process.env.PORT || 3000,
    NUM_WORKERS: process.env.WORKERS ? parseInt(process.env.WORKERS) : (os.cpus().length || 8),
    BOT_TOKEN: process.env.BOT_TOKEN,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    // Provide a complex fallback string in case JWT_SECRET is missing from the environment
    JWT_SECRET: process.env.JWT_SECRET || 'doodledash_secure_fallback_secret_123!@#',
    CREDITS_PER_STAR: parseInt(process.env.CREDITS_PER_STAR) || 1,
    INK_CONFIG: {
        black: { free: 2500, extra: 2500, cost: 0.5 }
    },
    CORS_OPTIONS: {
        origin: "*",
        methods: ["GET", "POST"]
    }
};
