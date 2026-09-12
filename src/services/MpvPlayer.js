const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const logger = require('../utils/logger')(__dirname);

/**
 * mpv播放器IPC封装类
 * 特性：
 * 1. 通过unix socket与mpv IPC通信
 * 2. socket断开自动重连（仅mpv进程存活时）
 * 3. mpv进程退出，停止socket重连并抛出ERROR事件，不会自动重启mpv
 * 4. 支持播放、暂停、切歌、音量、跳转等基础播放控制
 */
class MpvPlayer extends EventEmitter {
    // 对外事件常量
    static EVENTS = {
        PLAY: 'mpvplayer:play',                 // 曲目开始播放(playback‑restart)
        CURRENTTIME_UPDATED: 'mpvplayer:currenttime_updated', // 播放进度更新
        END: 'mpvplayer:end',                   // 歌曲自然播放完毕 eof
        STOP: 'mpvplayer:stop',                 // 主动stop / loadfile replace切歌
        PAUSE_TOGGLE: 'mpvplayer:pause_toggle', // 暂停/播放状态切换，参数为布尔isPaused
        MUTE_TOGGLE: 'mpvplayer:mute_toggle',   // 静音状态切换，参数为布尔isMute
        ERROR: 'mpvplayer:error'                // 错误事件（mpv进程异常退出等）
    };

    #player = null;                 // mpv子进程实例
    #socket = null;                 // IPC unix socket连接
    #isConnected = false;           // socket连接状态标记
    #commandQueue = [];             // 命令队列，未连接时缓存指令
    #lastEmitTime = -1;             // 上一次触发进度事件的时间，用于节流
    #socketPath;                    // mpv IPC socket文件路径
    #reconnectTimer = null;         // socket重连定时器
    #updateInterval;                // 进度上报节流间隔(ms)
    #currentTimeSec = 0;            // 当前播放时间(秒)
    #volume = 80;                   // 缓存音量值
    #loop = 'no';                   // 缓存loop配置
    #mpvBuf = Buffer.alloc(0);      // mpv返回数据缓冲区，按换行分割json消息
    #isDestroying = false;          // 实例是否正在销毁（区分正常退出和崩溃）

