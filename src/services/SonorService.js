// src/services/SonorService.js
const { EventEmitter } = require('events');
const fsSync = require('fs');

/**
 * Sonor 所有业务服务基类
 * 约定生命周期：
 *  await service.start()  //初始化、加载数据
 *  await service.destroy() //停止、释放资源、清除事件监听
 */
class SonorService extends EventEmitter {
    static EVENTS = {
        NOTIFICATION: 'sonorService:notification'
    };
    #dataPath;

    /**
     * @param {Object} opts
     * @param {string} opts.dataPath 服务数据根目录
     */
    constructor(opts) {
        super();
        if (!opts?.dataPath) { throw new Error(`${this.constructor.name}: opts.dataPath is required`); }
        this.#dataPath = opts.dataPath;
        if (!fsSync.existsSync(this.#dataPath)) {
            throw new Error(`${this.constructor.name}: dataPath "${this.#dataPath}" does not exist`);
        }
    }

    /**
     * 对外注册通知回调
     * @param {Function} callback
     */
    onNotification(callback) { return this.on(SonorService.EVENTS.NOTIFICATION, callback); }
    /**
     * 解绑通知回调
     * @param {Function} callback
     */
    offNotification(callback) { return this.off(SonorService.EVENTS.NOTIFICATION, callback); }
    /**
     * @param {string} message
     * @param {string} [title]
     * @param {'info'|'warn'|'error'|'success'} [level='info']
     */
    notify(message, level = 'info') {
        this.emit(SonorService.EVENTS.NOTIFICATION, {
            level,
            message,
            timestamp: Date.now()
        });
    }

    
    get dataPath() { return this.#dataPath; }

    /**
     * 服务启动，子类重写实现初始化逻辑
     */
    async start() {}

    /**
     * 服务销毁：清除全部事件监听，子类可扩展释放资源
     */
    async destroy() { this.removeAllListeners(); }
}

module.exports = SonorService;
