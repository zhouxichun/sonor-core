const fastify = require('fastify')({ logger: true });

async function registerPlugins() {
  await fastify.register(require('@fastify/cors'), {
    origin: true,
    credentials: true
  });
  await fastify.register(require('@fastify/websocket'));

  // 统一响应包装
  fastify.register(async (instance) => {
    instance.addHook('onSend', async (request, reply, payload) => {
      if (request.url.startsWith('/api/')) {
        try {
          const data = JSON.parse(payload);
          if (!Object.prototype.hasOwnProperty.call(data, 'code')) {
            return JSON.stringify({ code: 0, msg: 'success', data });
          }
        } catch {}
      }
      return payload;
    });
  });
}

async function registerRoutes() {
  await fastify.register(require('./routes/index'), { prefix: '/api' });
}

async function createApp() {
  await registerPlugins();
  await registerRoutes();
  return fastify;
}

module.exports = { createApp };