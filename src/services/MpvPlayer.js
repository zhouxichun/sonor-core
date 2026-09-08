const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const logger = require('../utils/logger')(__dirname);
class MpvPlayer extends EventEmitter {
    static EVENTS = {
        PLAY: 'mpvplayer:play',   // 曲目开始播放(playback‑restart)
        CURRENTTIME_UPDATED: 'mpvplayer:currenttime_updated',
        END: 'mpvplayer:end',     // 自然播放完毕 eof
        STOP: 'mpvplayer:stop',   // 主动stop / loadfile replace切歌
        PAUSE_TOGGLE: 'mpvplayer:pause_toggle', // 暂停状态切换，参数 isPaused: boolean
        MUTE_TOGGLE: 'mpvplayer:mute_toggle',   // 静音状态切换，参数 isMute: boolean
        ERROR: 'mpvplayer:error'
    };
    #player = null;
    #socket = null;
    #isConnected = false;
    #commandQueue = [];
    #currentFile = null;
    #buffer = '';
    #lastEmitTime = -1;
    #socketPath;
    #reconnectTimer = null;
    #updateInterval;
    #currentTimeSec;
    constructor(opts = {}) {
        super();
        this.#socketPath = path.join(os.tmpdir(), `mpv-ipc-${process.pid}.sock`);
        this.#updateInterval = opts.updateInterval ?? 1000;
        this.#currentTimeSec = 0;
        logger.info(`MpvPlayer instance created.`);
    }
    /**
     * @param {Object} [opts={}]
     * @param {boolean} [opts.loop=false]
     * @param {number} [opts.volume=80]
     * @param {string} [opts.eq='']
     */
    init() {
        logger.info('MpvPlayer init, spawn mpv process');
        this.#spawn();
    }
    setVolume(vol) {
        logger.debug(`MpvPlayer setVolume ${vol}`);
        this.#sendCommand(['set_property', 'volume',  Math.min(Math.max(vol, 0), 100)]);
        this.#sendCommand(["set_property", "mute", false]);
    }
    setEQ(eqString) {
        logger.debug(`MpvPlayer setEQ ${eqString}`);
        this.#sendCommand(['set_property', 'af', eqString || '']);
    }
    setLoop(enable) {
        const val = enable ? 'yes' : 'no';
        logger.debug(`MpvPlayer setLoop ${enable}`);
        this.#sendCommand(['set', 'loop-file', val]);
    }
    play(audioFile) {
        if (!audioFile) {
            logger.warn('MpvPlayer play called with empty audioFile');
            return this;
        }
        if (!this.#isConnected) {
            logger.warn(`MpvPlayer play skip, ipc not connected ${audioFile}`);
            return this;
        }
        this.#currentFile = audioFile;
        this.#lastEmitTime = -1;
        this.#currentTimeSec = 0;
        logger.info(`MpvPlayer loadfile play ${audioFile}`);
        this.#sendCommand(['loadfile', audioFile, 'replace']);
        this.#sendCommand(['set_property', "pause", false]);
        return this;
    }
    stop() {
        logger.info('MpvPlayer stop');
        this.#currentFile = null;
        this.#currentTimeSec = 0;
        this.#sendCommand(['stop']);
    }
    seek(pos) {
        logger.debug(`MpvPlayer seek absolute ${pos}`);
        this.#sendCommand(['seek', Math.max(pos, 0), 'absolute']);
        this.#sendCommand(['set_property', "pause", false]);
    }
    togglePause() {
        logger.debug('MpvPlayer togglePause');
        this.#sendCommand(["cycle", "pause"]);
    }
    toggleMute() {
        logger.debug('MpvPlayer toggleMute');
        this.#sendCommand(["cycle", "mute"]);
    }
    async destroy() {
        logger.info('MpvPlayer destroy begin');
        this.removeAllListeners();
        this.#sendCommand(['quit']);
        await new Promise(resolve => setTimeout(resolve, 200));
        this.#cleanup();
        logger.info('MpvPlayer destroy done');
    }
    onPlay(callback) {
        return this.on(MpvPlayer.EVENTS.PLAY, callback);
    }
    onCurrentTimeUpdated(callback) {
        return this.on(MpvPlayer.EVENTS.CURRENTTIME_UPDATED, callback);
    }
    onEnd(callback) {
        return this.on(MpvPlayer.EVENTS.END, callback);
    }
    onStop(callback) {
        return this.on(MpvPlayer.EVENTS.STOP, callback);
    }
    onPauseToggle(callback) {
        return this.on(MpvPlayer.EVENTS.PAUSE_TOGGLE, callback);
    }
    onMuteToggle(callback) {
        return this.on(MpvPlayer.EVENTS.MUTE_TOGGLE, callback);
    }
    onError(callback) {
        return this.on(MpvPlayer.EVENTS.ERROR, callback);
    }
    #updateCurrentTime(data) {
        const sec = data == null ? 0 : parseFloat((data || 0).toFixed(2));
        this.#currentTimeSec = sec;
        const isTimeRewind = sec < this.#lastEmitTime;
        const needEmit = isTimeRewind || (this.#lastEmitTime < 0 || (sec - this.#lastEmitTime) * 1000 > this.#updateInterval);
        if (needEmit) {
            this.#lastEmitTime = sec;
            this.emit(MpvPlayer.EVENTS.CURRENTTIME_UPDATED, this.#currentTimeSec);
        }
    }
    #spawn() {
        this.#cleanup();
        logger.info('MpvPlayer spawn mpv child process');
        this.#player = spawn('mpv', [
            '--no-video', '--no-terminal', '--idle=yes',
            `--input-ipc-server=${this.#socketPath}`
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        this.#player.stderr.on('data', d => logger.debug(`[MPV stderr] ${d.toString().trim()}`));
        this.#player.on('exit', (code, signal) => {
            logger.warn(`MpvPlayer child process exit, code=${code}, signal=${signal}`);
            this.#cleanup();
            if (code !== 0 && signal !== 'SIGTERM') {
                this.emit(MpvPlayer.EVENTS.ERROR, { code, signal });
                logger.info('MpvPlayer schedule reconnect after 1000ms');
                this.#reconnectTimer = setTimeout(() => this.#spawn(), 1000);
            }
        });
        this.#connectSocket();
    }
    #connectSocket() {
        const tryConnect = () => {
            if (!fs.existsSync(this.#socketPath)) {
                logger.debug('MpvPlayer ipc socket not exist, retry later');
                this.#reconnectTimer = setTimeout(tryConnect, 50);
                return;
            }
            logger.info(`MpvPlayer connecting to ipc socket`);
            this.#socket = net.createConnection(this.#socketPath);
            this.#socket.on('connect', () => {
                this.#isConnected = true;
                logger.info('IPC Connected');
                this.#setupObservations();
                this.#flushQueue();
            });
            this.#socket.on('data', chunk => this.#handleData(chunk.toString()));
            this.#socket.on('error', err => logger.warn(`[MpvPlayer] Socket error: ${err.message}`));
            this.#socket.on('end', () => {
                logger.warn('[MpvPlayer] Socket disconnected');
                this.#isConnected = false;
                if (!this.#reconnectTimer) {
                    logger.info('MpvPlayer socket end, schedule reconnect 1000ms');
                    this.#reconnectTimer = setTimeout(() => this.#connectSocket(), 1000);
                }
            });
        };
        tryConnect();
    }
    #sendCommand(command) {
        const payload = JSON.stringify({ command }) + '\n';
        if (this.#isConnected && this.#socket?.writable) {
            try {
                this.#socket.write(payload);
                logger.debug(`MpvPlayer send cmd ${JSON.stringify(command)}`);
            } catch (e) {
                logger.warn(`[MpvPlayer] send failed, push to queue ${e.message} ${JSON.stringify(command)}`);
                this.#commandQueue.push(command);
            }
        } else {
            logger.debug(`MpvPlayer ipc not ready, enqueue cmd ${JSON.stringify(command)}`);
            this.#commandQueue.push(command);
        }
    }
    #setupObservations() {
        logger.debug('MpvPlayer setup property observe');
        this.#sendCommand(['observe_property', 0, 'time-pos']);
        this.#sendCommand(['observe_property', 1, 'pause']);
        this.#sendCommand(['observe_property', 2, 'mute']);
    }
    #flushQueue() {
        logger.info(`MpvPlayer flush command queue, pending count ${this.#commandQueue.length}`);
        while (this.#commandQueue.length > 0) {
            const cmd = this.#commandQueue.shift();
            this.#sendCommand(cmd);
        }
    }
    #handleData(chunk) {
        this.#buffer += chunk;
        let newlineIndex;
        while ((newlineIndex = this.#buffer.indexOf('\n')) !== -1) {
            const line = this.#buffer.slice(0, newlineIndex).trim();
            this.#buffer = this.#buffer.slice(newlineIndex + 1);
            if (!line) continue;
            try {
                this.#handleMessage(JSON.parse(line));
            } catch (e) {
                logger.warn(`[MpvPlayer] Invalid JSON payload ${line}`);
            }
        }
    }
    #handleMessage(msg) {
        logger.debug(`MpvPlayer ipc event ${msg.event ?? 'property‑change'}`);
        if (msg.event === 'playback-restart') {
            this.emit(MpvPlayer.EVENTS.PLAY);
            return;
        }
        if (msg.event === 'end-file') {
            this.#currentFile ? this.emit(MpvPlayer.EVENTS.END) : this.emit(MpvPlayer.EVENTS.STOP);
            return;
        }
        if (msg.event !== 'property-change') return;
        switch (msg.name) {
            case 'time-pos':
                this.#updateCurrentTime(msg.data);
                break;
            case 'pause': {
                const paused = !!msg.data;
                logger.debug(`MpvPlayer pause state changed ${paused}`);
                this.emit(MpvPlayer.EVENTS.PAUSE_TOGGLE, paused);
                break;
            }
            case 'mute': {
                const muted = !!msg.data;
                logger.info(`MpvPlayer mute state changed: ${muted}`);
                this.emit(MpvPlayer.EVENTS.MUTE_TOGGLE, muted);
                break;
            }
        }
    }
    #cleanup() {
        logger.debug('MpvPlayer cleanup');
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
        if (this.#socket) {
            this.#socket.destroy();
            this.#socket = null;
        }
        if (this.#player && !this.#player.killed) {
            logger.info('MpvPlayer kill child mpv process');
            this.#player.kill('SIGKILL');
        }
        this.#player = null;
        this.#isConnected = false;
        this.#commandQueue = [];
        this.#currentTimeSec = 0;
        try {
            if (fs.existsSync(this.#socketPath)) fs.unlinkSync(this.#socketPath);
        } catch (e) {
            logger.debug(`MpvPlayer remove socket file fail ${e.message}`);
        }
    }
}
module.exports = MpvPlayer;