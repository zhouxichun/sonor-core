const fastify = require('fastify')({
  logger: true,
  disableRequestLogging: false
});
const dotenv = require('dotenv');
dotenv.config();

// 注册插件
async function registerPlugins() {
  // 跨域
  await fastify.register(require('@fastify/cors'), {
    origin: true,
    credentials: true
  });

  // WebSocket（用于播放状态实时推送）
  await fastify.register(require('@fastify/websocket'));

  // 静态资源托管（前端控制面板 public 目录）
  await fastify.register(require('@fastify/static'), {
    root: `${__dirname}/../public`,
    prefix: '/'
  });

  // 统一全局响应格式插件
  fastify.register(async (instance) => {
    instance.addHook('onSend', async (request, reply, payload) => {
      // 仅处理接口路由，避免干扰静态页面
      if (request.url.startsWith('/api/')) {
        try {
          const data = JSON.parse(payload);
          // 如果外部已经包装 code 则不二次包裹
          if (!Object.prototype.hasOwnProperty.call(data, 'code')) {
            return JSON.stringify({
              code: 0,
              msg: 'success',
              data
            });
          }
        } catch (e) {
          // 非JSON内容原样返回
        }
      }
      return payload;
    });
  });
}

// 加载路由
async function registerRoutes() {
  // 自动载入路由入口
  await fastify.register(require('./routes/index'), { prefix: '/api' });
}

async function createApp() {
  await registerPlugins();
  await registerRoutes();
  return fastify;
}

module.exports = { createApp };