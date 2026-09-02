const fastify = require('fastify')({ logger: true });
const AudioLibraryService = require('./services/AudioLibraryService');
const PlayService = require('./services/PlayService');

const fsSync = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '../data');
if (!fsSync.existsSync(dataPath)) {
  fsSync.mkdirSync(dataPath, { recursive: true });
}

const audioLibraryService = new AudioLibraryService({
  dataPath: dataPath
});
const playService = new PlayService({
  dataPath: dataPath
});

async function registerPlugins() {
  await fastify.register(require('@fastify/cors'), {
    origin: true,
    credentials: true
  });
  await fastify.register(require('@fastify/websocket'));

  // 统一api响应包装，直接挂载根实例
  fastify.addHook('onSend', async (request, reply, payload) => {
    if (!request.url.startsWith('/api/')) {
      return payload;
    }
    try {
      const data = JSON.parse(payload);
      if (!Object.prototype.hasOwnProperty.call(data, 'code')) {
        return JSON.stringify({ code: 0, msg: 'success', data });
      }
    } catch {
      // 非JSON payload直接透传
    }
    return payload;
  });
}

async function registerRoutes() {
  // 将service实例通过register opts注入路由层
  await fastify.register(require('./routes/index'), {
    prefix: '/api',
    audioLibraryService,
    playService
  });
}

async function createApp() {
  await registerPlugins();
  await registerRoutes();

  fastify.addHook('onReady', async () => {
    // 移除setTimeout，路由就绪后直接启动服务
    await audioLibraryService.start();
    await playService.start();
    fastify.log.info('All Service started');
  });

  fastify.addHook('onClose', async () => {
    // await等待异步销毁完成
    await audioLibraryService.destroy();
    await playService.destroy();
    fastify.log.info('All services destroyed');
  });

  return fastify;
}

// 捕获终止信号，主动触发 close，才会执行 onClose
process.on('SIGINT', async () => {
  fastify.log.info('Received SIGINT, shutting down...');
  await fastify.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  fastify.log.info('Received SIGTERM, shutting down...');
  await fastify.close();
  process.exit(0);
});

module.exports = {
  createApp,
  services: {
    audioLibraryService,
    playService
  }
};
