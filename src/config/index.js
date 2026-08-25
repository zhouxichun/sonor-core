require('dotenv').config();

module.exports = {
  server: {
    host: process.env.SERVER_HOST || '0.0.0.0',
    port: Number(process.env.SERVER_PORT) || 3000
  },
  mpv: {
    socket: process.env.MPV_SOCKET || '/tmp/sonor-mpv.sock'
  },
  musicRoot: process.env.MUSIC_ROOT || '/mnt/music'
};