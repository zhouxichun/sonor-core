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

  // 获取歌手列表（带歌曲数量），不分页
  fastify.get('/lib/artists', async () => {
    const list = audioLibraryService.getDistinctArtists();
    const data = list.map(item => ({
      name: item.name,
      count: item.count
    }));
    return { result: data };
  });

  // 获取专辑列表（带歌曲数量），不分页
  fastify.get('/lib/albums', async () => {
    const list = audioLibraryService.getDistinctAlbums();
    const data = list.map(item => ({
      name: item.name,
      count: item.count
    }));
    return { result: data };
  });

  // 获取流派列表（带歌曲数量），不分页
  fastify.get('/lib/genres', async () => {
    const list = audioLibraryService.getDistinctGenres();
    const data = list.map(item => ({
      name: item.name,
      count: item.count
    }));
    return { result: data };
  });
}

module.exports = libRoute;
