const net = require('net');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const SonorService = require('./SonorService');
const { throws } = require('assert');
const logger = require('../utils/logger')('PlayerService');

class PlayerService extends SonorService {
   static EVENTS = {
        PLAYER_STATUS: 'player:status',
        END_FILE:'player:endfile',
        TIME_UPDATED: 'player:time_updated',
    };

    #dataFile;
    #mpv = null;                    // mpv子进程实例
    #socket = null;                 // IPC unix socket连接
    #isConnected = false;           // socket连接状态标记
    #commandQueue = [];             // 命令队列，未连接时缓存指令
    #lastEmitTime = -1;             // 上一次触发进度事件的时间，用于节流
    #updateInterval = 1000;         // 进度上报节流间隔(ms)
    #socketPath = null;             // mpv IPC socket文件路径
    #reconnectTimer = null;         // socket重连定时器
    #currentTimeSec = 0;            // 当前播放时间(秒)
    #mpvBuf = Buffer.alloc(0);      // mpv返回数据缓冲区，按换行分割json消息
    #playerStatus = {
        playing: false,
        paused: false,              
        volume: 60,
        loop: false,
        muted: false,
        playerError: false
    };
    #destroying = false;            // 实例是否正在销毁（区分正常退出和崩溃）
    #observed = false;

    constructor(opts={}) {
        super();
        this.#dataFile = path.join(this.dataPath, 'player.json');
        // 按进程pid生成独立socket文件，避免多实例冲突
        this.#socketPath = path.join(os.tmpdir(), `mpv-ipc-${process.pid}.sock`);
        opts.updateInterval && (this.#updateInterval = opts.updateInterval);
        logger.info('instance created. dataFile:', this.#dataFile);
    }

    // 事件订阅绑定方法
    onPlayerStatusUpdated(callback) { return this.on(PlayerService.EVENTS.PLAYER_STATUS, callback); }
    offPlayerStatusUpdated(callback) { return this.off(PlayerService.EVENTS.PLAYER_STATUS, callback); }

    onEndFile(callback) { return this.on(PlayerService.EVENTS.END_FILE, callback); }
    offEndFile(callback) { return this.off(PlayerService.EVENTS.END_FILE, callback); }

    onTimeUpdated(callback) { return this.on(PlayerService.EVENTS.TIME_UPDATED, callback); }
    offTimeUpdated(callback) { return this.off(PlayerService.EVENTS.TIME_UPDATED, callback); }

    getPlayerStatus(){ return {...this.#playerStatus}; }

    /**
     * 初始化，拉起mpv进程
     * @param {number} [volume=60] 初始音量
     * @param {boolean} [loop=false] 是否循环
     */
    start() {
        this.#loadData();
        this.#spawn();
        logger.info('service started');
    }
    /**
     * 销毁实例，关闭mpv进程、socket连接，清理资源
     */
    destroy() {
        if (this.#destroying) return;
        logger.info('saving data before destroy')
        this.#saveData().catch(err => { logger.error('destroy: saveData failed', err);});
        this.#destroying = true;
        this.#cleanup();
        logger.info('destroy done');
    }

    /**
     * 加载音频文件并播放
     * @param {string} audioFile 文件绝对路径
     * @returns {this}
     */
    playback(audioFilepath) {
        if (!audioFilepath) throw new Error('audioFilepath must be set');
        this.#lastEmitTime = -1;
        this.#sendCommand([['loadfile', audioFilepath, 'replace'],['set_property', "pause", false]]);
        logger.info('loadfile:', audioFilepath);
    }

    stop() { this.#sendCommand(['stop']); }

    seek(pos) { this.#sendCommand([['seek', Math.max(pos, 0), 'absolute'],['set_property', "pause", false]]); }

    togglePause() { this.#sendCommand(["cycle", "pause"]); }

    toggleMute() { this.#sendCommand(["cycle", "mute"]); }

    setVolume(volume) { this.#sendCommand([['set_property', 'volume', volume],["set_property", "mute", false]]);}

    toggleLoop() { this.#sendCommand(['set_property', 'loop-file', this.#playerStatus.loop ? 'no' : 'inf']); }

    #loadData() {
        if(!fsSync.existsSync(this.#dataFile)) {
            logger.warn('data file not exist, skip load.', this.#dataFile);
            return;
        }
        try {
            const json = JSON.parse(fsSync.readFileSync(this.#dataFile, 'utf8'));
            Object.assign(this.#playerStatus, json, { playing: false, playerError: false });
            logger.info('load persisted data success');
        } catch (err) { logger.error('persisted data load failed:', err); }
    }
    
    async #saveData() {
        if (!this.#dataFile) return;
        try {
            await fs.writeFile(this.#dataFile, JSON.stringify(this.#playerStatus, null, 2), 'utf8');
            logger.info('save persisted data success');
        } catch (err) { logger.warn('save persisted data failed', err); }
    }
    
    #spawn() {
        this.#cleanup();
        this.#destroying = false; 
        this.#mpv = spawn('mpv', [
            '--no-video', '--no-terminal', '--idle=yes',
            `--volume=${this.#playerStatus.volume}`,
            `--input-ipc-server=${this.#socketPath}`], 
            { stdio: ['ignore', 'ignore', 'pipe'] });

        this.#mpv.stderr.on('data', d => logger.debug(d.toString('utf8')));

        this.#mpv.on('exit', (code, signal) => {
            logger.info(`mpv process exit, code=${code}, signal=${signal}`);
            if (!this.#destroying && signal !== 'SIGINT') {
                this.emit(PlayerService.EVENTS.ERROR, { code, signal });
            }
        });

        this.#connectSocket();
        logger.info('spawn mpv process');
    }

     /**
     * 资源清理：关闭socket、终止mpv进程、清空定时器、重置状态
     */
    #cleanup() {
        logger.debug('clean up');
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
            if (fsSync.existsSync(this.#socketPath)) fsSync.unlinkSync(this.#socketPath); 
        } catch (e) { logger.debug('remove socket file failed', e); }

        if (this.#mpv && !this.#mpv.killed) {
            logger.info('kill mpv process');
            this.#mpv.kill('SIGKILL');
        }

        this.#mpv = null;
        this.#isConnected = false;
        this.#commandQueue = [];
        this.#currentTimeSec = 0;
    }
    
    /**
     * 建立/重连mpv IPC unix socket
     * 限制：仅#pmpv存在、非销毁状态才会重试
     */
    #connectSocket() {
        if (this.#destroying || !this.#mpv) return;

        // socket文件尚未生成，延时重试
        if (!fsSync.existsSync(this.#socketPath)) {
            logger.debug('ipc socket not exist, retry later');
            if (!this.#reconnectTimer) {
                this.#reconnectTimer = setTimeout(() => {
                    this.#reconnectTimer = null;
                    this.#connectSocket();
                }, 100);
            }
            return;
        }

        logger.debug('connecting to mpv ipc socket');
        this.#socket = net.createConnection(this.#socketPath);

        // socket连接成功
        this.#socket.on('connect', () => {
            this.#isConnected = true;
            logger.info('mpv ipc socket connected');
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
                    this.#handleMessage(JSON.parse(line));
                } catch (e) { }
            }
        });

        // socket底层错误
        this.#socket.on('error', err => logger.warn(`socket error: ${err.message}`));

        // socket连接断开，触发重连
        this.#socket.on('end', () => {
            logger.info('mpv ipc socket disconnected');
            this.#isConnected = false;
            if (!this.#reconnectTimer && this.#mpv) {
                logger.info('mpv ipc socket died, schedule reconnect 1000ms');
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
        this.#sendCommand([['observe_property', 0, 'time-pos'],
            ['observe_property', 1, 'pause'],
            ['observe_property', 2, 'mute'],
            ['observe_property', 3, 'volume'],
            ['observe_property', 4, 'loop-file']]);
        //this.#sendCommand(['observe_property', 5, 'audio-device-list']);
    }

    /**
     * 发送IPC命令给mpv，未连接时推入队列缓存
     * @param {Array} command mpv IPC命令数组
     */
    #sendCommand(command) {
        let payload = '';
        if (Array.isArray(command) && Array.isArray(command[0])) {
            payload = command.map(c => JSON.stringify({ command: c }) + '\n').join('');
        } else {
            payload = JSON.stringify({ command }) + '\n';
        }
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
        logger.debug('ipc event', msg);
        switch (msg.event) {
            case 'playback-restart':
                this.#updatePlayerState({playing: true, paused: false, playerError: false}); break;
            case 'end-file':
                this.#updatePlayerState({playing: false, paused: false}); (msg.reason === 'eof') && this.emit(PlayerService.EVENTS.END_FILE); break;
            case 'property-change':
                switch (msg.name) {
                    case 'time-pos':
                        this.#updateCurrentTime(msg.data); break;
                    case 'pause': 
                        this.#updatePlayerState({paused: !!msg.data}); break;
                    case 'mute':                         
                        this.#updatePlayerState({muted: !!msg.data}); break;
                    case 'volume':
                        this.#updatePlayerState({volume: msg.data}); break;
                    case 'loop-file':
                        this.#updatePlayerState({loop: !!msg.data}); break;
                    default:
                        break;
                }
                break;
            default:
                break;
        }
    }

    #updatePlayerState(obj={}){
        Object.assign(this.#playerStatus, obj);
        this.emit(PlayerService.EVENTS.PLAYER_STATUS, this.#playerStatus);
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
            this.emit(PlayerService.EVENTS.TIME_UPDATED, this.#currentTimeSec);
        }
    }
}

module.exports = PlayerService;
