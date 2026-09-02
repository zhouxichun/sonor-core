const EventEmitter = require('events');
const { execFile } = require('child_process');

class UsbDriver extends EventEmitter {
    static #EVENTS = {
        USB_FOUND: 'UsbDriver:usb_found',
        ERROR: 'UsbDriver:error'
    };

    #devices;
    #options;
    #abortController;

    /**
     * @param {object} [options={}]
     */
    constructor(options = {}) {
        super();
        this.#devices = null;
        this.#options = { ...options };
        this.#abortController = new AbortController();
    }

    async start(){
        await this.loadDevices();
    }

    /**
     * 订阅USB发现事件
     * @param {Function} callback
     */
    onUsbFound(callback) {
        this.on(UsbDriver.#EVENTS.USB_FOUND, callback);
    }

    /**
     * 订阅错误事件
     * @param {Function} callback
     */
    onError(callback) {
        this.on(UsbDriver.#EVENTS.ERROR, callback);
    }

    /**
     * 加载USB挂载设备列表
     */
    async loadDevices() {
        this.#devices = [];
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
            json.blockdevices.forEach(d => {
                if (d.type === 'disk' && d.children && d.name.startsWith('/dev/sd')) {
                    d.children
                        .filter(c => c.type === 'part')
                        .forEach(mt => {
                            if (mt.mountpoint) {
                                this.#devices.push({
                                    title: mt.mountpoint,
                                    path: mt.mountpoint
                                });
                            }
                        });
                }
            });
            this.emit(UsbDriver.#EVENTS.USB_FOUND, [...this.#devices]);
        } catch (err) {
            this.#emitError('USB设备加载失败', err);
        }
    }

    #emitError(message, err) {
        console.error(message, err);
        this.emit(UsbDriver.#EVENTS.ERROR, { message, error: err });
    }

    /**
     * 销毁实例：终止子进程、清空状态、清除全部事件监听
     * 调用后实例不可复用
     */
    destroy() {
        if (this.#abortController) {
            this.#abortController.abort();
            this.#abortController = null;
        }
        this.removeAllListeners();
        this.#devices = null;
        this.#options = {};
    }
}

module.exports = UsbDriver;
