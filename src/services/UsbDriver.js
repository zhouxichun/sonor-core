const EventEmitter = require('events');
const { execFile } = require('child_process');
const logger = require('../utils/logger')(__dirname);
class UsbDriver extends EventEmitter {
    static #EVENTS = {
        USB_FOUND: 'UsbDriver:usb_found',
        ERROR: 'UsbDriver:error'
    };
    #devices;
    #abortController;
    #timeoutId = null;
    #options = {
        scanInterval: 2000  // 2秒扫描一次
    }; 

    /**
     * @param {object} [options={}]
     */
    constructor(options = {}) {
        super();
        this.#devices = null;
        this.#abortController = new AbortController();
        this.#options = {...this.#options, ...options};
        logger.info('UsbDriver instance created');
    }
    
    async start(){
        logger.info('UsbDriver start()');
        this.#scheduleNextScan();
    }

    #scheduleNextScan() {
        if (!this.#abortController) return;
        this.#timeoutId = setTimeout(() => {
            this.#scanLoop();
        }, this.#options.scanInterval);
    }

    async #scanLoop() {
        logger.debug('UsbDriver loadDevices begin');
        try {
            await this.loadDevices();
        } catch (err) {
            this.#emitError('USB扫描异常', err);
        } finally {
            this.#scheduleNextScan();
        }
    }

    /**
     * 订阅USB发现事件
     * @param {Function} callback
     */
    onUsbFound(callback) { this.on(UsbDriver.#EVENTS.USB_FOUND, callback); }
    /**
     * 订阅错误事件
     * @param {Function} callback
     */
    onError(callback) { this.on(UsbDriver.#EVENTS.ERROR, callback); }
    /**
     * 加载USB挂载设备列表
     */
    async loadDevices() {
        const signal = this.#abortController?.signal;
        try {
            const out = await new Promise((res, rej) => {
                const child = execFile(
                    'lsblk',
                    ['-Jpo', 'NAME,TYPE,RM,MOUNTPOINT'],
                    { encoding: 'utf8', signal },
                    (err, stdout) => err ? rej(err) : res(stdout)
                );
                child.on('error', rej);
            });
            const json = JSON.parse(out);
            const newDevices = [];
            json.blockdevices.forEach(d => {
                if (d.type === 'disk' && d.children && d.name.startsWith('/dev/sd')) {
                    d.children
                        .filter(c => c.type === 'part')
                        .forEach(mt => {
                            if (mt.mountpoint) {
                                newDevices.push({
                                    title: mt.mountpoint,
                                    path: mt.mountpoint
                                });
                            }
                        });
                }
            });
            // 对比新旧列表，有变化才触发事件
            const oldStr = JSON.stringify(this.#devices);
            const newStr = JSON.stringify(newDevices);
            if(oldStr !== newStr){
                this.#devices = newDevices;
                logger.info(`UsbDriver detected usb mount points count:${this.#devices.length}, devices:${JSON.stringify(this.#devices)}`);
                this.emit(UsbDriver.#EVENTS.USB_FOUND, [...this.#devices]);
            }
        } catch (err) {
            this.#emitError('USB设备加载失败', err);
        }
    }
    #emitError(message, err) {
        logger.error(`${message}: ${err.message}`);
        this.emit(UsbDriver.#EVENTS.ERROR, { message, error: err });
    }
    /**
     * 销毁实例：清除timeout、终止子进程、清空状态、清除全部事件监听
     * 调用后实例不可复用
     */
    destroy() {
        logger.info('UsbDriver destroy()');
        // 清除timeout
        if(this.#timeoutId){
            clearTimeout(this.#timeoutId);
            this.#timeoutId = null;
            logger.debug('UsbDriver scan timeout cleared');
        }
        if (this.#abortController) {
            this.#abortController.abort();
            logger.debug('UsbDriver abortController aborted');
            this.#abortController = null;
        }
        this.removeAllListeners();
        this.#devices = null;
        logger.debug('UsbDriver destroy completed');
    }
}
module.exports = UsbDriver;
