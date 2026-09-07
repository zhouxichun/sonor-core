async function libRoute(fastify, opts) {
  const { audioLibraryService } = opts;

  fastify.get('/lib/filtertracks', async (request) => {
    console.log('filtertracks query:', request.query);
    const { artist, album, genre, keyword, offset = 0, limit = 50 } = request.query;
    const filterParams = {};
    if (artist !== undefined) filterParams.artist = artist;
    if (album !== undefined) filterParams.album = album;
    if (genre !== undefined) filterParams.genre = genre;
    if (keyword !== undefined) filterParams.keyword = keyword;

    const result = await audioLibraryService.filterTracks({
      ...filterParams,
      offset: Number(offset),
      limit: Number(limit)
    });
    return {
      result: result
    };
  });

  // 获取专辑列表（带歌曲数量），不分页
  fastify.get('/lib/grouptotal/:group', async (request) => {
    const { group } = request.params;
    let list;
    switch (group) {
      case 'artist':
        list = audioLibraryService.getDistinctArtists();
        break;
      case 'album':
        list = audioLibraryService.getDistinctAlbums();
        break;
      case 'genre':
        list = audioLibraryService.getDistinctGenres();
        break;
      default:
        throw new Error(`Unsupported group: ${group}`);
    }
    const data = list.map(item => ({
      name: item.name,
      count: item.count
    }));
    return { result: data };
  });

  /**
   * GET /api/player/track/:uuid/cover
   * query: thumbnailWidth  可选，指定则返回缩略图，不填返回原图
   */
  fastify.get('/lib/track/:uuid/cover', async (req, reply) => {
    const { uuid } = req.params;
    const { thumbnailWidth } = req.query;
    const opts = {};
    if(thumbnailWidth) {
        opts.thumbnailWidth = Number(thumbnailWidth);
    }
    const cover = await audioLibraryService.getCoverByUuid(uuid, opts);
    return {result: cover};
  });

  fastify.get('/lib/folders', async () => {
    const folders = await audioLibraryService.getFolders();
    return {result: folders};
  });

  fastify.post('/lib/folder/scan', {
    schema: {
      body: {
        type: 'object',
        required: ['folder'],
        properties: {
          folder: { type: 'string' }
        }
      }
    }
  }, async (req) => {
    const { folder } = req.body;
    const result = await audioLibraryService.scanFolder(folder);
    return { result };
  });
}

module.exports = libRoute;
