/**
 * 播放器相关API路由
 * @param {FastifyInstance} fastify
 * @param {{playService: PlayService, audioLibraryService: AudioLibraryService}} opts
 */
async function playerRoutes(fastify, opts) {
  const { playService, audioLibraryService } = opts;

  /**
   * GET /api/player/current
   * 获取当前播放曲目，页面初始化兜底
   */
  fastify.get('/player/current', () => {
    const track = playService.getCurrentTrack();
    return { result: track };
  });

  fastify.get('/player/list', () => {
    const playlist = playService.getPlaylist();
    return { result: playlist };
  });
  /**
   * POST /api/player/list
   * 批量追加曲目到播放列表，前端只传uuid数组，内部从音频库补齐完整track
   * body: string[] uuid数组
   */
  fastify.post('/player/list', {
    schema: {
      body: {
        type: 'array',
        items: { type: 'string' }
      }
    }
  }, async (req) => {
    /** @type {string[]} */
    const uuidList = req.body;
    // 根据uuid批量获取完整曲目对象
    const trackList = uuidList
      .map(uuid => audioLibraryService.getTrackByUuid(uuid))
      .filter(Boolean); // 过滤找不到的曲目
    await playService.pushList(trackList);
    return {
      result: {
        totalInput: uuidList.length,
        totalLoaded: trackList.length
      }
    };
  });

  /**
   * POST /api/player/list/clear
   * 清空播放歌单
   */
  fastify.post('/player/list/clear', async () => {
    await playService.clearPlaylist();
    return { result: true };
  });

  /**
   * POST /api/player/list/remove
   * 从播放列表批量移除曲目
   * body: string[] uuid数组
   */
  fastify.post('/player/list/remove', {
    schema: {
      body: {
        type: 'array',
        items: { type: 'string' }
      }
    }
  }, async (req) => {
    /** @type {string[]} */
    const uuidList = req.body;
    await playService.removeTracksByUuids(uuidList);
    return { result: true };
  });

  /**
   * POST /api/player/play
   * 根据uuid播放指定曲目
   * body: { uuid: string }
   */
  fastify.post('/player/playpause', async (req) => {
    const result = await playService.playPause();
    return { result };
  });
  /**
   * POST /api/player/play
   * 根据uuid播放指定曲目
   * body: { uuid: string }
   */
  fastify.post('/player/play/uuid', {
    schema: {
      body: {
        type: 'object',
        required: ['uuid'],
        properties: {
          uuid: { type: 'string' }
        }
      }
    }
  }, async (req) => {
    const { uuid } = req.body;
    const result = await playService.playByUuid(uuid);
    return { result };
  });
  /**
   * POST /api/player/stop
   * 停止播放，同步接口，无需await
   */
  fastify.post('/player/stop', async () => {
    const result = playService.stop();
    return { result };
  });
  /**
   * POST /api/player/next
   * 播放下一曲，异步接口，需要await
   */
  fastify.post('/player/next', async () => {
    const result = await playService.playNext(1);
    return { result };
  });
  /**
   * POST /api/player/prev
   * 播放上一曲，异步接口，需要await
   */
  fastify.post('/player/prev', async () => {
    const result = await playService.playNext(-1);
    return { result };
  });
  /**
   * POST /api/player/pause
   * 切换播放/暂停，同步接口，无需await
   */
  fastify.post('/player/pause', async () => {
    const result = playService.togglePause();
    return { result };
  });
  /**
   * POST /api/player/mute
   * 切换静音开关，同步接口，无需await
   */
  fastify.post('/player/mute', async () => {
    const result = playService.toggleMute();
    return { result };
  });

  /**
   * POST /api/player/seek
   * 跳转播放位置，单位秒
   * body: { pos: number }
   */
  fastify.post('/player/seek', {
    schema: {
      body: {
        type: 'object',
        required: ['pos'],
        properties: {
          pos: { type: 'number', minimum: 0 }
        }
      }
    }
  }, async (req) => {
    const { pos } = req.body;
    const result = playService.seek(pos);
    return { result };
  });

  /**
   * POST /api/player/eq
   * 设置均衡器参数字符串，异步接口，需要await
   * body: { eq: string }
   */
  fastify.post('/player/eq', {
    schema: {
      body: {
        type: 'object',
        properties: {
          eq: { type: 'string' }
        }
      }
    }
  }, async (req) => {
    const { eq } = req.body;
    const result = await playService.setEQ(eq);
    return { result };
  });
  /**
   * POST /api/player/volume
   * 设置音量 0‑100，异步接口，需要await
   * body: { volume: number }
   */
  fastify.post('/player/volume', {
    schema: {
      body: {
        type: 'object',
        required: ['volume'],
        properties: {
          volume: { type: 'number', minimum: 0, maximum: 100 }
        }
      }
    }
  }, async (req) => {
    const { volume } = req.body;
    const result = await playService.setVolume(volume);
    return { result };
  });
  /**
   * POST /api/player/loop
   * 切换循环播放开关，异步接口，需要await
   */
  fastify.post('/player/loop', async () => {
    const result = await playService.loop();
    return { result };
  });
  /**
   * POST /api/player/random
   * 切换随机播放开关，异步接口，需要await
   */
  fastify.post('/player/random', async () => {
    const result = await playService.random();
    return { result };
  });
}
module.exports = playerRoutes;
