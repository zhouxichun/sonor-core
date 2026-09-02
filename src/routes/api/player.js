async function playerRoutes(fastify, opts) {
  const { playService } = opts;

  fastify.post('/player/list', {
    schema: {
      body: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            uuid: { type: 'string' },
            filepath: { type: 'string' },
            filename: { type: 'string' },
            title: { type: 'string' },
            artist: { type: 'string' },
            album: { type: 'string' },
            duration: { type: 'number' },
            genre: { type: 'string' }
          }
        }
      }
    }
  }, async (req) => {
    const trackList = req.body;
    // trackList 就是你示例的数组：[{uuid,filepath,...}, ...]
    await playService.pushList(trackList);
    return { ok: true };
  });

  fastify.post('/player/play', {
    schema: {
        body: {
            type: 'object',
            properties: { uuid: { type: 'string' } }
        }
    }
  }, async (req) => {
      const { uuid } = req.body;
      const ok = playService.play(uuid);
      return { ok };
  });


  fastify.get('/player/status', async () => {
    return await PlayerService.getStatus();
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