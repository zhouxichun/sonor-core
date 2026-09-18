const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const logger = require('../utils/logger')('AudioLibraryService');
const AudioScanner = require('./AudioScanner');
const SonorService = require('./SonorService');
const musicMetadata = require('music-metadata');
const sharp = require('sharp');
class AudioLibraryService extends SonorService {
    static EVENTS = {
        GROUP_STATS: 'audiolib:group_statS',
        COVER_READY:'audiolib:cover_ready',
        SCAN_NOTIFY:'audiolib:scan_notify'
    };

    #audios;
    #scannerInstances;
    #datafilePath;
    #groupStats;
    // 内存缓存：albumKey → 本地图片绝对路径
    #coverCacheDir;
    // 内存缓存：key=albumKey，存已经处理好的封面结果
    #coverMemCache;
    // 正在处理中的任务锁：防止并发重复解析，key=albumKey
    #coverPendingTasks; 

    /**
     * @param {Object} opts
     * @param {string} opts.dataPath 持久化数据目录，输出 audio_library.json
     */
    constructor() {
        super();
        this.#audios = [];
        this.#scannerInstances = new Map();
        this.#coverMemCache = new Map();
        this.#coverPendingTasks = new Map();

        this.#datafilePath = path.join(this.dataPath, 'audio_library.json');
        this.#coverCacheDir = path.join(this.dataPath, 'cover_cache');
        if (!fsSync.existsSync(this.#coverCacheDir)) {
            fsSync.mkdirSync(this.#coverCacheDir, { recursive: true });
            logger.info('created cover cache dir', this.#coverCacheDir);
        }
        logger.info('instance created. dataFile:', this.#datafilePath);
    }

    onGroupStatsUpdate(callback){ return this.on(AudioLibraryService.EVENTS.GROUP_STATS, callback); }
    offGroupStatsUpdate(callback){ return this.off(AudioLibraryService.EVENTS.GROUP_STATS, callback); }

    onCoverReady(callback){ return this.on(AudioLibraryService.EVENTS.COVER_READY, callback); }
    offCoverReady(callback){ return this.on(AudioLibraryService.EVENTS.COVER_READY, callback); }

    onScanNotify(callback){ return this.on(AudioLibraryService.EVENTS.SCAN_NOTIFY, callback); }
    offScanNotify(callback){ return this.on(AudioLibraryService.EVENTS.SCAN_NOTIFY, callback); }

    start() {
        this.#loadFromStore();
        logger.info('service started');
    }

    destroy() {
        for (const scanner of this.#scannerInstances.values()) {
            scanner.stop();
        }
        this.#scannerInstances.clear();
        logger.info('destroy done');
    }

    addDevice(device) {
        const folderPath = path.resolve(device);
        let stat;
        try {
            stat = fsSync.statSync(folderPath);
        } catch (e) {
            logger.warn(`add device stat fail, skip ${device}`, e);
            return;
        }

        if (!stat.isDirectory()) {
            logger.warn(`device not directory, skip ${device}`);
            return;
        }

        let currentItem = this.#findAudioItem(folderPath);
        if (currentItem) {
            currentItem.status = 'mounted';
            logger.info('mounted device: ', folderPath);
        } else {
            currentItem = {
                folder: folderPath,
                traces: [],
                lastScanAt: 0,
                status: 'mounted'
            };
            this.#audios.push(currentItem);
            logger.info(`add new device ${device}`);
        }
        this.#saveLibrary();
    }

    removeDevice(device) {
        const folderPath = path.resolve(device);
        let currentItem = this.#findAudioItem(folderPath);
        if (currentItem) {
            currentItem.status = 'unmounted';
            logger.info('unmounted device: ', folderPath);
            this.#saveLibrary();
        } 
    }

    async scanFolder(folderPath){
        if (this.#scannerInstances.has(folderPath)) {
            logger.info(`scanner already running, skip ${folderPath}`);
            return false;
        }
        let currentItem = this.#findAudioItem(folderPath);
        if(!currentItem){
            logger.info(`scanFolder: folder item not found, skip ${folderPath}`);
            return false;
        }
        const existFiles = currentItem.traces.map(track => track.filepath); 
        const scanner = new AudioScanner(folderPath, existFiles);
        this.#scannerInstances.set(folderPath, scanner);
        logger.debug(`AudioScanner instance created for ${folderPath}`);

        scanner.on('scan:buffer', (items) => {
            logger.info(`scanner buffer for folder: ${folderPath}, items: ${items.length}`);
            currentItem.traces.push(...items);
            this.#saveLibrary();
        });

        scanner.on('scan:finish', (scanFolder, addedCount) => {
            this.emit(AudioLibraryService.EVENTS.SCAN_NOTIFY,
                { message: `设备${scanFolder}扫描完成, ${addedCount}首曲目入库`, info: 'success'});
            const item = this.#findAudioItem(scanFolder);
            if(item){
                item.lastScanAt = Date.now();
            }
            logger.info(`scan finish | folder=${scanFolder}, addedCount=${addedCount}`);
            this.#saveLibrary();
            this.#scannerInstances.delete(scanFolder);
            if(addedCount>0) this.GroupStats();
        });

        scanner.on('scan:error', (scanFolder, err) => {
            logger.error('scan folder error', scanFolder, err);
            this.#scannerInstances.delete(scanFolder);
        });

        this.emit(AudioLibraryService.EVENTS.SCAN_NOTIFY, { message: `开始扫描设备 [${folderPath}]` });
        try{
            await scanner.start();
            logger.debug('scaning folder', folderPath);
        }catch(err){
            logger.debug('scaning folder error', folderPath, err);
        }
    }

    filterTracks(filterObj = {}) {
        let list = this.#flattenTrackList();
        const { artist, album, genre, keyword } = filterObj;
        if (artist) {
            const kw = artist.trim().toLowerCase();
            list = list.filter(t => (t.artist || '').toLowerCase().includes(kw));
        }
        if (album) {
            const kw = album.trim().toLowerCase();
            list = list.filter(t => (t.album || '').toLowerCase().includes(kw));
        }
        if (genre) {
            const targetGenre = genre.trim().toLowerCase();
            list = list.filter(t => {
                const trackGenres = (t.genre || '')
                    .split(/[,，]/)
                    .map(g => g.trim().toLowerCase())
                    .filter(Boolean);
                return trackGenres.includes(targetGenre);
            });
        }
        if (keyword) {
            const kw = keyword.trim().toLowerCase();
            list = list.filter(t =>
                `${t.filename || ''} ${t.title || ''} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(kw)
            );
        }

        // 只提取需要字段：uuid, title, artist, album, genre
        return list.map(t => ({
            uuid: t.uuid,
            title: t.title,
            artist: t.artist,
            album: t.album,
            genre: t.genre
        }));
    }

    getTrackByUuid(uuid) { 
        const track = this.#flattenTrackList().find(t => t.uuid === uuid);
        if(!track) return null;
        return {...track};
    }
    getGroupStats(){ return this.#groupStats; }

    #loadFromStore() {
        this.#audios = [];
        if (!fsSync.existsSync(this.#datafilePath)) {
            logger.info('library store file not exist, skip load');
            return;
        }
        try {
            const buf = fsSync.readFileSync(this.#datafilePath, 'utf-8');
            const parsed = JSON.parse(buf);
            this.#audios = parsed.map(item => ({
                ...item,
                status: 'unmounted'
            }));
            logger.info('load persisted data success');
        } catch (e) {
            logger.error('persisted data load failed', e);
        }
    }
    #saveLibrary() {
        try {
            const dump = this.#audios.map(({ status, ...rest }) => rest);
            fsSync.writeFileSync(this.#datafilePath, JSON.stringify(dump, null, 2));
            logger.debug('data save to file');
        } catch (err) {
            logger.error('data save error', err);
        }
    }
    #findAudioItem(folderPath) { return this.#audios.find(item => item.folder === folderPath) ?? null; }
    #getMountedAudioItems() { return this.#audios.filter(item => item.status === 'mounted'); }
    #flattenTrackList() {
        const list = [];
        for (const item of this.#getMountedAudioItems()) {
            list.push(...item.traces);
        }
        return list;
    }

   
    /**
     * 根据专辑key生成缓存文件名md5
     * @param {string} albumKey
     * @returns {string}
     */
    #getCoverFilename(albumKey) {
        const crypto = require('crypto');
        return crypto.createHash('md5').update(albumKey).digest('hex');
    }
    /**
     * 查找磁盘上的原图缓存
     * @param {string} albumKey
     * @returns {Promise<string|null>} 图片完整路径，null无缓存
     */
    async #findCoverFileInDisk(albumKey) {
        const baseName = this.#getCoverFilename(albumKey);
        const fullPath = path.join(this.#coverCacheDir, `${baseName}.jpg`);
        if(fsSync.existsSync(fullPath)){
            return fullPath;
        }
        return null;
    }
    /**
     * 将原图buffer写入磁盘缓存
     * @param {string} albumKey
     * @param {Buffer} imageBuf
     * @returns {string} 写入完整路径
     */
    async #writeCoverFileToDisk(albumKey, imageBuf) {
        const baseName = this.#getCoverFilename(albumKey);
        const fullPath = path.join(this.#coverCacheDir, `${baseName}.jpg`);
        await fs.writeFile(fullPath, imageBuf);
        logger.debug('write cover to file', fullPath);
        return fullPath;
    }
    /**
     * 读取音频内嵌封面，输出原图buffer(jpg)，不缩放
     * @param {string} filepath
     * @returns {Promise<{buffer:Buffer}|null>}
     */
    async #readCoverBuffer(filepath) {
        try {
            const meta = await musicMetadata.parseFile(filepath, {
                skipCovers: false,
                skipPostProcess: true
            });
            const pictureList = meta.common?.picture;
            if (!pictureList || pictureList.length === 0) {
                logger.debug('no embedded cover', filepath);
                return null;
            }
            const pic = pictureList[0];
            // 统一转jpg原图存入磁盘
            const buffer = await sharp(pic.data).jpeg({quality:90}).toBuffer();
            return { buffer: buffer };
        } catch (err) {
            logger.warn('read embedded cover failed', filepath, err);
            return null;
        }
    }
    /**
     * 根据uuid获取曲目封面
     * @param {string} uuid
     * @param {{thumbnailWidth?:number}} opts
     * @returns {Promise<string|null>} dataUrl base64
     */
    async readyCover(uuid) {
        let foundTrack = null;
        for(const folderItem of this.#audios) {
            foundTrack = folderItem.traces?.find(t => t.uuid === uuid);
            if(foundTrack) break;
        }
        if (!foundTrack || !foundTrack.filepath) {
            logger.debug('try to read cover but track not found', uuid);
            return;
        }
        const thumbnailWidth  = 600;
        const albumKey = `${foundTrack.artist || ''}||${foundTrack.album || ''}`;
        // 1. 内存命中缓存，直接emit，几乎0延迟
        if(this.#coverMemCache.has(albumKey)){
            const cached = this.#coverMemCache.get(albumKey);
            this.emit(AudioLibraryService.EVENTS.COVER_READY, { uuid, ...cached });
            return; // ✅ 必须return，否则继续往下执行
        }
        // 2. 如果当前专辑正在解析，直接等待同一个Promise，不重复执行
        if(this.#coverPendingTasks.has(albumKey)){
            const pending = await this.#coverPendingTasks.get(albumKey);
            this.emit(AudioLibraryService.EVENTS.COVER_READY, { uuid, ...pending });
            return;
        }
        // 3. 创建任务Promise，存入pending锁，防止并发重复解析
        const taskPromise = (async () => {
            let imagePath = await this.#findCoverFileInDisk(albumKey);
            if (!imagePath) {
                const raw = await this.#readCoverBuffer(foundTrack.filepath);
                if (!raw) {
                    return null;
                }
                imagePath = await this.#writeCoverFileToDisk(albumKey, raw.buffer);
            }
            let image = sharp(imagePath)
                .resize({
                    width: thumbnailWidth,
                    height: thumbnailWidth,
                    fit: 'inside'
                });
            const outBuf = await image.jpeg({quality:85}).toBuffer();
            const theme = await this.#extractThemeColor(outBuf);
            const result = {
                base64: `data:image/jpeg;base64,${outBuf.toString('base64')}`,
                theme: theme
            };
            // 存入内存缓存
            this.#coverMemCache.set(albumKey, result);
            return result;
        })();
        this.#coverPendingTasks.set(albumKey, taskPromise);
        try {
            const res = await taskPromise;
            if(!res) return;
            this.emit(AudioLibraryService.EVENTS.COVER_READY, { uuid, ...res });
        } catch(err){
            logger.error('ready cover error', albumKey, err);
        } finally {
            // 解析完成/失败，清除pending锁
            this.#coverPendingTasks.delete(albumKey);
        }
    }

    async #extractThemeColor(imageBuffer) {
        try {
            // 缩小到 1x1 取平均色
            const { data } = await sharp(imageBuffer)
                .resize(1, 1)
                .raw()
                .toBuffer({ resolveWithObject: true });

            const r = data[0];
            const g = data[1];
            const b = data[2];

            const { h, s, l } = this.#rgbToHsl(r, g, b);

            return {
                h: Math.round(h),
                s: Math.round(s * 100),
                l: Math.round(l * 100)
            };
        } catch (err) {
            logger.warn('get theme color from cover failed', err);
            return null;
        }
    }

    #rgbToHsl(r, g, b) {
        r /= 255;
        g /= 255;
        b /= 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;

        if (max === min) {
            h = s = 0;
        } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }

        return { h: h * 360, s, l };
    } 

    /**
     * 一次性获取艺术家、专辑、流派分组统计
     * @returns {{
     *   artists: Array<{name:string, count:number}>,
     *   albums: Array<{name:string, count:number}>,
     *   genres: Array<{name:string, count:number}>
     * }}
     */
    GroupStats() {
        const tracks = this.#flattenTrackList();
        const artistMap = new Map();
        const albumMap = new Map();
        const genreMap = new Map();

        for (const t of tracks) {
            // artist
            const artistName = (t.artist || '未知艺术家').trim();
            artistMap.set(artistName, (artistMap.get(artistName) || 0) + 1);

            // album
            const albumName = (t.album || '未知专辑').trim();
            albumMap.set(albumName, (albumMap.get(albumName) || 0) + 1);

            // genre 多值拆分
            const rawGenre = t.genre || '';
            const genres = rawGenre.split(/[,，]/).map(s => s.trim()).filter(Boolean);
            const genreList = genres.length > 0 ? genres : ['未知流派'];
            for (const g of genreList) {
            genreMap.set(g, (genreMap.get(g) || 0) + 1);
            }
        }

        this.#groupStats = {
            artists: Array.from(artistMap.entries()).map(([name, count]) => ({ name, count })),
            albums: Array.from(albumMap.entries()).map(([name, count]) => ({ name, count })),
            genres: Array.from(genreMap.entries()).map(([name, count]) => ({ name, count }))
        };

        this.emit(AudioLibraryService.EVENTS.GROUP_STATS, this.#groupStats);
    }

}
module.exports = AudioLibraryService;