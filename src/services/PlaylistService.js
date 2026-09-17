const SonorService = require('./SonorService');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const logger = require('../utils/logger')('PlaylistService');

class PlaylistService extends SonorService {
    static EVENTS = {
        PLAYLIST_UPDATED:'playlist:playlist_updated',
        CURRENT_UUID:'playlist:current_uuid'
    };
    #dataFile = null;
    #playlist = [];
    #random = false;
    #currentUuid;
    #destroying = false;

    /**
     * 
     */
    constructor() {
        super();
        this.#dataFile = path.join(this.dataPath, 'playlist.json');
        logger.info('instance created. dataFile:', this.#dataFile);
    }

    onPlaylistUpdated(callback){ return this.on(PlaylistService.EVENTS.PLAYLIST_UPDATED, callback); }
    offPlaylistUpdated(callback){ return this.off(PlaylistService.EVENTS.PLAYLIST_UPDATED, callback); }
    onCurrentUuid(callback) { return this.on(PlaylistService.EVENTS.CURRENT_UUID, callback); }
    offCurrentUuid(callback) { return this.off(PlaylistService.EVENTS.CURRENT_UUID, callback); }

    start() {
        this.#loadData();
        logger.info('service started');
    }

    destroy() {
        this.#saveData().catch(err => {logger.error('saveData failed', err);});
        if(this.#destroying) return;
        this.#destroying = true;
        this.#playlist = null;
        logger.info('destroy done');
    }

    getRandom() { return this.#random; }
    toggleRandom() { return this.#random = !this.#random; }

    /**
     * 追加一批曲目到当前播放列表（会持久化）
     * @param {Array} trackList
     */
    pushList(trackArray) {
        if (!Array.isArray(trackArray)) throw new Error('trackArray must be array');
        
        const existUuids = new Set( this.#playlist.map(t => t.uuid) );
        const newItems = trackArray.filter(t => { return t && t.uuid && !existUuids.has(t.uuid); });
        if(newItems.length > 0) {
            this.#playlist.push(...newItems);
            logger.info(`playlist add new items count: ${newItems.length}, total: ${this.#playlist.length}`);
        }
        this.#emitPlaylistUpdated('add',newItems.length);
        if(!this.#currentUuid) this.#updateCurrentUuid(newItems[0]?.uuid)
        this.#saveData();   //异步
    }

    clearPlaylist() {
        this.#playlist = [];
        this.#emitPlaylistUpdated('clear');
        this.#updateCurrentUuid(null);
        logger.info('playlist clear');
        this.#saveData();
    }

    /**
     * 根据uuid数组删除播放列表中的曲目
     * @param {string[]} uuidArray
     */
    removeTracksByUuids(uuidArray) {
        if (!Array.isArray(uuidArray)) throw new Error('uuidArray must be array');

        const removeSet = new Set(uuidArray);
        if(removeSet.has(this.#currentUuid)) this.#updateCurrentUuid(null);

        const oldList = this.#playlist;
        this.#playlist = oldList.filter(item => !removeSet.has(item.uuid));
        logger.info(`remove tracks from playlist: ${uuidArray.length}, new playlist size: ${this.#playlist.length}`);
        this.#emitPlaylistUpdated('remove',uuidArray.length);
        this.#saveData();
    }

    #emitPlaylistUpdated(action,count=0){
        this.emit(PlaylistService.EVENTS.PLAYLIST_UPDATED, {action: action,count: count, total: this.#playlist.length});
    }

    getPlaylist() { return [...this.#playlist]; }
    getCurrentUuid() { return this.#currentUuid; }

    setCurrentUuid(uuid){ 
        const checkUuid = this.#playlist.find( t => t.uuid === uuid )?.uuid || null;
        this.#updateCurrentUuid(checkUuid);
    }
    goNext(){ this.#updateCurrentUuid(this.#calcUuid(1)); }
    goPrev(){ this.#updateCurrentUuid(this.#calcUuid(-1)); }

    /**
     * 
     * @param {*} direction 
     * @returns null | undefined | uuid
     */
    #calcUuid(direction) { 
        const len = this.#playlist.length;
        if (len === 0) return null;

        const currentIdx = this.#playlist.findIndex(t => t.uuid === this.#currentUuid);
        if(currentIdx < 0) return this.#playlist[0]?.uuid;

        let nextIdx = -1;
        if (this.#random) {
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
    
    #loadData() {
        try {
            if (!fsSync.existsSync(this.#dataFile)) {
                logger.info('data file not exist, skip load.', this.#dataFile);
                return;
            }
            const json = JSON.parse(fsSync.readFileSync(this.#dataFile, 'utf8'));
            this.#playlist = [...json.playlist];
            if(this.#playlist.find(t=>t.uuid === json.currentUuid))
                this.#currentUuid = json.currentUuid;
            else
                this.#currentUuid = this.#playlist[0]?.uuid;
            this.#random = json.random;
            logger.info('load persisted data success', this.#playlist.length, this.#currentUuid, this.#random);
        } catch (err) { logger.error('persisted data load failed:', err); }
    }

    async #saveData() {
        if (!this.#dataFile) return;
        try {
            await fs.writeFile(this.#dataFile, 
                JSON.stringify({ 
                    playlist: this.#playlist,
                    currentUuid: this.#currentUuid,
                    random: this.#random
                    }, 
                    null, 2), 'utf8');
            logger.debug('save persisted data success');
        } catch (err) { logger.warn('save persisted data failed', err); }
    }

    #updateCurrentUuid(uuid) { 
        this.#currentUuid = uuid;
        this.emit(PlaylistService.EVENTS.CURRENT_UUID, this.#currentUuid);
    };
}

module.exports = PlaylistService;
