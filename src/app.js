const fastify = require('fastify')({ logger: true });
const AudioLibraryService = require('./services/AudioLibraryService');
const PlayService = require('./services/PlayService');
const fsSync = require('fs');
const path = require('path');
const fastifyStatic = require('@fastify/static');
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

// 新增：保存所有活跃websocket连接
const wsClients = new Set();
let shuttingDown = false;

async function registerPlugins() {
  await fastify.register(require('@fastify/cors'), {
    origin: true,
    credentials: true
  });
  await fastify.register(require('@fastify/websocket'));

  // 静态资源托管：public目录，根路径访问前端页面
  console.log('static root:', path.resolve(__dirname, './public'));
  await fastify.register(fastifyStatic, {
    root: path.join(__dirname, './public'),
    prefix: '/',
    index: 'index.html',
    decorateReply: false
  });
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
    playService,
    // 把wsClients集合传给ws路由，路由里面add/delete连接
    wsClients
  });
}
async function createApp() {
  await registerPlugins();
  await registerRoutes();
  fastify.addHook('onReady', async () => {
    await audioLibraryService.start();
    await playService.start();
    fastify.log.info('All Service started');
  });
  fastify.addHook('onClose', async () => {
    fastify.log.info('sonor is shutting down...');
  });
  return fastify;
}

// =========重写信号处理，替换原来的process.on('SIGINT') / SIGTERM=========
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  fastify.log.info(`Received ${signal}, starting graceful shutdown`);

  //
  await audioLibraryService.destroy();
  await playService.destroy();
  fastify.log.info(`services destroyed, closing fastify server and all ws clients`);

  // 1.强制关闭全部ws客户端，让tcp socket释放
  for (const sock of wsClients) {
    try {
      sock.close(1001, 'server is hutting down');
    } catch (e) { /* ignore */ }
  }
  wsClients.clear();

  // 2. fastify.close，5秒超时兜底，防止无限等待存活连接
  const closePromise = fastify.close();
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('shutdown timeout force exit')), 5000);
  });

  try {
    await Promise.race([closePromise, timeoutPromise]);
    fastify.log.info('sonor shutdown complete');
    process.exit(0);
  } catch (err) {
    fastify.log.error('shutdown error', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = {
  createApp,
  services: {
    audioLibraryService,
    playService
  }
};