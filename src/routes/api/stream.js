const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

module.exports = async function (fastify) {
  fastify.get('/stream/:uuid', async (req, reply) => {
    const { uuid } = req.params;
    const track = fastify.playService.getPlaylist().find(t => t.uuid === uuid);
    if (!track) {
      return reply.code(404).send({ result: null, msg: 'track not found' });
    }
    const filePath = track.filepath;
    try {
      const stat = await fsPromises.stat(filePath);
      const totalSize = stat.size;
      const rangeHeader = req.headers.range;
      let start = 0;
      let end = totalSize - 1;

      if (rangeHeader) {
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        start = parseInt(parts[0],10);
        if(parts[1]) end = parseInt(parts[1],10);
        if(isNaN(start)) start = 0;
        if(isNaN(end) || end >= totalSize) end = totalSize - 1;
      }
      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(filePath, { start, end });

      if(rangeHeader){
        reply.code(206);
        reply.header('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      }else{
        reply.code(200);
      }
      reply.header('Accept-Ranges','bytes');
      reply.header('Content-Length', chunkSize);
      reply.header('Content-Type','audio/mpeg');

      return reply.send(stream);
    }catch(err){
      fastify.log.error(err);
      return reply.code(500).send({result:null,msg:'file stream error'});
    }
  });
};
