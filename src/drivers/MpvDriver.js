const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const BaseDriver = require('./BaseDriver');

class MpvDriver extends BaseDriver {
    constructor() {
        super();

        // mpv 私有选项
        this.options = {
            useEQ: false,
            volume: 50,
            enableStderrLog: true
        };

        this._player = null;
        this._socket = null;
        this._isConnected = false;
        this._commandQueue = [];
        this._equalizer = null;
        this._buffer = '';
        this._lastEmitTime = -1;

        this._socketPath = path.join(os.tmpdir(), `mpv-ipc-${process.pid}.sock`);

        this._spawn();
    }

    UseEQ(use = true) {
        this.options.useEQ = use;
        this._applyEQ();
        return this;
    }

    SetVolume(vol) {
        this.options.volume = this._clampVolume(vol);
        this._sendCommand(['set_property', 'volume', this.options.volume]);
        return this;
    }

    Mute() {
        this._sendCommand(["cycle", "mute"]);
        return this;
    }

    SetEqualizer(eq) {
        this._equalizer = eq ?? '';
        this._applyEQ();
        return this;
    }

    Play(audioFile) {
        // 使用基类校验，校验失败直接返回
        if (!this._checkAudioFile(audioFile)) {
            return this;
        }
        
        if (!this._isConnected) return this;

        this._status.filePath = audioFile;
        this._lastEmitTime = -1;
        this._sendCommand(['loadfile', audioFile, 'replace']);
        this._sendCommand(['set_property', "pause", false]);
        return this;
    }

    Stop() {
        this._status.filePath = null;
        this._sendCommand(['stop']);
        this._updatePlayState({ playing: false, paused: false });
        return this;
    }

    Seek(pos) {
        const p = this._clampSeekPos(pos);
        this._sendCommand(['seek', p, 'absolute']);
        return this;
    }

    Pause() {
        this._sendCommand(["cycle", "pause"]);
        return this;
    }

    /**
     * 模板钩子：子类实现底层销毁逻辑
     */
    _onDestroy() {
        this._sendCommand(['quit']);
        setTimeout(() => this._cleanup(), 300);
    }

    // ================= 内部方法 =================
    _applyEQ() {
        const afValue = this.options.useEQ && this._equalizer ? this._equalizer : '';
        this._sendCommand(['set_property', 'af', afValue]);
    }

    _spawn() {
        this._cleanup();
        this._player = spawn('mpv', [
            '--no-video', '--no-terminal', '--idle=yes',
            `--input-ipc-server=${this._socketPath}`
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        this._player.stderr.on('data', d => {
            if (this.options.enableStderrLog) {
                console.log('[MPV stderr]', d.toString().trim());
            }
        });

        this._player.on('exit', (code, signal) => {
            console.log(`[MpvDriver] Exit: code=${code}, signal=${signal}`);
            const isNormalQuit = signal === 'SIGTERM' || code === 0;
            this._cleanup();

            if (!isNormalQuit) {
                this._emitError({ code, signal });
                if (this.commonOptions.autoRestart) {
                    console.log('[MpvDriver] will auto‑restart mpv...');
                    setTimeout(() => this._spawn(), 800);
                }
            }
        });

        this._connectSocket();
    }

    _connectSocket() {
        const tryConnect = () => {
            if (!fs.existsSync(this._socketPath)) {
                setTimeout(tryConnect, 50);
                return;
            }
            this._socket = net.createConnection(this._socketPath);

            this._socket.on('connect', () => {
                this._isConnected = true;
                console.log('[MpvDriver] IPC Connected');
                this._setupObservations();
                this._flushQueue();
                setTimeout(() => {
                    this._sendCommand(['set_property', 'volume', this.options.volume]);
                    this._applyEQ();
                }, 100);
            });

            this._socket.on('data', chunk => this._handleData(chunk.toString()));

            this._socket.on('error', err => {
                console.warn('[MpvDriver] Socket error:', err.message);
                this._isConnected = false;
            });

            this._socket.on('end', () => {
                this._isConnected = false;
                console.log('[MpvDriver] IPC socket disconnected');
            });
        };
        tryConnect();
    }

    _sendCommand(command) {
        if (!this._isConnected) {
            this._queueCommand(command);
            return;
        }
        const payload = JSON.stringify({ command }) + '\n';
        if (this._socket?.writable) {
            try {
                this._socket.write(payload);
            } catch (e) {
                console.warn('[MpvDriver] send failed, enqueue', e.message);
                this._queueCommand(command);
                this._isConnected = false;
            }
        } else {
            this._queueCommand(command);
        }
    }

    _setupObservations() {
        this._sendCommand(['observe_property', 0, 'time-pos']);
        this._sendCommand(['observe_property', 1, 'pause']);
        this._sendCommand(['observe_property', 2, 'duration']);
        this._sendCommand(['observe_property', 3, 'mute']);
        this._sendCommand(['observe_property', 4, 'idle-active']);
    }

    _queueCommand(command) { this._commandQueue.push(command); }

    _flushQueue() {
        while (this._commandQueue.length > 0) {
            this._sendCommand(this._commandQueue.shift());
        }
    }

    _handleData(chunk) {
        this._buffer += chunk;
        let newlineIndex;
        while ((newlineIndex = this._buffer.indexOf('\n')) !== -1) {
            const line = this._buffer.slice(0, newlineIndex).trim();
            this._buffer = this._buffer.slice(newlineIndex + 1);
            if (!line) continue;
            try {
                this._handleMessage(JSON.parse(line));
            } catch (e) {
                console.warn('[MpvDriver] Invalid JSON:', line.substring(0,120));
            }
        }
    }

    _handleMessage(msg) {
        if (msg.event === 'playback‑restart') {
            this._updatePlayState({ playing: true, paused: false });
            return;
        }

        if (msg.event === 'end‑file') {
            const reason = msg.reason;
            this._updatePlayState({ playing: false, paused: false });

            if (reason === 'eof' && this._status.filePath) {
                this._emitEnd();
                this._status.filePath = null;
            }
            return;
        }

        if (msg.event !== 'property‑change') return;

        switch (msg.name) {
            case 'time‑pos': {
                const sec = Number(msg.data ?? 0);
                const currentTime = parseFloat(sec.toFixed(2));
                if (this._lastEmitTime < 0 || (currentTime - this._lastEmitTime) * 1000 > this.commonOptions.updateInterval) {
                    this._lastEmitTime = currentTime;
                    this._updateTime({ currentTime });
                }
                break;
            }
            case 'pause':
                this._updatePlayState({ paused: Boolean(msg.data) });
                break;
            case 'mute':
                this._updatePlayState({ muted: Boolean(msg.data) });
                break;
            case 'duration':
                this._updateTime({ duration: Number(msg.data ?? 0) });
                break;
            case 'idle‑active':
                if (msg.data && this._status.filePath) {
                    this._emitEnd();
                    this._status.filePath = null;
                }
                break;
        }
    }

    _cleanup() {
        if (this._socket) {
            this._socket.destroy();
            this._socket = null;
        }
        if (this._player && !this._player.killed) {
            this._player.kill('SIGKILL');
        }
        this._player = null;
        this._isConnected = false;
        this._commandQueue = [];
        this._resetStatus();
        this._lastEmitTime = -1;
        try {
            if (fs.existsSync(this._socketPath)) fs.unlinkSync(this._socketPath);
        } catch (e) {
        }
    }
}

module.exports = new MpvDriver();