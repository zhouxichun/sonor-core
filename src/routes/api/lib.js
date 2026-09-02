async function libRoute(fastify, opts) {
  const { audioLibraryService } = opts;

  fastify.get('/lib/filtertracks', async (request) => {
    const { artist, album, genre, keyword, offset = 0, limit = 50 } = request.query;

    const filterParams = {};
    // 只有query实际传了才放进过滤对象，不存在就不传该key给service
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
      ok: true,
      ...result
    };
  });
}

module.exports = libRoute;
