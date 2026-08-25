// src/services/AudioLibraryService.js
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const AudioScanner = require('./AudioScanner');
const usbDriver = require('../drivers/UsbDriver');


class AudioLibraryService {
    #_audios;
    #_scannerInstances;
    #_autoScanUsb;
    #_storePath;
    #_started;


    /**
     * @param {Object} opts
     * @param {boolean} [opts.autoScanUsb=true] 是否自动扫描发现的U盘
     * @param {string} [opts.storePath] 持久化json路径
     */
    constructor(opts = {}) {
        this.#_audios = [];
        this.#_scannerInstances = new Map();
        this.#_autoScanUsb = opts.autoScanUsb ?? true;
        this.#_started = false;


        this.#_storePath = opts.storePath ?? path.join(process.cwd(), 'data', 'audio_library.json');
        const dir = path.dirname(this.#_storePath);
        if (!fsSync.existsSync(dir)) {
            fsSync.mkdirSync(dir, { recursive: true });
        }


        this.#_loadFromStore();


        // 绑定事件
        usbDriver.onUsbFound(async (deviceList) => {
            for (const dev of deviceList) {
                console.log('USB Driver found device:', dev);
                const folderPath = dev.mountpoint;
                if (this.#_autoScanUsb) {
                    await this.#_mountFolder(folderPath);
                }
            }
        });
    }


    /**
     * 启动服务，内部初始化usbDriver
     */
    async start() {
        if (this.#_started) return;
        await usbDriver.init();
        this.#_started = true;
    }


    #_loadFromStore() {
        this.#_audios = [];
        if (!fsSync.existsSync(this.#_storePath)) {
            return;
        }


        try {
            const buf = fsSync.readFileSync(this.#_storePath, 'utf-8');
            const parsed = JSON.parse(buf);
            this.#_audios = parsed.map(item => ({
                ...item,
                status: 'unmounted'
            }));
        } catch (e) {
            console.warn('AudioLibrary load failed, reset library', e.message);
            this.#_audios = [];
        }
    }


    #_saveLibrary() {
        try {
            const dump = this.#_audios.map(({ status, ...rest }) => rest);
            fsSync.writeFileSync(this.#_storePath, JSON.stringify(dump, null, 2));
        } catch (err) {
            console.error('AudioLibrary save error', err);
        }
    }


    #_findAudioItem(folderPath) {
        return this.#_audios.find(item => item.folder === folderPath) ?? null;
    }


    #_getMountedAudioItems() {
        return this.#_audios.filter(item => item.status === 'mounted');
    }


    #_flattenTrackList() {
        const list = [];
        for (const item of this.#_getMountedAudioItems()) {
            list.push(...item.traces);
        }
        return list;
    }

    async #_mountFolder(folder) {
        if (typeof folder !== 'string' || !folder) return;
        const folderPath = path.resolve(folder);

        let stat;
        try {
            stat = await fs.stat(folderPath);
        } catch (e) {
            return;
        }
        if (!stat.isDirectory()) return;
        console.log(stat);
        
        const diskMtime = stat.mtimeMs;
        let currentItem = this.#_findAudioItem(folderPath);

        if (currentItem) {
            // 已存在：更新挂载状态与目录mtime
            currentItem.status = 'mounted';
        } else {
            // 不存在：创建全新item
            currentItem = {
                folder: folderPath,
                traces: [],
                lastScanAt: 0,
                rootMtime: null,
                status: 'mounted'
            };
            this.#_audios.push(currentItem);
        }

        // ✅ 统一：不管新建还是更新挂载状态，先持久化
        this.#_saveLibrary();
        console.log(`usb folder mounted: ${folderPath}, rootMtime: ${diskMtime}`);

        // mtime没有变化，不需要扫描，直接返回
        if (currentItem.rootMtime === diskMtime) {
            console.log(`usb folder mtime not changed, skip scan: ${folderPath}`);
            return;
        }

        // 如果已经有扫描任务正在跑，不再重复启动
        if (this.#_scannerInstances.has(folderPath)) {
            return;
        }

        console.log(`start scan folder: ${folderPath}, rootMtime: ${diskMtime}`);
        const scanner = new AudioScanner(folderPath, currentItem);
        this.#_scannerInstances.set(folderPath, scanner);

        scanner.on('scan:finish', (scanFolder, addedCount) => {
            const item = this.#_findAudioItem(scanFolder);
            if (item) {
                item.lastScanAt = Date.now();
                item.rootMtime = diskMtime;
                this.#_saveLibrary();
                console.log(`scanner finished for folder: ${scanFolder}, addedCount: ${addedCount}`);
            }
            this.#_scannerInstances.delete(scanFolder);
        });

        scanner.on('scan:error', (scanFolder, err) => {
            console.error(`[AudioLibrary] scan folder error:${scanFolder}`, err);
            this.#_scannerInstances.delete(scanFolder);
            this.#_saveLibrary();
        });

        await scanner.start();

    }

    async scanFolder(mountpoint) {
        return await this.#_mountFolder(mountpoint);
    }


    getFolders() {
        return this.#_getMountedAudioItems().map(i => i.folder);
    }

    getAllTracks() {
        return this.#_flattenTrackList();
    }

    filterTracks(filterObj = {}) {
        let list = this.#_flattenTrackList();
        const { title, artist, album, keyword } = filterObj;

        if (title) {
            const kw = title.toLowerCase();
            list = list.filter(t => (t.title || '').toLowerCase().includes(kw));
        }
        if (artist) {
            const kw = artist.toLowerCase();
            list = list.filter(t => (t.artist || '').toLowerCase().includes(kw));
        }
        if (album) {
            const kw = album.toLowerCase();
            list = list.filter(t => (t.album || '').toLowerCase().includes(kw));
        }
        if (keyword) {
            const kw = keyword.toLowerCase();
            list = list.filter(t =>
                `${t.filename || ''} ${t.title || ''} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(kw)
            );
        }
        return list;
    }


    getTrackByPath(trackPath) {
        return this.#_flattenTrackList().find(t => t.path === trackPath) ?? null;
    }


    removeTrackByPath(filePath) {
        for (const item of this.#_getMountedAudioItems()) {
            const idx = item.traces.findIndex(t => t.path === filePath);
            if (idx !== -1) {
                item.traces.splice(idx, 1);
                this.#_saveLibrary();
                return true;
            }
        }
        return false;
    }


    getAllScannerStatus() {
        const res = [];
        for (const [folder, scanner] of this.#_scannerInstances) {
            res.push({ folder, ...scanner.getStatus() });
        }
        return res;
    }


    clear() {
        for (const scanner of this.#_scannerInstances.values()) {
            scanner.stop();
        }
        this.#_scannerInstances.clear();
        this.#_started = false;
    }


    async addFolder(path) {
        // TODO
    }


    deleteFolder(path) {
        // TODO
    }
}


module.exports = AudioLibraryService;
