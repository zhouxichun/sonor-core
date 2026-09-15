const SonorService = require('./SonorService');
const fs = require('fs').promises;
const fsSync = require('fs');
const MpvPlayer = require('./MpvPlayer');
const path = require('path');
const logger = require('../utils/logger')('PlayService');
class PlayService extends SonorService {
    static EVENTS = {
        STATUS: 'playService:status',
        CURRENT_TRACK:'playService:current_track',
        CURRENTTIME_UPDATED: 'playService:currenttime_updated',
        PLAYLIST_UPDATED:'playService:playlist_updated'
    };
    #destroying = false;
    #mpvPlayer = null;
    #dataFile = null;
    #playerState = {
        playing: false,
        paused: false,
        volume: 60,
        loop: false,
        muted: false,
        playerError: false,
        random: false,
    };
    #playlist = [];
    #currentUuid;

    /**
     * @param {Object} opts
     * @param {string} opts.dataPath 状态持久化数据目录
     */
    constructor(opts = {}) {
        super(opts);
        this.#dataFile = path.join(this.dataPath, 'playstate.json');
        this.#mpvPlayer = new MpvPlayer({ updateInterval: 1000 });
        this.#mpvPlayer
        .onPlay(() =>{
            logger.info('player start play');
            this.#emitCurrentTrack();
            this.#updatePlayerState({
                playing: true,
                paused: false,
                playerError: false
            });
        })
        .onEnd(() => {
            logger.info('player play to end');
            this.#updatePlayerState({
                playing: false,
                paused: false
            });
            logger.info('playing ended and play next track auto.')
            this.playNext(1).catch(err => logger.error('playNext err', err));
        })
        .onStop(() => {
            logger.info('player stop');
            this.#updatePlayerState({
                playing: false,
                paused: false
            });
        })
        .onPauseToggle((paused) => {
            logger.info('player pause toggle', paused);
            this.#updatePlayerState({
                paused: paused
            });
        })
        .onMuteToggle((muted) => {
            logger.info('player mute toggle', muted);
            this.#updatePlayerState({
                muted: muted
            });
        })
        .onVolumeUpdate((volume) => {
            logger.info('player volume set to ', volume);
            this.notify(`音量调整到 ${volume}`,'success');
            this.#updatePlayerState({
                volume: volume
            });
        })
        .onLoopToggle((loop) => {
            logger.info('player loop mode set to ', loop);
            this.#updatePlayerState({
                loop: loop
            });
        })
        .onError((err) => {
            logger.error('player error event', err);
            this.notify(`播放器异常: ${err.message}`, 'error');
            this.#updatePlayerState({
                playing: false,
                paused: false,
                playerError: true
            });
        })
        .onCurrentTimeUpdated((sec) => {
            this.emit(PlayService.EVENTS.CURRENTTIME_UPDATED, sec);
        });

        logger.info('instance created.');
    }

    onStateUpdated(callback) { return this.on(PlayService.EVENTS.STATUS, callback); }
    offStateUpdated(callback) { return this.off(PlayService.EVENTS.STATUS, callback); }

    onCurrentTrack(callback){ return this.on(PlayService.EVENTS.CURRENT_TRACK, callback); }
    offCurrentTrack(callback){ return this.off(PlayService.EVENTS.CURRENT_TRACK, callback); }

    onTimeUpdated(callback) { return this.on(PlayService.EVENTS.CURRENTTIME_UPDATED, callback); }
    offTimeUpdated(callback) { return this.off(PlayService.EVENTS.CURRENTTIME_UPDATED, callback); }

    onPlaylistUpdated(callback){ return this.on(PlayService.EVENTS.PLAYLIST_UPDATED, callback); }
    offPlaylistUpdated(callback){ return this.off(PlayService.EVENTS.PLAYLIST_UPDATED, callback); }

    async start() {
        logger.info('start');
        await this.#loadState();
        this.#mpvPlayer.init( this.#playerState.volume );
    }
    getStatus() { return { ...this.#playerState }; }
    getPlaylist() { return [...this.#playlist]; }
    getCurrentUuid() { return this.#currentUuid }
    /**
     * 追加一批曲目到当前播放列表（会持久化）
     * @param {Array} trackList
     */
    async pushList(trackList) {
        if (!Array.isArray(trackList)) {
            throw new Error('trackList must be array');
        }
        // 获取已存在的uuid集合，用于快速查重
        const existUuids = new Set( this.#playlist.map(item => item.uuid) );
        // 过滤：只加入uuid不在现有列表的曲目
        const newItems = trackList.filter(track => {
            return track && track.uuid && !existUuids.has(track.uuid);
        });

        if(newItems.length > 0) {
            this.#playlist.push(...newItems);
            logger.info(`playlist add new items count: ${newItems.length}, total: ${this.#playlist.length}`);
            this.#emitPlaylistUpdated();
            await this.#saveState();
            this.notify(`播放列表新增${newItems.length}个曲目`, 'success');
        }else{
            this.notify('曲目已经在播放列表中, 无需添加.');
        }
    }
    async clearPlaylist() {
        logger.info('clear playlist');
        this.notify('播放列表已清空','success');
        this.#mpvPlayer.stop();
        this.#playlist = [];
        this.#emitPlaylistUpdated();
        this.#currentUuid = null;
        this.#emitCurrentTrack();
        await this.#saveState();
    }

    /**
     * 根据uuid数组删除播放列表中的曲目
     * @param {string[]} uuidArray
     */
    async removeTracksByUuids(uuidArray) {
        if (!Array.isArray(uuidArray)) throw new Error('uuidArray must be array');

        const removeSet = new Set(uuidArray);
        // 判断待删除列表是否包含当前播放曲目
        if (removeSet.has(this.#currentUuid)) {
            logger.info('remove track from playlist, stop playback');
            this.#currentUuid = null;
            this.#emitCurrentTrack();
            this.#mpvPlayer.stop();
        }

        const oldList = this.#playlist;
        this.#playlist = oldList.filter(item => !removeSet.has(item.uuid));
        this.#emitPlaylistUpdated();
        logger.info(`remove tracks from playlist: ${uuidArray.length}, new playlist size: ${this.#playlist.length}`);
        await this.#saveState();
    }

    /**
     * 播放当前曲目
     * @returns {Promise<boolean>}
     */
    playPause() {
        if (!this.#playerState.playing) {
            if(this.#playlist.length === 0) return false;
            if( !this.#currentUuid ) this.#currentUuid = this.#getNextUuid();
            this.playByUuid(this.#currentUuid);
        }else{
            this.#mpvPlayer.togglePause();
        }
    }
    /**
     * 通过uuid播放曲目
     * @param {string} uuid
     * @returns {Promise<boolean>}
     */
    playByUuid(uuid) {
         if(this.#playerState.playing) {
            this.#mpvPlayer.stop() 
        };
        logger.info('play track by uuid', uuid);
        const item = this.#playlist.find((t) => t.uuid === uuid);
        if (!item || !item.filepath) {
            logger.warn('invalid item uuid of playlist', uuid);
            return false;
        }
        this.#currentUuid = item.uuid;
        this.#mpvPlayer.play(item.filepath);
    }
    /**
     * 停止播放
     * @returns {boolean}
     */
    stop() { this.#mpvPlayer.stop(); }
    /**
     * 播放下一曲/上一曲
     * @param {number} dir 1=下一曲，-1=上一曲
     * @returns {Promise<boolean>}
     */
    playNext(dir) {
        logger.info('play next, dir = ', dir);
        this.playByUuid(this.#getNextUuid(dir));
    }
    /**
     * 切换暂停/播放
     * @returns {boolean}
     */
    togglePause() { this.#mpvPlayer.togglePause(); }
    /**
     * 跳转播放位置
     * @param {number} pos 秒
     * @returns {boolean}
     */
    seek(pos) { this.#playerState.playing && this.#mpvPlayer.seek(pos); }
    /**
     * 设置音量
     * @param {number} vol 0‑100
     * @returns {Promise<boolean>}
     */
    setVolume(vol) { this.#mpvPlayer.setVolume(Math.min(Math.max(vol, 0), 100)); }
    /**
     * 切换静音
     * @returns {boolean}
     */
    toggleMute() { this.#mpvPlayer.toggleMute(); }
    /**
     * 设置循环播放（开关切换）
     * @returns {Promise<boolean>}
     */
    async toggleLoop() { this.#mpvPlayer.setLoop(!this.#playerState.loop); }
    /**
     * 设置随机播放（开关切换）
     * @returns {Promise<boolean>}
     */
    async toggleRandom() {
        const random = !this.#playerState.random;
        logger.info('toggle random to ', random)
        this.#updatePlayerState({random: random});
    }
 
    /**
     * 从磁盘加载持久化数据
     */
    async #loadState() {
        if (!this.#dataFile) return;
        try {
            if (!fsSync.existsSync(this.#dataFile)) {
                logger.info('playstate.json not exist, skip load');
                return;
            }
            const raw = await fs.readFile(this.#dataFile, 'utf8');
            const json = JSON.parse(raw);
            Object.assign(
                this.#playerState, 
                json.playerState, 
                {
                    playing: false,
                    playerError: false
                });
             this.#playlist = [...json.playlist];
             this.#currentUuid = json.currentUuid;
            logger.info('load persisted data success');
        } catch (err) {
            logger.warn('load persisted data failed:', err);
        }
    }
    /**
     * 保存持久化数据到磁盘
     */
    async #saveState() {
        if (!this.#dataFile) return;
        try {
            await fs.writeFile(this.#dataFile, 
                JSON.stringify({ 
                    playerState: this.#playerState,
                    playlist: this.#playlist,
                    currentUuid: this.#currentUuid
                    }, 
                    null, 2), 'utf8');
            logger.debug('save persisted data success');
        } catch (err) {
            logger.warn('save persisted data failed', err);
        }
    }

    #updatePlayerState(state={}){
        Object.assign(this.#playerState, state);
        this.emit(PlayService.EVENTS.STATUS, this.#playerState);
    }
    #emitCurrentTrack(){ this.emit(PlayService.EVENTS.CURRENT_TRACK, this.getCurrentUuid()); }
    #emitPlaylistUpdated(){ this.emit(PlayService.EVENTS.PLAYLIST_UPDATED, this.#playlist); }
    
    /**
     * 根据当前曲目uuid，获取下一首uuid
     * @param {string} currentUuid 当前播放uuid
     * @param {number} direction 1下一首，-1上一首
     * @returns {string|null}
     */
    #getNextUuid(direction) {
        const { random } = this.#playerState;
        const len = this.#playlist.length;
        if (len === 0) return null;

        // 先根据uuid找到当前在playlist里的下标
        const currentIdx = this.#playlist.findIndex(track => track.uuid === this.#currentUuid);
        if(currentIdx < 0) return this.#playlist[0]?.uuid;

        let nextIdx = -1;
        if (random) {
            do {
                nextIdx = Math.floor(Math.random() * len);
            } while(nextIdx === currentIdx && len > 1);
            logger.debug(`getNextUuid random mode, nextIdx: ${nextIdx}`);
        } else {
            nextIdx = currentIdx + direction;
            if (nextIdx >= len) nextIdx = 0;
            else if (nextIdx < 0) nextIdx = len - 1;
            logger.debug(`getNextUuid normal mode, direction:${direction}, nextIdx:${nextIdx}`);
        }

        return this.#playlist[nextIdx]?.uuid;
    }

    async destroy() {
        await this.#saveState();
        if(this.#destroying) return;
        logger.info('destroy begin');
        this.#destroying = true;
        try {
            await super.destroy();
            await this.#mpvPlayer.destroy();
            this.removeAllListeners();
            logger.info('destroy done');
        } catch (e) {
            logger.warn('super destroy error', e);
        }
    }
}
module.exports = PlayService;
