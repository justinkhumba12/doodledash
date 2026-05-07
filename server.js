const cluster = require('cluster');
const Redis = require('ioredis');
const config = require('./config');
const { initializeDatabase } = require('./database');

if (cluster.isPrimary) {
    console.log(`[Primary] Process ID: ${process.pid}`);
    console.log(`[Primary] Preparing to fork ${config.NUM_WORKERS} workers...`);

    const setupPrimary = async () => {
        // Trigger centralized schema initialization via database connection pool
        await initializeDatabase();

        let redis;
        try {
            console.log('[Primary] Connecting to Redis for initial setup...');
            redis = new Redis(config.REDIS_URL);
            
            const nextId = await redis.get('next_room_id');
            if (!nextId) await redis.set('next_room_id', 1); 

            console.log('[Primary] Redis room setup complete.');
        } catch (err) {
            console.error('[Primary] Redis Init Error:', err);
        } finally {
            if (redis) await redis.quit();
        }

        for (let i = 0; i < config.NUM_WORKERS; i++) {
            cluster.fork();
        }

        cluster.on('exit', (worker, code, signal) => {
            console.log(`[Primary] Worker ${worker.process.pid} died. Restarting...`);
            cluster.fork();
        });
    };

    setupPrimary();
} else {
    require('./worker');
}