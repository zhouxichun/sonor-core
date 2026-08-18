const BaseDriver = require('./BaseDriver');
const { MpvIpc } = require('mpv-ipc');
const { spawn } = require('child_process');
const path = require('path');

const SOCKET_PATH = '/tmp/sonor-mpv.sock';

class MpvDriver extends BaseDriver {
  constructor() {
    super();
    this.mpvProcess = null;
    this.ipc = null;
    this.connected = false;
  }

  async connect() {
    // 启动 mpv 后台进程
    this.mpvProcess = spawn('mpv', [
      '--no-video',
      '--input-ipc-server=' + SOCKET_PATH,
      '--idle',
      '--quiet'
    ]);

    this.mpvProcess.on('error', (err) => {
      console.error('mpv 启动失败:', err);
    });

    // 等待 mpv 创建socket后连接
    await new Promise(resolve => setTimeout(resolve, 800));
    this.ipc = new MpvIpc(SOCKET_PATH);
    this.connected = true;
    console.log('✅ mpv driver connected');
  }

  async disconnect() {
    if (this.mpvProcess) {
      this.mpvProcess.kill();
      this.mpvProcess = null;
    }
    this.connected = false;
  }

  // 播放本地音频文件
  async play(filePath) {
    await this.ipc.command(['loadfile', filePath]);
  }

  async pause() {
    await this.ipc.setProperty('pause', true);
  }

  async resume() {
    await this.ipc.setProperty('pause', false);
  }

  async stop() {
    await this.ipc.command(['stop']);
  }

  async seek(seconds) {
    await this.ipc.command(['seek', seconds, 'absolute']);
  }

  async setVolume(vol) {
    await this.ipc.setProperty('volume', vol);
  }

  async getStatus() {
    const pause = await this.ipc.getProperty('pause');
    const volume = await this.ipc.getProperty('volume');
    const timePos = await this.ipc.getProperty('time-pos');
    const duration = await this.ipc.getProperty('duration');
    const filename = await this.ipc.getProperty('filename');

    return {
      playing: pause !== true,
      volume,
      timePos: timePos || 0,
      duration: duration || 0,
      filePath: filename
    };
  }
}

module.exports = MpvDriver;