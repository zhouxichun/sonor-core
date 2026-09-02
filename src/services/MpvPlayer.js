const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const EventEmitter = require('events');

class MpvPlayer extends EventEmitter {
    static EVENTS = {
        CURRENTTIME_UPDATED: 'mpvplayer:currenttime_updated',
        END: 'mpvplayer:end',
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
    }

    start() {
        this.#spawn();
    }

    setVolume(vol) {
        const safeVol = Math.min(Math.max(vol, 0), 100);
        this.#sendCommand(['set_property', 'volume', safeVol]);
    }

    mute() {
        this.#sendCommand(["cycle", "mute"]);
    }

    play(audioFile) {
        if (!audioFile) return this;
        if (!this.#isConnected) return this;
        this.#currentFile = audioFile;
        this.#lastEmitTime = -1;
        this.#currentTimeSec = 0;
        this.#sendCommand(['loadfile', audioFile, 'replace']);
        this.#sendCommand(['set_property', "pause", false]);
        return this;
    }

    stop() {
        this.#currentFile = null;
        this.#currentTimeSec = 0;
        this.#sendCommand(['stop']);
    }

    seek(pos) {
        this.#sendCommand(['seek', Math.max(pos, 0), 'absolute']);
    }

    pause() {
        this.#sendCommand(["cycle", "pause"]);
    }

    async destroy() {
        this.removeAllListeners();
        this.#sendCommand(['quit']);
        await new Promise(resolve => setTimeout(resolve, 200));
        this.#cleanup();
    }

    onCurrentTimeUpdated(callback) {
        return this.on(MpvPlayer.EVENTS.CURRENTTIME_UPDATED, callback);
    }

    onEnd(callback) {
        return this.on(MpvPlayer.EVENTS.END, callback);
    }

    onError(callback) {
        return this.on(MpvPlayer.EVENTS.ERROR, callback);
    }

    setEQ(eqString) {
        this.#sendCommand(['set_property', 'af', eqString || '']);
    }


    setLoop(enable) {
        const val = enable ? 'yes' : 'no';
        this.#sendCommand(['set', 'loop-file', val]);
    }

    #updateCurrentTime(data) {
        const sec = data == null ? 0 : parseFloat((data || 0).toFixed(2));
        this.#currentTimeSec = sec;
        if (this.#lastEmitTime < 0 || (sec - this.#lastEmitTime) * 1000 > this.#updateInterval) {
            this.#lastEmitTime = sec;
            this.emit(MpvPlayer.EVENTS.CURRENTTIME_UPDATED, this.#currentTimeSec);
        }
    }

    #spawn() {
        this.#cleanup();
        this.#player = spawn('mpv', [
            '--no-video', '--no-terminal', '--idle=yes',
            `--input-ipc-server=${this.#socketPath}`
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        this.#player.stderr.on('data', d => console.log('[MPV stderr]', d.toString().trim()));

        this.#player.on('exit', (code, signal) => {
            console.log(`[MpvPlayer] Exit: code=${code}, signal=${signal}`);
            this.#cleanup();
            if (code !== 0 && signal !== 'SIGTERM') {
                this.emit(MpvPlayer.EVENTS.ERROR, { code, signal });
                this.#reconnectTimer = setTimeout(() => this.#spawn(), 1000);
            }
        });

        this.#connectSocket();
    }

    #connectSocket() {
        const tryConnect = () => {
            if (!fs.existsSync(this.#socketPath)) {
                this.#reconnectTimer = setTimeout(tryConnect, 50);
                return;
            }
            this.#socket = net.createConnection(this.#socketPath);

            this.#socket.on('connect', () => {
                this.#isConnected = true;
                console.log('[MpvPlayer] IPC Connected');
                this.#setupObservations();
                this.#flushQueue();
            });

            this.#socket.on('data', chunk => this.#handleData(chunk.toString()));

            this.#socket.on('error', err => console.warn('[MpvPlayer] Socket error:', err.message));

            this.#socket.on('end', () => {
                console.log('[MpvPlayer] Socket disconnected');
                this.#isConnected = false;
                if (!this.#reconnectTimer) {
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
            } catch (e) {
                console.warn('[MpvPlayer] send failed, queue cmd', e.message);
                this.#commandQueue.push(command);
            }
        } else {
            this.#commandQueue.push(command);
        }
    }

    #setupObservations() {
        this.#sendCommand(['observe_property', 0, 'time-pos']);
        this.#sendCommand(['observe_property', 4, 'idle-active']);
    }

    #flushQueue() {
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
                console.warn('[MpvPlayer] Invalid JSON:', line);
            }
        }
    }

    #handleMessage(msg) {
        if (msg.event === 'playback-restart') return;
        if (msg.event === 'end-file') {
            this.emit(MpvPlayer.EVENTS.END);
            this.#currentFile = null;
            return;
        }
        if (msg.event !== 'property-change') return;

        switch (msg.name) {
            case 'time-pos':
                this.#updateCurrentTime(msg.data);
                break;
            case 'idle-active':
                if (msg.data && this.#currentFile) {
                    this.emit(MpvPlayer.EVENTS.END);
                    this.#currentFile = null;
                }
                break;
        }
    }

    #cleanup() {
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
        if (this.#socket) {
            this.#socket.destroy();
            this.#socket = null;
        }
        if (this.#player && !this.#player.killed) {
            this.#player.kill('SIGKILL');
        }
        this.#player = null;
        this.#isConnected = false;
        this.#commandQueue = [];
        this.#currentTimeSec = 0;
        try {
            if (fs.existsSync(this.#socketPath)) fs.unlinkSync(this.#socketPath);
        } catch (e) { }
    }
}

module.exports = MpvPlayer;
