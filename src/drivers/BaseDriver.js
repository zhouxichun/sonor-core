class BaseDriver {
  async connect() {}
  async disconnect() {}

  async play(filePath) {}
  async pause() {}
  async resume() {}
  async stop() {}
  async seek(seconds) {}
  async setVolume(vol) {}
  async getStatus() {}
}

module.exports = BaseDriver;