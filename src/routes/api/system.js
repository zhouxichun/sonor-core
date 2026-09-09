/**
 * 播放器相关API路由
 * @param {FastifyInstance} fastify
 * @param {{}} opts
 */
async function systemRoutes(fastify, opts) {
 
  fastify.post('/system/reboot', () => {
    return fastify.systemService.reboot();
  });
  fastify.post('/system/shutdown', () => {
    return fastify.systemService.shutdown();
  });
}

module.exports = systemRoutes;