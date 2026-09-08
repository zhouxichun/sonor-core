const fs = require('fs');
const path = require('path');
const BroadcastService = require('../services/BroadcastService');
const logger = require('../utils/logger')(__dirname);
async function routes(fastify, opts) {
    // 不再从opts获取playService，直接使用fastify装饰实例
    fastify.get('/', async () => {
        return {
            name: 'sonor-api',
            timestamp: Date.now()
        };
    });
    const apiDir = path.join(__dirname, 'api');
    const files = fs.readdirSync(apiDir);
    for (const file of files) {
        if (!file.endsWith('.js')) continue;
        const routeModule = require(path.join(apiDir, file));
        // 子路由模块如果也用到playService，子模块内部同样用 fastify.playService
        routeModule(fastify, opts);
    }
    logger.info('all api routes loaded complete');
    fastify.playService.onStateUpdated((data) => {
        BroadcastService.broadcast({
            type: 'player_status',
            data
        });
    });
    fastify.playService.onTimeUpdated((data) => {
        BroadcastService.broadcast({
            type: 'player_time',
            data
        });
    });
    fastify.playService.onCurrentTrack((data) => {
        BroadcastService.broadcast({
            type: 'current_track',
            data
        });
    });
    fastify.get('/ws', { websocket: true }, (socket) => {
        logger.info('websocket client connected');
        BroadcastService.addClient(socket);
        // 同步加入fastify.wsClients集合，用于优雅关闭时批量断开
        fastify.wsClients.add(socket);
        // 新客户端连上，立刻下发播放器状态
        socket.send(JSON.stringify({
            type: 'player_status',
            data: fastify.playService.getStatus()
        }));
         socket.send(JSON.stringify({
            type: 'current_track',
            data: fastify.playService.getCurrentTrack()
        }));
        socket.on('close', () => {
            logger.info('websocket client closed');
            BroadcastService.removeClient(socket);
            fastify.wsClients.delete(socket);
        });
        socket.on('error', (err) => {
            logger.warn(`ws client error: ${err.message}`);
            BroadcastService.removeClient(socket);
            fastify.wsClients.delete(socket);
        });
    });
}
module.exports = routes;