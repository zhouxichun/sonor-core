const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const logger = require('../utils/logger')('MpvPlayer');


class MpvPlayer extends EventEmitter {
    // 对外事件常量
    static EVENTS = {
        CURRENTTIME_UPDATED: 'mpvplayer:currenttime_updated', // 播放进度更新
        END: 'mpvplayer:end',                       // 歌曲自然播放完毕 eof
        STOP: 'mpvplayer:stop',                     // 主动stop / loadfile replace切歌
        PAUSE_TOGGLE: 'mpvplayer:pause_toggle',     // 暂停/播放状态切换，参数为布尔isPaused
        MUTE_TOGGLE: 'mpvplayer:mute_toggle',       // 静音状态切换，参数为布尔isMute
        LOOP_TOGGLE: 'mpvplayer:loop_toggle',       // 
        VOLUME_UPDATED: 'mpvplayer:volume_updated',       
        PLAY: 'mpvplayer:play',                     // 曲目开始播放(playback‑restart)   
        ERROR: 'mpvplayer:error'                     // 错误事件（mpv进程异常退出等）
    };

    #mpv = null;                    // mpv子进程实例
    #socket = null;                 // IPC unix socket连接
    #isConnected = false;           // socket连接状态标记
    #commandQueue = [];             // 命令队列，未连接时缓存指令
    #lastEmitTime = -1;             // 上一次触发进度事件的时间，用于节流
    #updateInterval = 1000;         // 进度上报节流间隔(ms)
    #socketPath = null;             // mpv IPC socket文件路径
    #reconnectTimer = null;         // socket重连定时器
    #currentTimeSec = 0;            // 当前播放时间(秒)
    #volume ;                       // 音量值
    #mpvBuf = Buffer.alloc(0);      // mpv返回数据缓冲区，按换行分割json消息
    #destroying = false;            // 实例是否正在销毁（区分正常退出和崩溃）
    #observed = false;
    
