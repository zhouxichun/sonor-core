async function libRoute(fastify, opts) {
  fastify.get('/lib/filtertracks', async (request) => {
    console.log('filtertracks query:', request.query);
    const { artist, album, genre, keyword } = request.query;
    const filterParams = {};
    if (artist !== undefined) filterParams.artist = artist;
    if (album !== undefined) filterParams.album = album;
    if (genre !== undefined) filterParams.genre = genre;
    if (keyword !== undefined) filterParams.keyword = keyword;
    return await fastify.audioLibraryService.filterTracks({
      ...filterParams,
    });
  });

  // 获取分组列表（带歌曲数量)
  fastify.get('/lib/grouptotal/:group', async (request) => {
    const { group } = request.params;
    let list;
    switch (group) {
      case 'artist':
        list = fastify.audioLibraryService.getDistinctArtists();
        break;
      case 'album':
        list = fastify.audioLibraryService.getDistinctAlbums();
        break;
      case 'genre':
        list = fastify.audioLibraryService.getDistinctGenres();
        break;
      default:
        throw new Error(`Unsupported group: ${group}`);
    }
    return list.map(item => ({
      name: item.name,
      count: item.count
    }));
  });

  /**
   * GET /api/lib/track/:uuid/cover
   * query: thumbnailWidth  可选，指定则返回缩略图，不填返回原图
   */
  fastify.get('/lib/track/:uuid/cover', async (req, reply) => {
    const { uuid } = req.params;
    const { thumbnailWidth } = req.query;
    const opts = {};
    if(thumbnailWidth) {
        opts.thumbnailWidth = Number(thumbnailWidth);
    }
    const cover = await fastify.audioLibraryService.getCoverByUuid(uuid, opts);
    return {cover};
  });

  fastify.get('/lib/folders', async () => {
    return await fastify.audioLibraryService.getFolders();
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
    return await fastify.audioLibraryService.scanFolder(folder);
  });
}

module.exports = libRoute;