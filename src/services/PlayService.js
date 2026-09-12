const SonorService = require('./SonorService');
const fs = require('fs').promises;
const fsSync = require('fs');
const MpvPlayer = require('./MpvPlayer');
const path = require('path');
const logger = require('../utils/logger')(__dirname);
class PlayService extends SonorService {
    static EVENTS = {
        STATUS: 'playService:status',
        CURRENT_TRACK:'playService:current_track',
        CURRENTTIME_UPDATED: 'mpvplayer:currenttime_updated'
    };
    #destroyed;
    #mpvPlayer;
    #playerError = false; // 标记mpv进程是否异常
    /** 持久化数据：落地playstate.json */
    #persistData = {
        currentIndex: -1,
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
            logger.debug('PlayService mpv onPlay event');
            this.#playing = true;
            this.#paused = false;
            this.#playerError = false; // 正常播放，清除异常标记
            this.#emitStatus();
        });
        this.#mpvPlayer.onCurrentTimeUpdated((sec) => {
            this.emit(PlayService.EVENTS.CURRENTTIME_UPDATED, sec);
        });
        this.#mpvPlayer.onEnd(() => {
            logger.info('PlayService track end‑file event');
            this.#playing = false;
            this.#paused = false;
            this.#emitStatus();
            this.playNext(1).catch(err => logger.error(`playNext err ${err.message}`));
        });
        this.#mpvPlayer.onStop(() => {
            logger.info('PlayService mpv onStop event');
            this.#playing = false;
            this.#paused = false;
            this.#emitStatus();
        });
        // 暂停状态完全由mpv事件同步，不手动猜测
        this.#mpvPlayer.onPauseToggle((paused) => {
            logger.debug(`PlayService pause toggle event, paused: ${paused}`);
            this.#paused = paused;
            this.#emitStatus();
        });
        // 静音状态完全由mpv事件同步
        this.#mpvPlayer.onMuteToggle((muted) => {
            logger.info(`PlayService mute toggle event, muted: ${muted}`);
            this.#muted = muted;
            this.#emitStatus();
        });
        
        this.#mpvPlayer.onError((err) => {
            logger.error(`PlayService mpv error event ${err}`);
            this.#playerError = true; // mpv异常，打上标记
            this.#playing = false;
            this.#paused = false;
            this.#emitStatus();
        });
        
        logger.info(`PlayService instance created.`);
    }
    #emitStatus() {
        this.emit(PlayService.EVENTS.STATUS, this.getStatus());
    }
    #emitCurrentTrack(){
        logger.info('track play event emit');
        this.emit(PlayService.EVENTS.CURRENT_TRACK, this.getCurrentTrack());
    }
    getStatus() {
        return {
            currentIndex: this.#persistData.currentIndex,
            volume: this.#persistData.volume,
            loop: this.#persistData.loop,
            random: this.#persistData.random,
            paused: this.#paused,
            playing: this.#playing,
            muted: this.#muted,
            playerError: this.#playerError // 对外输出异常状态
        };
    }
    async start() {
        logger.info('PlayService start()');
        await this.#loadState();
        this.#playerError = false; // 启动时重置异常标记
        this.#mpvPlayer.init(this.#persistData.volume, this.#persistData.loop);
        logger.info(`PlayService loaded persisted state.`);
        this.#emitStatus();
    }
    /**
     * 从磁盘加载持久化数据
     */
    async #loadState() {
        if (!this.#dataFile) return;
        try {
            if (!fsSync.existsSync(this.#dataFile)) {
                logger.debug('PlayService playstate.json not exist, skip load');
                return;
            }
            const raw = await fs.readFile(this.#dataFile, 'utf8');
            const parsed = JSON.parse(raw);
            this.#persistData = { ...this.#persistData, ...parsed };
            logger.debug('PlayService loadState success');
        } catch (err) {
            logger.warn(`PlayService load state failed: ${err.message}`);
        }
    }
    /**
     * 保存持久化数据到磁盘
     */
    async #saveState() {
        if (!this.#dataFile) return;
        try {
            await fs.writeFile(this.#dataFile, JSON.stringify(this.#persistData, null, 2), 'utf8');
            logger.debug('PlayService saveState ok');
        } catch (err) {
            logger.warn(`PlayService save state failed: ${err.message}`);
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
            logger.debug(`PlayService calcIndex random mode, next: ${next}`);
            return next;
        }
        next = this.#persistData.currentIndex + direction;
        if (next >= len) next = 0;
        else if (next < 0) next = len - 1;
        logger.debug(`PlayService calcIndex normal mode, direction: ${direction}, next: ${next}`);
        return next;
    }
    /**
     * 追加一批曲目到当前播放列表（会持久化）
     * @param {Array} trackList
     */
    async pushList(trackList) {
        if (!Array.isArray(trackList)) {
            logger.warn('PlayService pushList: trackList not array');
            throw new Error('trackList must be array');
        }
        const input = trackList.length;
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
            logger.info(`PlayService pushList add items count: ${newItems.length}, total playlist: ${this.#persistData.playlist.length}`);
            await this.#saveState();
        }
        return {
            inputCount: input,
            addedCount: newItems.length
        }
    }
    async clearPlaylist() {
        logger.info('PlayService clearPlaylist');
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
            logger.warn('PlayService removeTracksByUuids: uuidArray not array');
            throw new Error('uuidArray must be array');
        }
        const removeSet = new Set(uuidArray);
        const oldList = this.#persistData.playlist;
        const newList = oldList.filter(item => !removeSet.has(item.uuid));
        const currentItem = oldList[this.#persistData.currentIndex];
        if (currentItem && removeSet.has(currentItem.uuid)) {
            logger.info('PlayService removeTracksByUuids remove current playing track, stop player');
            this.#persistData.currentIndex = -1;
            this.#mpvPlayer.stop();
        }
        this.#persistData.playlist = newList;
        logger.info(`PlayService removeTracksByUuids removed count: ${uuidArray.length}, new playlist size: ${newList.length}`);
        await this.#saveState();
        this.#emitStatus();
    }
    /**
     * 播放当前曲目
     * @returns {Promise<boolean>}
     */
    async playPause() {
        if (!this.#playing) {
            if(this.#persistData.playlist.length === 0) {
                logger.debug('PlayService playPause: playlist empty');
                return false;
            }
            const idx = this.#persistData.currentIndex;
            const targetIdx = (idx === -1 || idx >= this.#persistData.playlist.length) ? 0 : idx;
            logger.info(`PlayService playPause start play at index ${targetIdx}`);
            return await this.#playByIndex(targetIdx);
        }else{
            logger.debug('PlayService playPause toggle pause');
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
        logger.info(`PlayService playByUuid ${uuid}`);
        const idx = this.#persistData.playlist.findIndex(item => item.uuid === uuid);
        if (idx === -1) {
            logger.warn(`PlayService playByUuid not found, uuid: ${uuid}`);
            return false;
        }
        return await this.#playByIndex(idx);
    }
    /**
     * 停止播放
     * @returns {boolean}
     */
    stop() {
        if (!this.#playing) {
            logger.debug('PlayService stop: not playing, skip');
            return false;
        }
        logger.info('PlayService stop()');
        this.#mpvPlayer.stop();
        return true;
    }
    /**
     * 播放下一曲/上一曲
     * @param {number} dir 1=下一曲，-1=上一曲
     * @returns {Promise<boolean>}
     */
    async playNext(dir) {
        logger.info(`PlayService playNext dir: ${dir}`);
        const idx = this.#calcIndex(dir);
        if (idx === -1) {
            logger.warn('PlayService playNext calc index return -1');
            return false;
        }
        return await this.#playByIndex(idx);
    }
    /**
     * @param {number} index
     * @returns {Promise<boolean>}
     */
    async #playByIndex(index) {
        const item = this.#persistData.playlist[index];
        if (!item || !item.filepath) {
            logger.warn(`PlayService #playByIndex invalid item index: ${index}`);
            return false;
        }
        logger.info(`PlayService #playByIndex index:${index}, filepath:${item.filepath}`);
        this.#persistData.currentIndex = index;
        await this.#saveState();
        if (this.#playing) {
            logger.debug('PlayService #playByIndex: is playing, stop and wait');
            this.stop();
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        this.#mpvPlayer.play(item.filepath);
        this.#emitCurrentTrack();
        return true;
    }
    /**
     * 切换暂停/播放
     * @returns {boolean}
     */
    togglePause() {
        if (!this.#playing) {
            logger.debug('PlayService togglePause skip: not playing');
            return false;
        }
        logger.debug('PlayService togglePause call mpv');
        this.#mpvPlayer.togglePause();
        return true;
    }
    /**
     * 跳转播放位置
     * @param {number} pos 秒
     * @returns {boolean}
     */
    seek(pos) {
        if (!this.#playing) {
            logger.debug('PlayService seek skip: not playing');
            return false;
        }
        logger.info(`PlayService seek pos: ${pos}`);
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
        logger.info(`PlayService setVolume ${val}`);
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
        if (!this.#playing) {
            logger.debug('PlayService toggleMute skip: not playing');
            return false;
        }
        logger.debug('PlayService toggleMute call mpv');
        this.#mpvPlayer.toggleMute();
        return true;
    }
    /**
     * 设置循环播放（开关切换）
     * @returns {Promise<boolean>}
     */
    async loop() {
        this.#persistData.loop = !this.#persistData.loop;
        logger.info(`PlayService toggle loop: ${this.#persistData.loop}`);
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
        logger.info(`PlayService toggle random: ${this.#persistData.random}`);
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
     * 
     * @param {*} callback 
     * @returns 
     */
    onCurrentTrack(callback){
        return this.on(PlayService.EVENTS.CURRENT_TRACK, callback);
    }
    
    async destroy() {
        if(this.#destroyed) {
            logger.debug('PlayService destroy already destroyed, skip');
            return;
        }
        logger.info('PlayService destroy begin');
        this.#destroyed = true;
        try {
            await super.destroy();
            this.#mpvPlayer.removeAllListeners();
            await this.#mpvPlayer.destroy();
            logger.info('PlayService destroy complete');
        } catch (e) {
            logger.warn(`PlayService super destroy error ${e.message}`);
        }
    }
}
module.exports = PlayService;
