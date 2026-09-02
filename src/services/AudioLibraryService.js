const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const AudioScanner = require('./AudioScanner');
const UsbDriver = require('./UsbDriver');
const SonorService = require('./SonorService');

class AudioLibraryService extends SonorService {
    #audios;
    #scannerInstances;
    #autoScan;
    #datafilePath;
    #usbDriver;

    /**
     * @param {Object} opts
     * @param {boolean} [opts.autoScanUsb=true] 是否自动扫描发现的U盘
     * @param {string} opts.dataPath 持久化数据目录，输出 audio_library.json
     */
    constructor(opts = {}) {
        super(opts);
        this.#audios = [];
        this.#scannerInstances = new Map();
       
        this.#datafilePath = path.join(this.dataPath, 'audio_library.json');
        this.#autoScan = opts.autoScanUsb ?? true;
        this.#usbDriver = new UsbDriver();

        this.#usbDriver.onUsbFound(async (devices) => {
            for (const device of devices) {
                try {
                    console.log('Usb found:', device);
                    await this.#addFolder(device.path);
                } catch (err) {
                    console.warn('addFolder error', err.message);
                }
            }
        });
    }

    #loadFromStore() {
        this.#audios = [];
        if (!fsSync.existsSync(this.#datafilePath)) {
            return;
        }
        try {
            const buf = fsSync.readFileSync(this.#datafilePath, 'utf-8');
            const parsed = JSON.parse(buf);
            this.#audios = parsed.map(item => ({
                ...item,
                status: 'unmounted'
            }));
            console.log(`AudioLibrary loaded.`);
        } catch (e) {
            console.warn('AudioLibrary load failed, reset library', e.message);
            this.#audios = [];
        }
    }

    #saveLibrary() {
        try {
            const dump = this.#audios.map(({ status, ...rest }) => rest);
            fsSync.writeFileSync(this.#datafilePath, JSON.stringify(dump, null, 2));
        } catch (err) {
            console.error('AudioLibrary save error', err);
        }
    }

    #findAudioItem(folderPath) {
        return this.#audios.find(item => item.folder === folderPath) ?? null;
    }

    #getMountedAudioItems() {
        return this.#audios.filter(item => item.status === 'mounted');
    }

    #flattenTrackList() {
        const list = [];
        for (const item of this.#getMountedAudioItems()) {
            list.push(...item.traces);
        }
        return list;
    }

    async #addFolder(folder) {
        if (typeof folder !== 'string' || !folder) return;
        const folderPath = path.resolve(folder);
        let stat;
        try {
            stat = await fs.stat(folderPath);
        } catch (e) {
            return;
        }
        if (!stat.isDirectory()) return;

        let currentItem = this.#findAudioItem(folderPath);
        if (currentItem) {
            currentItem.status = 'mounted';
        } else {
            currentItem = {
                folder: folderPath,
                traces: [],
                lastScanAt: 0,
                status: 'mounted'
            };
            this.#audios.push(currentItem);
        }
        this.#saveLibrary();

        if (!this.#autoScan) {
            return;
        }
        if (this.#scannerInstances.has(folderPath)) {
            return;
        }

        console.log(`start scan folder: ${folderPath}`);
        const existFiles = currentItem.traces.map(t => t.filepath);
        const scanner = new AudioScanner(folderPath, existFiles);
        this.#scannerInstances.set(folderPath, scanner);

        scanner.on('scan:buffer', (items) => {
            console.log(`scanner buffer for folder: ${folderPath}, items: ${items.length}`);
            const item = this.#findAudioItem(folderPath);
            if (!item) return;
            item.traces.push(...items);
            this.#saveLibrary();
        });

        scanner.on('scan:finish', (scanFolder, addedCount) => {
            console.log(`scanner finished for folder: ${scanFolder}, addedCount: ${addedCount}`);
            const item = this.#findAudioItem(scanFolder);
            if (item) {
                item.lastScanAt = Date.now();
                this.#saveLibrary();
            }
            this.#scannerInstances.delete(scanFolder);
        });

        scanner.on('scan:error', (scanFolder, err) => {
            console.error(`[AudioLibrary] scan folder error:${scanFolder}`, err);
            this.#scannerInstances.delete(scanFolder);
            this.#saveLibrary();
        });

        await scanner.start();
    }

    async start() {
        this.#loadFromStore();
        await this.#usbDriver.start();
    }

    getFolders() {
        return this.#getMountedAudioItems().map(i => i.folder);
    }

    getAllTracks() {
        return this.#flattenTrackList();
    }

    filterTracks(filterObj = {}) {
        let list = this.#flattenTrackList();
        // 分页参数拆出，不参与过滤
        const { title, artist, album, keyword, offset = 0, limit } = filterObj;

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

        const total = list.length;
        // 分页切片
        if (typeof limit === 'number') {
            list = list.slice(offset, offset + limit);
        } else {
            list = list.slice(offset);
        }

        return {
            total,
            list
        };
    }

    getTrackByUuid(uuid) {
        return this.#flattenTrackList().find(t => t.uuid === uuid) ?? null;
    }

    removeTrackByUuid(uuid) {
        for (const item of this.#getMountedAudioItems()) {
            const idx = item.traces.findIndex(t => t.uuid === uuid);
            if (idx !== -1) {
                item.traces.splice(idx, 1);
                this.#saveLibrary();
                return true;
            }
        }
        return false;
    }

    /**
     * 获取不重复艺术家列表，附带曲目计数
     * @returns Array<{name:string, count:number}>
     */
    getDistinctArtists() {
        const tracks = this.#flattenTrackList();
        const map = new Map();
        for (const t of tracks) {
            const name = (t.artist || '未知艺术家').trim();
            map.set(name, (map.get(name) || 0) + 1);
        }
        return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
    }

    /**
     * 获取不重复专辑列表，附带曲目计数
     * @returns Array<{name:string, count:number}>
     */
    getDistinctAlbums() {
        const tracks = this.#flattenTrackList();
        const map = new Map();
        for (const t of tracks) {
            const name = (t.album || '未知专辑').trim();
            map.set(name, (map.get(name) || 0) + 1);
        }
        return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
    }

    /**
     * 获取不重复流派列表，附带曲目计数
     * @returns Array<{name:string, count:number}>
     */
    getDistinctGenres() {
        const tracks = this.#flattenTrackList();
        const map = new Map();
        for (const t of tracks) {
            const raw = (t.genre || '未知流派').trim();
            const parts = raw.split(',').map(g => g.trim()).filter(Boolean);
            for (const g of parts) {
                map.set(g, (map.get(g) || 0) + 1);
            }
        }
        return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
    }

    async destroy() {
        await super.destroy();
        for (const scanner of this.#scannerInstances.values()) {
            scanner.stop();
        }
        this.#scannerInstances.clear();
        await this.#usbDriver.destroy();
    }
}

module.exports = AudioLibraryService;
