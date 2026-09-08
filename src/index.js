const fastify = require('fastify')({
  logger: { level: 'info' }
});
const AudioLibraryService = require('./services/AudioLibraryService');
const PlayService = require('./services/PlayService');
const fsSync = require('fs');
const path = require('path');
const fastifyStatic = require('@fastify/static');
const config = require('./config');
const logger = require('./utils/logger')(__dirname);

let shuttingDown = false;

/**
 * 创建fastify应用实例
 * 执行顺序：注册插件 → 挂载全局钩子 → 注册业务路由 → 挂载生命周期回调
 * @returns {import('fastify').FastifyInstance} fastify实例
 */
async function createApp() {

  // 数据目录初始化
  const dataPath = path.join(__dirname, '../data');
  if (!fsSync.existsSync(dataPath)) {
    fsSync.mkdirSync(dataPath, { recursive: true });
    logger.info(`Created data directory: ${dataPath}`);
  }

  // 挂载到fastify全局
  fastify.decorate('audioLibraryService', new AudioLibraryService({ dataPath }));
  fastify.decorate('playService', new PlayService({ dataPath }));
  fastify.decorate('wsClients', new Set());

  // 注册跨域插件，允许前端浏览器跨域访问API
  logger.info('fastify registering plugin: @fastify/cors');
  await fastify.register(require('@fastify/cors'), {
    origin: true,
    credentials: true
  });

  // 注册websocket插件，提供ws长连接能力，用于播放器状态实时推送
  logger.info('fastify registering plugin: @fastify/websocket');
  await fastify.register(require('@fastify/websocket'));

  // 注册静态资源插件，托管前端页面、css、图标等静态文件
  const staticRoot = path.resolve(__dirname, './public');
  logger.info(`fastify registering static serve`);
  await fastify.register(fastifyStatic, {
    root: staticRoot,
    prefix: '/',
    index: 'index.html',
    decorateReply: false
  });

  // Fastify就绪生命周期钩子：服务内部全部插件加载完成后，启动业务层服务
  fastify.addHook('onReady', async () => {
    logger.info('rastify onReady hook, starting business services');
    await fastify.audioLibraryService.start();
    await fastify.playService.start();
    logger.info('All Service started');
  });

  // 服务关闭生命周期钩子：服务执行关闭流程时打印日志
  fastify.addHook('onClose', async () => {
    logger.info('sonor is shutting down...');
  });

  // 注册业务API路由，所有接口统一前缀 /api
  logger.info('fastify registering api routes, prefix=/api');
  await fastify.register(require('./routes/index'), { prefix: '/api' });

  logger.info('App instance created complete');

  return fastify;
}

/**
 * 优雅关闭
 */
async function gracefulShutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info(`Received ${signal}, starting graceful shutdown`);

  logger.info('Destroying audioLibraryService');
  await fastify.audioLibraryService.destroy();

  logger.info('Destroying playService');
  await fastify.playService.destroy();

  logger.info('services destroyed, closing fastify server and all ws clients');
  logger.info(`Active ws clients count: ${fastify.wsClients.size}`);

  // 关闭全部活跃ws连接
  for (const sock of fastify.wsClients) {
    try {
      sock.close(1001, 'server is shutting down');
    } catch (e) {
      logger.warn('ws socket close exception', e.message);
    }
  }
  fastify.wsClients.clear();
  logger.info('All ws clients cleared');

  // 5s超时兜底
  const closePromise = fastify.close();
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('shutdown timeout force exit')), 5000);
  });

  try {
    await Promise.race([closePromise, timeoutPromise]);
    logger.info('sonor shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('shutdown error', err);
    process.exit(1);
  }
}

// 监听终止信号
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

/**
 * 程序入口 bootstrap
 */
async function bootstrap() {

  const appInstance = await createApp();
  try {
    await appInstance.listen({
      host: config.server.host,
      port: config.server.port
    });
    logger.info(`Sonor Core running at http://${config.server.host}:${config.server.port}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

// 启动
bootstrap();
