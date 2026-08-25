//const PlayerService = require('../../services/PlayerService');

async function playerRoutes(fastify) {
  fastify.get('/player/status', async () => {
    return await PlayerService.getStatus();
  });

  fastify.post('/player/play', {
    schema: {
      body: {
        type: 'object',
        required: ['filePath'],
        properties: { filePath: { type: 'string' } }
      }
    }
  }, async (req) => {
    await PlayerService.play(req.body.filePath);
    return {};
  });

  fastify.post('/player/pause', async () => {
    await PlayerService.pause();
    return {};
  });

  fastify.post('/player/resume', async () => {
    await PlayerService.resume();
    return {};
  });

  fastify.post('/player/stop', async () => {
    await PlayerService.stop();
    return {};
  });

  fastify.post('/player/seek', {
    schema: {
      body: {
        type: 'object',
        required: ['pos'],
        properties: { pos: { type: 'number' } }
      }
    }
  }, async (req) => {
    await PlayerService.seek(req.body.pos);
    return {};
  });

  fastify.post('/player/volume', {
    schema: {
      body: {
        type: 'object',
        required: ['vol'],
        properties: { vol: { type: 'number' } }
      }
    }
  }, async (req) => {
    await PlayerService.setVolume(req.body.vol);
    return {};
  });
}
module.exports = playerRoutes;