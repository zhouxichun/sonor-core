const EventEmitter = require('events');
const fs = require('fs');

/**
 * 播放器驱动抽象基类
 * 状态由基类统一管理；事件推送；GetStatus基类实现，返回内存快照
 * 模板方法：子类实现 _onDestroy() 做底层资源释放
 */
class BaseDriver extends EventEmitter {
    static EVENTS = {
        PLAYSTATE_UPDATED: 'driver:playstate_updated',
        CURRENTTIME_UPDATED: 'driver:currenttime_updated',
        END: 'driver:end',
        ERROR: 'driver:error'
    };

    constructor() {
        super();
        //currentTime更新事件间隔
        this.updateInterval = 1000;

        /**
         * 标准状态对象，唯一数据源，子类只修改此对象
         * @type {{playing:boolean,paused:boolean,muted:boolean,currentTime:number,duration:number,filePath:string|null}}
         */
        this._status = {
            playing: false,
            paused: false,
            muted: false,
            currentTime: 0,
            duration: 0,
            filePath: null
        };
    }

    // ========== 对外公开接口（契约，子类实现） ==========
    /**
     * 加载并播放音频文件
     * @param {string} audioFile 绝对路径
     * @returns {this}
     */
    Play(audioFile) { return this; }

    /**
     * 暂停播放
     * @returns {this}
     */
    Pause() { return this; }

    /**
     * 停止播放，清空当前曲目
     * @returns {this}
     */
    Stop() { return this; }

    /**
     * 跳转，单位秒
     * @param {number} pos
     * @returns {this}
     */
    Seek(pos) { return this; }

    /**
     * 设置音量 0‑100
     * @param {number} vol
     * @returns {this}
     */
    SetVolume(vol) { return this; }

    /**
     * 切换静音
     * @returns {this}
     */
    Mute() { return this; }

    /**
     * 同步获取状态快照（纯内存，无IO）
     * @returns {{playing:boolean,paused:boolean,muted:boolean,currentTime:number,duration:number,filePath:string|null}}
     */
    GetStatus() {
        return { ...this._status };
    }

    /**
     * 销毁入口：基类做通用清理，子类实现 _onDestroy()
     */
    Destroy() {
        this.removeAllListeners();
        this._onDestroy();
    }

    // ========== 模板钩子，子类重写 ==========
    /**
     * 子类重写：释放进程、socket等底层资源
     * @protected
     */
    _onDestroy() {}

    // ========== 子类可调用保护工具方法 ==========
    /**
     * 校验文件路径：非空 + 文件存在。失败自动emitError
     * @param {string} filePath
     * @returns {boolean} true校验通过；false校验失败
     * @protected
     */
    _checkAudioFile(filePath) {
        if (!filePath || typeof filePath !== 'string') {
            this._emitError({ msg: '文件路径为空或非法', file: filePath });
            return false;
        }
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) {
                this._emitError({ msg: '路径不是有效文件', file: filePath });
                return false;
            }
        } catch (e) {
            this._emitError({ msg: '文件不存在或无法访问', file: filePath });
            return false;
        }
        return true;
    }
    /**
     * 重置全部状态到初始值
     * @protected
     */
    _resetStatus() {
        this._status = {
            playing: false,
            paused: false,
            muted: false,
            currentTime: 0,
            duration: 0,
            filePath: null
        };
    }

    /**
     * 更新播放状态，自动触发 PLAYSTATE_UPDATED
     * @param {Partial<{playing:boolean,paused:boolean,muted:boolean}>} partial
     * @protected
     */
    _updatePlayState(partial) {
        this._status = { ...this._status, ...partial };
        this.emit(BaseDriver.EVENTS.PLAYSTATE_UPDATED, {
            playing: this._status.playing,
            paused: this._status.paused,
            muted: this._status.muted
        });
    }

    /**
     * 更新时间信息，自动触发 CURRENTTIME_UPDATED
     * @param {Partial<{currentTime:number,duration:number}>} partial
     * @protected
     */
    _updateTime(partial) {
        this._status = { ...this._status, ...partial };
        this.emit(BaseDriver.EVENTS.CURRENTTIME_UPDATED, {
            currentTime: this._status.currentTime,
            duration: this._status.duration
        });
    }

    /**
     * 发射播放结束事件
     * @protected
     */
    _emitEnd() {
        this.emit(BaseDriver.EVENTS.END, this.GetStatus());
    }

    /**
     * 发射错误事件
     * @param {any} payload
     * @protected
     */
    _emitError(payload) {
        this.emit(BaseDriver.EVENTS.ERROR, payload);
    }

    /**
     * 音量钳位 0‑100
     * @param {number} vol
     * @returns {number}
     * @protected
     */
    _clampVolume(vol) {
        return Math.min(Math.max(Number(vol) || 0, 0), 100);
    }

    /**
     * seek 位置钳位 >=0
     * @param {number} pos
     * @returns {number}
     * @protected
     */
    _clampSeekPos(pos) {
        return Math.max(Number(pos) || 0, 0);
    }

    // ========== 事件监听包装 ==========
    onStateUpdated(callback) {
        return this.on(BaseDriver.EVENTS.PLAYSTATE_UPDATED, callback);
    }

    onCurrentTimeUpdated(callback) {
        return this.on(BaseDriver.EVENTS.CURRENTTIME_UPDATED, callback);
    }

    onEnd(callback) {
        return this.on(BaseDriver.EVENTS.END, callback);
    }

    onError(callback) {
        return this.on(BaseDriver.EVENTS.ERROR, callback);
    }
}

module.exports = BaseDriver;