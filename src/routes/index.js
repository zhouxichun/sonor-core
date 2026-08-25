const fs = require('fs');
const path = require('path');

async function routes(fastify) {
  const apiDir = path.join(__dirname, 'api');
  const files = fs.readdirSync(apiDir);
  for (const file of files) {
    if (file.endsWith('.js')) {
      fastify.register(require(path.join(apiDir, file)));
    }
  }

  // WS连接入口
  fastify.get('/ws', { websocket: true }, (connection) => {
    const Broadcast = require('../../services/BroadcastService');
    Broadcast.addClient(connection);
    connection.on('close', () => Broadcast.removeClient(connection));
  });
}
module.exports = routes;