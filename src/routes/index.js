const fs = require('fs');
const path = require('path');
const BroadcastService = require('../services/BroadcastService');

async function routes(fastify, opts) {
    const {playService} = opts;

    fastify.get('/', async () => {
        return {
            name: 'sonor-api',
            ready: true,
            timestamp: Date.now()
        };
    });

    const apiDir = path.join(__dirname, 'api');
    const files = fs.readdirSync(apiDir);
    for (const file of files) {
        if (!file.endsWith('.js')) continue;
        console.log('loading api route:', file);
        const routeModule = require(path.join(apiDir, file));
        routeModule(fastify, opts);
    }

    playService.onStateUpdated((data) => {
        BroadcastService.broadcast({
            type: 'player_status',
            data
        });
    });

    playService.onTimeUpdated((data) => {
        BroadcastService.broadcast({
            type: 'player_time',
            data
        });
    });

    fastify.get('/ws', { websocket: true }, (socket) => {
        BroadcastService.addClient(socket);

        // 新客户端连上，立刻下发一次播放器状态
        socket.send(JSON.stringify({
            type: 'player_status',
            data: playService.getStatus()
        }));

        socket.on('close', () => {
            BroadcastService.removeClient(socket);
        });

        socket.on('error', (err) => {
            console.warn('ws client error', err.message);
            BroadcastService.removeClient(socket);
        });
    });
}

module.exports = routes;