    constructor(opts = {}) {
        super();
        // 按进程pid生成独立socket文件，避免多实例冲突
        this.#socketPath = path.join(os.tmpdir(), `mpv-ipc-${process.pid}.sock`);
        opts.updateInterval && (this.#updateInterval = opts.updateInterval);
        logger.info('instance created.');
    }

    // 事件订阅绑定方法
    onPlay(callback) { return this.on(MpvPlayer.EVENTS.PLAY, callback);}
    onEnd(callback) { return this.on(MpvPlayer.EVENTS.END, callback); }
    onStop(callback) { return this.on(MpvPlayer.EVENTS.STOP, callback); }
    onPauseToggle(callback) { return this.on(MpvPlayer.EVENTS.PAUSE_TOGGLE, callback); }
    onMuteToggle(callback) { return this.on(MpvPlayer.EVENTS.MUTE_TOGGLE, callback); }
    onLoopToggle(callback) { return this.on(MpvPlayer.EVENTS.LOOP_TOGGLE, callback); }
    onVolumeUpdate(callback){  return this.on(MpvPlayer.EVENTS.VOLUME_UPDATED, callback); }
    onCurrentTimeUpdated(callback) { return this.on(MpvPlayer.EVENTS.CURRENTTIME_UPDATED, callback); }
    onError(callback) { return this.on(MpvPlayer.EVENTS.ERROR, callback); }

    /**
     * 初始化，拉起mpv进程
     * @param {number} [volume=60] 初始音量
     * @param {boolean} [loop=false] 是否循环
     */
    init(volume =80) {
        logger.info('init, spawn mpv process');
        this.#volume = Math.max(0, Math.min(volume, 100));
        this.#spawn();
    }
    /**
     * 设置音量
     * @param {number} volume 0~100
     */
    setVolume(volume) {
        this.#volume = Math.max(0, Math.min(volume, 100));
        logger.debug('set volume:', this.#volume);
        this.#sendCommand(['set_property', 'volume', this.#volume]);
        this.#sendCommand(["set_property", "mute", false]);
    }
    /**
     * 设置循环
     * @param {boolean} enable
     */
    setLoop(enable) {
        this.#sendCommand(['set_property', 'loop-file', enable ? 'inf' : 'no']);
    }
    /**
     * 加载音频文件并播放
     * @param {string} audioFile 文件绝对路径
     * @returns {this}
     */
    play(audioFilepath) {
        if (!audioFilepath) throw new Error('audioFilepath muse be set');

        if (!this.#isConnected) {
            logger.warn('ipc not connected, skip play', audioFilepath);
            return;
        }
        this.#lastEmitTime = -1;
        this.#currentTimeSec = 0;
        logger.info('loadfile:', audioFilepath);
        this.#sendCommand(['loadfile', audioFilepath, 'replace']);
        this.#sendCommand(['set_property', "pause", false]);
    }
    /**
     * 停止播放
     */
    stop() {
        this.#currentTimeSec = 0;
        this.#sendCommand(['stop']);
    }
    /**
     * 跳转到指定播放位置
     * @param {number} pos 秒数
     */
    seek(pos) {
        this.#sendCommand(['seek', Math.max(pos, 0), 'absolute']);
        this.#sendCommand(['set_property', "pause", false]);
    }
    /**
     * 切换暂停/播放
     */
    togglePause() { this.#sendCommand(["cycle", "pause"]); }
    /**
     * 切换静音
     */
    toggleMute() { this.#sendCommand(["cycle", "mute"]); }
    /**
     * 销毁实例，关闭mpv进程、socket连接，清理资源
     */
    async destroy() {
        if(this.#destroying) return;
        logger.info('destroy begin');
        this.#destroying = true;    
        this.removeAllListeners();
        this.#sendCommand(['quit']);
        await new Promise(resolve => setTimeout(resolve, 200));
        this.#cleanup();
        logger.info('destroy done');
    }
     /**
     * 新建mpv子进程，拉起mpv并监听退出事件
     */
    #spawn() {
        this.#cleanup();
        this.#destroying = false; 
        this.#mpv = spawn('mpv', [
            '--no-video', '--no-terminal', '--idle=yes',
            `--volume=${this.#volume}`,
            `--input-ipc-server=${this.#socketPath}`
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        // 捕获mpv stderr日志
        this.#mpv.stderr.on('data', d => logger.debug(d.toString('utf8')));

        // mpv进程退出回调
        this.#mpv.on('exit', (code, signal) => {
            logger.warn(`mpv process exit, code=${code}, signal=${signal}`);
            this.#cleanup();
            // 非主动销毁才抛出ERROR事件
            if (!this.#destroying && signal !== 'SIGINT') {
                this.emit(MpvPlayer.EVENTS.ERROR, { code, signal });
            }
        });
        // 启动后尝试连接IPC socket
        this.#connectSocket();
    }

    /**
     * 建立/重连mpv IPC unix socket
     * 限制：仅#pmpv存在、非销毁状态才会重试
     */
    #connectSocket() {
        if (this.#destroying || !this.#mpv) return;

        // socket文件尚未生成，延时重试
        if (!fs.existsSync(this.#socketPath)) {
            logger.debug('ipc socket not exist, retry later');
            if (!this.#reconnectTimer) {
                this.#reconnectTimer = setTimeout(() => {
                    this.#reconnectTimer = null;
                    this.#connectSocket();
                }, 100);
            }
            return;
        }

        logger.info(`connecting to ipc socket`);
        this.#socket = net.createConnection(this.#socketPath);

        // socket连接成功
        this.#socket.on('connect', () => {
            this.#isConnected = true;
            logger.info('ipc connected');
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
                } catch (e) { }
            }
        });

        // socket底层错误
        this.#socket.on('error', err => logger.warn(`socket error: ${err.message}`));

        // socket连接断开，触发重连（mpv存活才会重试）
        this.#socket.on('end', () => {
            logger.warn('socket disconnected');
            this.#isConnected = false;
            if (this.#destroying) return;
            if (!this.#reconnectTimer) {
                logger.info('ipc socket died, schedule reconnect 1000ms');
                this.#reconnectTimer = setTimeout(() => {
                    this.#reconnectTimer = null;
                    this.#connectSocket();
                }, 1000);
            }
        });
    }

    /**
     * 注册mpv属性监听，用于接收进度、暂停、音量等状态变更
     */
    #setupObservations() {
        if(this.#observed) return;
        this.#observed = true;
        logger.debug('setup mpv process property observe');
        this.#sendCommand(['observe_property', 0, 'time-pos']);
        this.#sendCommand(['observe_property', 1, 'pause']);
        this.#sendCommand(['observe_property', 2, 'mute']);
        this.#sendCommand(['observe_property', 3, 'volume']);
        this.#sendCommand(['observe_property', 4, 'loop-file']);
    }

    /**
     * 连接成功后，一次性把队列里缓存的命令全部发送
     */
    #flushQueue() {
        logger.info(`flush command queue, pending count ${this.#commandQueue.length}`);
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
        if(!msg || !msg.event) return;
        //logger.debug('ipc event', msg);
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
                    default:
                        this.emit(MpvPlayer.EVENTS.STOP);
                        break;
                }
                break;
            case 'property-change':
                switch (msg.name) {
                    case 'time-pos':
                        this.#updateCurrentTime(msg.data);
                        break;
                    case 'pause': {
                        this.emit(MpvPlayer.EVENTS.PAUSE_TOGGLE, !!msg.data);
                        break;
                    }
                    case 'mute': {
                        this.emit(MpvPlayer.EVENTS.MUTE_TOGGLE, !!msg.data);
                        break;
                    }
                    case 'volume':
                        this.#volume = msg.data;
                        this.emit(MpvPlayer.EVENTS.VOLUME_UPDATED, this.#volume);
                        break;
                    case 'loop-file':
                        this.emit(MpvPlayer.EVENTS.LOOP_TOGGLE, !!msg.data );
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
     * 更新播放进度，节流控制上报频率
     * @param {number} data time-pos 数值(秒)
     */
    #updateCurrentTime(data) {
        const sec = data == null ? 0 : parseFloat((data || 0).toFixed(2));
        this.#currentTimeSec = sec;
        const needEmit = sec < this.#lastEmitTime || (this.#lastEmitTime < 0 || (sec - this.#lastEmitTime) * 1000 > this.#updateInterval);
        if (needEmit) {
            this.#lastEmitTime = sec;
            this.emit(MpvPlayer.EVENTS.CURRENTTIME_UPDATED, this.#currentTimeSec);
        }
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
                logger.debug('send cmd to mpv process:', command);
            } catch (e) {
                logger.warn('command send failed, push to queue', command, e);
                this.#commandQueue.push(command);
            }
        } else {
            logger.debug('ipc not ready, push to queue', command);
            this.#commandQueue.push(command);
        }
    }

    
    /**
     * 资源清理：关闭socket、终止mpv进程、清空定时器、重置状态
     */
    #cleanup() {
        logger.debug('cleanup');
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
            logger.debug('remove socket file failed', e);
        }

        // 杀死残留mpv子进程
        if (this.#mpv && !this.#mpv.killed) {
            logger.info('kill mpv process');
            this.#mpv.kill('SIGKILL');
        }

        // 重置所有状态标记与缓存
        this.#mpv = null;
        this.#isConnected = false;
        this.#commandQueue = [];
        this.#currentTimeSec = 0;
    }
}

module.exports = MpvPlayer;
