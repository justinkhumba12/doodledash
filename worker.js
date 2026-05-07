const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const { createAdapter } = require('@socket.io/redis-adapter');

const config = require('./config');
const { pubClient, subClient, db, initializeDatabase } = require('./database');

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
app.disable('x-powered-by');

const io = new Server(server, {
    cors: config.CORS_OPTIONS,
    adapter: createAdapter(pubClient, subClient)
});

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    frameguard: false 
}));

app.use(cors(config.CORS_OPTIONS));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect application components
require('./routes')(app, io);
require('./sockets')(io);
require('./gameLoop')(io);
require('./adminBackend').setupAdminPanel(app, io);

// Initialize DB schema directly from the centralized file
initializeDatabase().then(() => {
    server.listen(config.PORT, () => console.log(`[Worker ${process.pid}] Server running on port ${config.PORT}`));
});