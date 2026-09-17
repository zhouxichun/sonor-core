const fastify = require('fastify')({ logger: { level: 'info' } });
const path = require('path');
const fastifyStatic = require('@fastify/static');
const config = require('./config');
const logger = require('./utils/logger')('root');

async function main() {
  logger.info('fastify registering plugin: @fastify/websocket');
  await fastify.register(require('@fastify/websocket'));

  logger.info(`fastify registering static serve`);
  const staticRoot = path.resolve(__dirname, './public');
  await fastify.register(fastifyStatic, {
    root: staticRoot,
    prefix: '/',
    index: 'index.html',
    decorateReply: false
  });

  logger.info('fastify registering api routes, prefix=/api');
  await fastify.register(require('./routes/index'), { prefix: '/api' });

  try {
    await fastify.listen({
      host: config.server.host,
      port: config.server.port
    });
    logger.info(`Sonor Core running at http://${config.server.host}:${config.server.port}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

// 只做一件事：收到信号调用 fastify.close()
process.on('SIGINT', () => {
  logger.info('SIGINT received, start fastify close');
  fastify.close().catch(e => logger.error('fastify close error', e));
});
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, start fastify close');
  fastify.close().catch(e => logger.error('fastify close error', e));
});

main().catch(err => {
  logger.error('main bootstrap error', err);
  process.exit(1);
});
