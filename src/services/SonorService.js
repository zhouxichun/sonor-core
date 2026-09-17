// src/services/SonorService.js
const { EventEmitter } = require('events');
const fsSync = require('fs');
const path = require('path');
const logger = require('../utils/logger')('SonorService');

class SonorService extends EventEmitter {
    #dataPath;
    static #dataDirInitialized = false;

    constructor() {
        super();
        this.#dataPath = path.join(__dirname, '../../data');
        if (!SonorService.#dataDirInitialized) {
            fsSync.mkdirSync(this.#dataPath, { recursive: true });
            logger.info(`data directory: ${this.#dataPath}`);
            SonorService.#dataDirInitialized = true;
        }
    }

    get dataPath() { return this.#dataPath; }
    /**
     * 服务启动，子类重写实现初始化逻辑
     */
    start() {}
    /**
     * 服务销毁：清除全部事件监听，子类可扩展释放资源
     */
    destroy() {}
}

module.exports = SonorService;
