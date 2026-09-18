const { execFile } = require('child_process');
const SonorService = require('./SonorService');
const logger = require('../utils/logger')('UsbService');

class UsbService extends SonorService {
    static EVENTS = {
        DEVICE_ADD: 'usb:device_add',
        DEVICE_REMOVE: 'usb:device_remove',
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

    onDeviceAdded(callback) { this.on(UsbService.EVENTS.DEVICE_ADD, callback); }
    offDeviceAdded(callback) { this.off(UsbService.EVENTS.DEVICE_ADD, callback); }
    onDeviceRemoved(callback) { this.on(UsbService.EVENTS.DEVICE_REMOVE, callback); }
    offDeviceRemoved(callback) { this.off(UsbService.EVENTS.DEVICE_REMOVE, callback); }

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
            
            const oldDevices = [...this.#devices];
            const newIds = new Set(newDevices.map(d => d.id));
            const oldIds = new Set(oldDevices.map(d => d.id));

            const added = newDevices.filter(d => !oldIds.has(d.id));
            const removed = oldDevices.filter(d => !newIds.has(d.id));

            (added.length > 0) && this.emit(UsbService.EVENTS.DEVICE_ADD, added);
            (removed.length > 0) && this.emit(UsbService.EVENTS.DEVICE_REMOVE, removed);

            this.#devices = newDevices;

        } catch (err) {
            logger.error('USB设备加载失败', err);
        }
    }

    
}
module.exports = UsbService;
