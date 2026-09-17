const { execFile } = require('child_process');
const SonorService = require('./SonorService');
const logger = require('../utils/logger')('UsbService');

class UsbService extends SonorService {
    static EVENTS = {
        DEVICE_FOUND: 'usb:device_found',
        ERROR: 'usb:error'
    };
    #devices = [];
    #abortController;
    #timerScan = null;
    #options = {
        scanInterval: 2000 
    }; 

    /**
     * @param {object} [options={}]
     */
    constructor(opts={}) {
        super();
        this.#options = {...this.#options, ...opts};
        this.#abortController = new AbortController();
        logger.info('instance created');
    }
    
    async start(){
        this.#scheduleNextScan();
        logger.info('service started');
    }

    /**
     * 销毁实例：清除timeout、终止子进程、清空状态、清除全部事件监听
     * 调用后实例不可复用
     */
    destroy() {
        if(this.#timerScan){
            clearTimeout(this.#timerScan);
            this.#timerScan = null;
            logger.debug('scan timer cleared');
        }
        if (this.#abortController) {
            this.#abortController.abort();
            logger.debug('abortController aborted');
            this.#abortController = null;
        }
        this.#devices = null;
        logger.debug('destroy done');
    }
    
    #scheduleNextScan() {
        if (!this.#abortController) return;
        this.#timerScan = setTimeout(() => {
            this.#scanLoop();
        }, this.#options.scanInterval);
    }

    async #scanLoop() {
        try {
            await this.loadDevices();
        } catch (err) {
            logger.error('USB扫描异常', err);
        } finally {
            this.#scheduleNextScan();
        }
    }

    /**
     * 订阅USB发现事件
     * @param {Function} callback
     */
    onDeviceFound(callback) { this.on(UsbService.EVENTS.DEVICE_FOUND, callback); }
    offDeviceFound(callback) { this.off(UsbService.EVENTS.DEVICE_FOUND, callback); }

    getDevices(){ return [...this.#devices]; }

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
                this.emit(UsbService.EVENTS.DEVICE_FOUND, [...this.#devices]);
            }
        } catch (err) {
            logger.error('USB设备加载失败', err);
        }
    }

    
}
module.exports = UsbService;
