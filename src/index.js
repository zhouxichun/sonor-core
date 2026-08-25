const { createApp } = require('./app');
const config = require('./config');
const AudioLibraryService = require('./services/AudioLibraryService ');

async function bootstrap() {
  const fastify = await createApp();

  // 初始化播放器
  const audioLibraryService = new AudioLibraryService();
  await audioLibraryService.start();

  try {
    await fastify.listen({
      host: config.server.host,
      port: config.server.port
    });
    console.log(`✅ Sonor Core running at http://${config.server.host}:${config.server.port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

bootstrap();