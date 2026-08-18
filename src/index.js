const { createApp } = require('./app');
const config = require('./config');

async function bootstrap() {
  const fastify = await createApp();
  try {
    await fastify.listen({
      host: config.server.host,
      port: config.server.port
    });
    console.log(`✅ Sonor HTTP Server running on http://${config.server.host}:${config.server.port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

bootstrap();