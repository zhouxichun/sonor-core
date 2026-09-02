const fs = require('fs');
const path = require('path');
const Broadcast = require('../services/BroadcastService');

async function routes(fastify, opts) {
    fastify.get('/', async () => {
        return {
            name: 'sonor‑api',
            ready: true,
            timestamp: Date.now()
        };
    });

    const apiDir = path.join(__dirname, 'api');
    const files = fs.readdirSync(apiDir);
    for (const file of files) {
        if (!file.endsWith('.js')) continue;
        console.log('loading api route:', file);
        // ❗ 关键：不再 fastify.register()，直接执行路由函数，不生成子实例
        const routeModule = require(path.join(apiDir, file));
        // 直接调用函数，fastify是当前实例A（prefix=/api），不会新建子实例
        routeModule(fastify, opts);
    }

    fastify.get('/ws', { websocket: true }, (connection) => {
        // your ws code
    });
}

module.exports = routes;