    constructor(opts = {}) {
        super();
        // 按进程pid生成独立socket文件，避免多实例冲突
        this.#socketPath = path.join(os.tmpdir(), `mpv-ipc-${process.pid}.sock`);
        console.log(this.#socketPath);
        this.#updateInterval = opts.updateInterval ?? 1000;
        logger.info(`MpvPlayer instance created.`);
    }

    /**
     * 初始化，拉起mpv进程
     * @param {number} [volume=60] 初始音量
     * @param {boolean} [loop=false] 是否循环
     */
    init(volume = 60, loop = false) {
        logger.info('MpvPlayer init, spawn mpv process');
        this.#volume = Math.max(0, Math.min(volume, 100));
        this.#loop = loop ? 'inf' : 'no';
        this.#spawn();
    }

    /**
     * 设置音量
     * @param {number} volume 0~100
     */
    setVolume(volume) {
        logger.debug(`MpvPlayer setVolume ${volume}`);
        this.#volume = Math.max(0, Math.min(volume, 100));
        this.#sendCommand(['set_property', 'volume', this.#volume]);
        this.#sendCommand(["set_property", "mute", false]);
    }

    /**
     * 设置循环播放
     * @param {boolean} enable
     */
    setLoop(enable) {
        logger.debug(`MpvPlayer setLoop ${enable}`);
        this.#loop = enable ? 'inf' : 'no';
        this.#sendCommand(['set_property', 'loop', this.#loop]);
    }

    /**
     * 加载音频文件并播放
     * @param {string} audioFile 文件绝对路径
     * @returns {this}
     */
    play(audioFile) {
        if (!audioFile) {
            logger.warn('MpvPlayer play called with empty audioFile');
            return this;
        }
        if (!this.#isConnected) {
            logger.warn(`MpvPlayer play skip, ipc not connected ${audioFile}`);
            return this;
        }
        this.#lastEmitTime = -1;
        this.#currentTimeSec = 0;
        logger.info(`MpvPlayer loadfile play ${audioFile}`);
        this.#sendCommand(['loadfile', audioFile, 'replace']);
        this.#sendCommand(['set_property', "pause", false]);
        return this;
    }

    /**
     * 停止播放
     */
    stop() {
        logger.info('MpvPlayer stop');
        this.#currentTimeSec = 0;
        this.#sendCommand(['stop']);
    }

    /**
     * 跳转到指定播放位置
     * @param {number} pos 秒数
     */
    seek(pos) {
        logger.debug(`MpvPlayer seek absolute ${pos}`);
        this.#sendCommand(['seek', Math.max(pos, 0), 'absolute']);
        this.#sendCommand(['set_property', "pause", false]);
    }

    /**
     * 切换暂停/播放
     */
    togglePause() {
        logger.debug('MpvPlayer togglePause');
        this.#sendCommand(["cycle", "pause"]);
    }

    /**
     * 切换静音
     */
    toggleMute() {
        logger.debug('MpvPlayer toggleMute');
        this.#sendCommand(["cycle", "mute"]);
    }

    /**
     * 销毁实例，关闭mpv进程、socket连接，清理资源
     */
    async destroy() {
        logger.info('MpvPlayer destroy begin');
        this.#isDestroying = true; // 标记主动销毁，崩溃事件不再触发ERROR
        this.removeAllListeners();
        this.#sendCommand(['quit']);
        await new Promise(resolve => setTimeout(resolve, 200));
        this.#cleanup();
        logger.info('MpvPlayer destroy done');
    }

    // 事件订阅绑定方法
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
    onSpectrum(callback) {
        return this.on('spectrum', callback);
    }

    /**
     * 更新播放进度，节流控制上报频率
     * @param {number} data time-pos 数值(秒)
     */
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

    /**
     * 新建mpv子进程，拉起mpv并监听退出事件
     */
    #spawn() {
        this.#cleanup();
        this.#isDestroying = false; // 重置销毁标记，新实例可用
        logger.info('MpvPlayer spawn mpv child process');
        this.#player = spawn('mpv', [
            '--no-video', '--no-terminal', '--idle=yes',
            `--volume=${this.#volume}`,
            `--loop=${this.#loop}`,
            `--input-ipc-server=${this.#socketPath}`
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        // 捕获mpv stderr日志
        this.#player.stderr.on('data', d => logger.debug(`[MPV stderr] ${d.toString().trim()}`));

        // mpv进程退出回调
        this.#player.on('exit', (code, signal) => {
            logger.warn(`MpvPlayer child process exit, code=${code}, signal=${signal}`);
            this.#cleanup();
            // 非主动销毁才抛出ERROR事件
            if (!this.#isDestroying) {
                this.emit(MpvPlayer.EVENTS.ERROR, { code, signal });
            }
        });

        // 启动后尝试连接IPC socket
        this.#connectSocket();
    }

    /**
     * 建立/重连mpv IPC unix socket
     * 限制：仅#player存在、非销毁状态才会重试
     */
    #connectSocket() {
        // 实例正在销毁，直接终止连接
        if (this.#isDestroying) return;
        // mpv进程已经消失，停止socket重连
        if (!this.#player) return;

        // socket文件尚未生成，延时重试
        if (!fs.existsSync(this.#socketPath)) {
            logger.debug('MpvPlayer ipc socket not exist, retry later');
            if (!this.#reconnectTimer) {
                this.#reconnectTimer = setTimeout(() => {
                    this.#reconnectTimer = null;
                    this.#connectSocket();
                }, 50);
            }
            return;
        }

        logger.info(`MpvPlayer connecting to ipc socket`);
        this.#socket = net.createConnection(this.#socketPath);

        // socket连接成功
        this.#socket.on('connect', () => {
            this.#isConnected = true;
            logger.info('IPC Connected');
            this.#setupObservations();
            this.#flushQueue();
        });

        // 接收mpv返回的IPC消息，按换行分割JSON
        this.#socket.on('data', chunk => {
            this.#mpvBuf = Buffer.concat([this.#mpvBuf, chunk]);
            let nlIndex;
            // 循环取出每一行（0x0a = \n）
            while ((nlIndex = this.#mpvBuf.indexOf(0x0a)) !== -1) {
                const line = this.#mpvBuf.slice(0, nlIndex).toString('utf8');
                this.#mpvBuf = this.#mpvBuf.slice(nlIndex + 1);
                try {
                    const msg = JSON.parse(line);
                    this.#handleMessage(msg);
                } catch (e) {
                    // JSON解析失败直接丢弃本条消息
                }
            }
        });

        // socket底层错误
        this.#socket.on('error', err => logger.warn(`Socket error: ${err.message}`));

        // socket连接断开，触发重连（mpv存活才会重试）
        this.#socket.on('end', () => {
            logger.warn('Socket disconnected');
            this.#isConnected = false;
            if (this.#isDestroying) return;
            if (!this.#reconnectTimer) {
                logger.info('MpvPlayer ipc socket died, schedule reconnect 1000ms');
                this.#reconnectTimer = setTimeout(() => {
                    this.#reconnectTimer = null;
                    this.#connectSocket();
                }, 1000);
            }
        });
    }

    /**
     * 发送IPC命令给mpv，未连接时推入队列缓存
     * @param {Array} command mpv IPC命令数组
     */
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

    /**
     * 注册mpv属性监听，用于接收进度、暂停、音量等状态变更
     */
    #setupObservations() {
        logger.debug('MpvPlayer setup property observe');
        this.#sendCommand(['observe_property', 0, 'time-pos']);
        this.#sendCommand(['observe_property', 1, 'pause']);
        this.#sendCommand(['observe_property', 2, 'mute']);
        this.#sendCommand(['observe_property', 3, 'volume']);
        this.#sendCommand(['observe_property', 4, 'loop']);
    }

    /**
     * 连接成功后，一次性把队列里缓存的命令全部发送
     */
    #flushQueue() {
        logger.info(`MpvPlayer flush command queue, pending count ${this.#commandQueue.length}`);
        while (this.#commandQueue.length > 0) {
            const cmd = this.#commandQueue.shift();
            this.#sendCommand(cmd);
        }
    }

    /**
     * 处理mpv推送过来的IPC事件消息
     * @param {object} msg mpv IPC json对象
     */
    #handleMessage(msg) {
        logger.debug(`MpvPlayer ipc event ${msg.event ?? 'property-change'}`);
        switch (msg.event) {
            case 'playback-restart':
                this.emit(MpvPlayer.EVENTS.PLAY);
                break;
            case 'end-file':
                switch (msg.reason) {
                    case 'eof':
                        this.emit(MpvPlayer.EVENTS.END);
                        break;
                    case 'stop':
                        this.emit(MpvPlayer.EVENTS.STOP);
                        break;
                    default:
                        break;
                }
                break;
            case 'property-change':
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
                    case 'volume':
                        this.#volume = msg.data;
                        break;
                    case 'loop':
                        this.#loop = msg.data;
                        break;
                    default:
                        break;
                }
                break;
            default:
                break;
        }
    }

    /**
     * 资源清理：关闭socket、终止mpv进程、清空定时器、重置状态
     */
    #cleanup() {
        logger.debug('MpvPlayer cleanup');
        // 清除待执行的重连定时器，防止内存泄漏
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }

        // 销毁socket连接
        if (this.#socket) {
            this.#socket.destroy();
            this.#socket = null;
        }

        // 删除unix socket文件
        try {
            if (fs.existsSync(this.#socketPath)) fs.unlinkSync(this.#socketPath);
        } catch (e) {
            logger.debug(`MpvPlayer remove socket file fail ${e.message}`);
        }

        // 杀死残留mpv子进程
        if (this.#player && !this.#player.killed) {
            logger.info('MpvPlayer kill child mpv process');
            this.#player.kill('SIGKILL');
        }

        // 重置所有状态标记与缓存
        this.#player = null;
        this.#isConnected = false;
        this.#commandQueue = [];
        this.#currentTimeSec = 0;
    }
}

module.exports = MpvPlayer;
