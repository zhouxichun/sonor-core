const EventEmitter = require('events');
const { execFile } = require('child_process');

class UsbDriver extends EventEmitter {
    static EVENTS = {
        USB_FOUND: 'usb:found',
        ERROR: 'usb:error'
    };

    #_devToMountpoint;

    constructor() {
        super();
        this.#_devToMountpoint = new Map();
    }

    /**
     * @param {(list:Array<{devPath:string,mountpoint:string,fsType:string|null,size:string|null}>)=>void} callback
     */
    onUsbFound(callback) {
        return this.on(UsbDriver.EVENTS.USB_FOUND, callback);
    }

    async init() {
        await this.#_scanExistingUsb();
        console.log('✅ UsbDriver init done (boot‑time scan only)');
    }

    destroy() {
        this.#_devToMountpoint.clear();
        this.removeAllListeners();
    }

    #_emitError(message, err) {
        console.error('[UsbDriver]', message, err);
        this.emit(UsbDriver.EVENTS.ERROR, { message, error: err });
    }

    async #_scanExistingUsb() {
        try {
            const out = await new Promise((resolve, reject) => {
                execFile(
                    'lsblk',
                    ['-Jpo', 'NAME,TYPE,RM,MOUNTPOINT,SIZE,FSTYPE'],
                    { encoding: 'utf8' },
                    (err, stdout) => err ? reject(err) : resolve(stdout)
                );
            });
            const json = JSON.parse(out);

            /** @type {Array<{devPath:string,mountpoint:string,fsType:string|null,size:string|null}>} */
            const deviceList = [];

            json.blockdevices.forEach((disk) => {
                if (disk.type === 'disk' && disk.children && disk.name.startsWith('/dev/sd')) {
                    disk.children
                        .filter(child => child.type === 'part')
                        .forEach(part => {
                            if (!part.mountpoint) return;

                            const devPath = part.name;
                            const item = {
                                devPath,
                                mountpoint: part.mountpoint,
                                fsType: part.fstype || null,
                                size: part.size || null
                            };
                            this.#_devToMountpoint.set(devPath, part.mountpoint);
                            deviceList.push(item);
                        });
                }
            });

            // usb:found 返回全部设备数组
            this.emit(UsbDriver.EVENTS.USB_FOUND, deviceList);

        } catch (err) {
            this.#_emitError('启动扫描USB设备失败', err);
        }
    }
}

module.exports = new UsbDriver();
