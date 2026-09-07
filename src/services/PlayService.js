const SonorService = require('./SonorService');
const fs = require('fs').promises;
const fsSync = require('fs');
const MpvPlayer = require('./MpvPlayer');
const path = require('path');
const musicMetadata = require('music-metadata');
const sharp = require('sharp');

class PlayService extends SonorService {
    static EVENTS = {
        STATUS: 'playService:status',
        CURRENTTIME_UPDATED: 'mpvplayer:currenttime_updated'
    };
    #destroyed;
    #mpvPlayer;
    /** 持久化数据：落地playstate.json */
    #persistData = {
        currentIndex: -1,
        eq: '',
        volume: 50,
        loop: false,
        random: false,
        playlist: []
    };
    #dataFile;
    // 非持久化独立属性
    #paused = false;
    #playing = false;
    #muted = false;
    /**
     * @param {Object} opts
     * @param {string} opts.dataPath 状态持久化数据目录
     */
    constructor(opts = {}) {
        super(opts);
        this.#destroyed = false;
        this.#dataFile = path.join(this.dataPath, 'playstate.json');
        this.#mpvPlayer = new MpvPlayer({ updateInterval: 1000 });
        this.#mpvPlayer.onPlay(() => {
            this.#playing = true;
            this.#paused = false;
            this.#emitStatus();
        });
        this.#mpvPlayer.onCurrentTimeUpdated((sec) => {
            this.emit(PlayService.EVENTS.CURRENTTIME_UPDATED, sec);
        });
        this.#mpvPlayer.onEnd(() => {
            this.#playing = false;
            this.#paused = false;
            this.#emitStatus();
            this.playNext(1).catch(err => console.error('playNext err', err));
        });
        this.#mpvPlayer.onStop(() => {
            this.#playing = false;
            this.#paused = false;
            this.#emitStatus();
        });
        // 暂停状态完全由mpv事件同步，不手动猜测
        this.#mpvPlayer.onPauseToggle((paused) => {
            this.#paused = paused;
            this.#emitStatus();
        });
        // 静音状态完全由mpv事件同步
        this.#mpvPlayer.onMuteToggle((muted) => {
            this.#muted = muted;
            this.#emitStatus();
        });
        this.#mpvPlayer.onError((err) => {
            console.log('mpv error', err);
            this.#emitStatus();
        });
    }

    #emitStatus() {
        this.emit(PlayService.EVENTS.STATUS, this.getStatus());
    }

    getStatus() {
        return {
            currentIndex: this.#persistData.currentIndex,
            eq: this.#persistData.eq,
            volume: this.#persistData.volume,
            loop: this.#persistData.loop,
            random: this.#persistData.random,
            paused: this.#paused,
            playing: this.#playing,
            muted: this.#muted
        };
    }

    async start() {
        await this.#loadState();
        this.#mpvPlayer.init();
        this.#mpvPlayer.setVolume(this.#persistData.volume);
        this.#mpvPlayer.setEQ(this.#persistData.eq);
        this.#mpvPlayer.setLoop(this.#persistData.loop);
        this.#emitStatus();
    }

    /**
     * 从磁盘加载持久化数据
     */
    async #loadState() {
        if (!this.#dataFile) return;
        try {
            if (!fsSync.existsSync(this.#dataFile)) return;
            const raw = await fs.readFile(this.#dataFile, 'utf8');
            const parsed = JSON.parse(raw);
            this.#persistData = { ...this.#persistData, ...parsed };
        } catch (err) {
            console.warn('PlayService load state failed:', err.message);
        }
    }

    /**
     * 保存持久化数据到磁盘
     */
    async #saveState() {
        if (!this.#dataFile) return;
        try {
            await fs.writeFile(this.#dataFile, JSON.stringify(this.#persistData, null, 2), 'utf8');
        } catch (err) {
            console.warn('PlayService save state failed:', err.message);
        }
    }

    #calcIndex(direction) {
        let next = -1;
        const len = this.#persistData.playlist.length;
        const { random } = this.#persistData;
        if (len === 0) return next;
        if (random) {
            do {
                next = Math.floor(Math.random() * len);
            } while(next === this.#persistData.currentIndex && len > 1);
            return next;
        }
        next = this.#persistData.currentIndex + direction;
        if (next >= len) next = 0;
        else if (next < 0) next = len - 1;
        return next;
    }

     /**
     * 追加一批曲目到当前播放列表（会持久化）
     * @param {Array} trackList
     */
    async pushList(trackList) {
        if (!Array.isArray(trackList)) {
            throw new Error('trackList must be array');
        }

        // 获取已存在的uuid集合，用于快速查重
        const existUuids = new Set(
            this.#persistData.playlist.map(item => item.uuid)
        );

        // 过滤：只加入uuid不在现有列表的曲目
        const newItems = trackList.filter(track => {
            return track && track.uuid && !existUuids.has(track.uuid);
        });

        if(newItems.length > 0) {
            this.#persistData.playlist.push(...newItems);
            await this.#saveState();
        }
    }

    async clearPlaylist() {
        this.#mpvPlayer.stop();
        this.#persistData.playlist = [];
        this.#persistData.currentIndex = -1;
        await this.#saveState();
        this.#emitStatus();
    }

    /**
     * 根据uuid数组删除播放列表中的曲目
     * @param {string[]} uuidArray
     */
    async removeTracksByUuids(uuidArray) {
        if (!Array.isArray(uuidArray)) {
            throw new Error('uuidArray must be array');
        }
        const removeSet = new Set(uuidArray);
        const oldList = this.#persistData.playlist;
        const newList = oldList.filter(item => !removeSet.has(item.uuid));
        const currentItem = oldList[this.#persistData.currentIndex];
        if (currentItem && removeSet.has(currentItem.uuid)) {
            this.#persistData.currentIndex = -1;
            this.#mpvPlayer.stop(); 
        }
        this.#persistData.playlist = newList;
        await this.#saveState();
        this.#emitStatus();
    }

    /**
     * 播放当前曲目
     * @returns {Promise<boolean>}
     */
    async playPause() {
        if (!this.#playing) {
            if(this.#persistData.playlist.length === 0) return false;
            const idx = this.#persistData.currentIndex;
            if (idx === -1 || idx >= this.#persistData.playlist.length)
                idx = 0;
            return await this.#playByIndex(idx);
        }else{
           this.#mpvPlayer.togglePause();
           return true; 
        }
    }
    /**
     * 通过uuid播放曲目
     * @param {string} uuid
     * @returns {Promise<boolean>}
     */
    async playByUuid(uuid) {
        const idx = this.#persistData.playlist.findIndex(item => item.uuid === uuid);
        if (idx === -1) return false;
        return await this.#playByIndex(idx);
    }

    /**
     * 停止播放
     * @returns {boolean}
     */
    stop() {
        if (!this.#playing) {
            return false;
        }
        this.#mpvPlayer.stop();
        return true;
    }

    /**
     * 播放下一曲/上一曲
     * @param {number} dir 1=下一曲，-1=上一曲
     * @returns {Promise<boolean>}
     */
    async playNext(dir) {
        const idx = this.#calcIndex(dir);
        if (idx === -1) return false;
        return await this.#playByIndex(idx);
    }

    /**
     * @param {number} index
     * @returns {Promise<boolean>}
     */
    async #playByIndex(index) {
        const item = this.#persistData.playlist[index];
        if (!item || !item.filepath) return false;
        this.#persistData.currentIndex = index;
        await this.#saveState();
        if (this.#playing) {
            this.stop();
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        this.#mpvPlayer.play(item.filepath);
        return true;
    }

    /**
     * 切换暂停/播放
     * @returns {boolean}
     */
    togglePause() {
        if (!this.#playing) return false;
        this.#mpvPlayer.togglePause();
        return true;
    }

    /**
     * 跳转播放位置
     * @param {number} pos 秒
     * @returns {boolean}
     */
    seek(pos) {
        if (!this.#playing) return false;
        this.#mpvPlayer.seek(pos);
        return true;
    }

    /**
     * 设置音量
     * @param {number} vol 0‑100
     * @returns {Promise<boolean>}
     */
    async setVolume(vol) {
        const val = Math.min(Math.max(vol, 0), 100);
        this.#persistData.volume = val;
        this.#mpvPlayer.setVolume(val);
        await this.#saveState();
        this.#emitStatus();
        return true;
    }

    /**
     * 切换静音
     * @returns {boolean}
     */
    toggleMute() {
        if (!this.#playing) return false;
        this.#mpvPlayer.toggleMute();
        return true;
    }

    /**
     * 设置均衡器参数
     * @param {string} eqStr
     * @returns {Promise<boolean>}
     */
    async setEQ(eqStr) {
        this.#persistData.eq = eqStr ?? '';
        this.#mpvPlayer.setEQ(this.#persistData.eq);
        await this.#saveState();
        this.#emitStatus();
        return true;
    }

    /**
     * 设置循环播放（开关切换）
     * @returns {Promise<boolean>}
     */
    async loop() {
        this.#persistData.loop = !this.#persistData.loop;
        this.#mpvPlayer.setLoop(this.#persistData.loop);
        await this.#saveState();
        this.#emitStatus();
        return this.#persistData.loop;
    }

    /**
     * 设置随机播放（开关切换）
     * @returns {Promise<boolean>}
     */
    async random() {
        this.#persistData.random = !this.#persistData.random;
        await this.#saveState();
        this.#emitStatus();
        return this.#persistData.random;
    }

    getPlaylist() {
        return [...this.#persistData.playlist];
    }

    getCurrentTrack() {
        const idx = this.#persistData.currentIndex;
        const list = this.#persistData.playlist;
        if(idx <0 || idx >= list.length) return null;
        return {...list[idx]};
    }

    /**
     * @param {(payload: any)=>void} callback
     */
    onTimeUpdated(callback) {
        return this.on(PlayService.EVENTS.CURRENTTIME_UPDATED, callback);
    }

    /**
     * @param {(payload: any)=>void} callback
     */
    onStateUpdated(callback) {
        return this.on(PlayService.EVENTS.STATUS, callback);
    }


    /**
     * 内部读取音频内嵌封面
     * @param {string} filepath
     * @param {number|null} resizeWidth 需要缩略图传宽度，null返回原图
     * @returns {Promise<string|null>} dataUrl base64
     */
    async #readCoverFromFile(filepath, resizeWidth = null) {
        console.debug('readCoverFromFile meta', filepath);
        try {
            const meta = await musicMetadata.parseFile(filepath, {
                skipCovers: false
            });
            const pictureList = meta.common?.picture;
            if (!pictureList || pictureList.length === 0) {
                return null;
            }
            const pic = pictureList[0];
            let imageBuffer = pic.data;
            // 需要缩略图，进行等比缩放
            if (resizeWidth && Number.isInteger(resizeWidth)) {
                imageBuffer = await sharp(pic.data)
                    .resize({ width: resizeWidth, height: resizeWidth, fit: 'inside' })
                    .toBuffer();
            }
            return `data:${pic.format};base64,${imageBuffer.toString('base64')}`;
        } catch (err) {
            console.warn('读取音频封面失败', filepath, err.message);
            return null;
        }
    }

    /**
     * 根据uuid获取曲目封面
     * @param {string} uuid
     * @param {{thumbnailWidth?:number}} opts  thumbnailWidth:缩略图宽度，不传返回原图
     * @returns {Promise<string|null>}
     */
    async getCoverByUuid(uuid, opts = {}) {
        const track = this.#persistData.playlist.find(t => t.uuid === uuid);
        console.warn('getCoverByUuid', uuid, track);
        if (!track || !track.filepath) {
            return null;
        }
        const { thumbnailWidth } = opts;
        return await this.#readCoverFromFile(track.filepath, thumbnailWidth ?? null);
    }

    async destroy() {
        if(this.#destroyed) return;
        this.#destroyed = true;
        try {
            await super.destroy();
            this.#mpvPlayer.removeAllListeners();
            await this.#mpvPlayer.destroy();
        } catch (e) {
            console.warn('PlayService super destroy error', e);
        }
    }
}
module.exports = PlayService;
