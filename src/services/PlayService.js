const SonorService = require('./SonorService');
const fs = require('fs').promises;
const fsSync = require('fs');
const MpvPlayer = require('./MpvPlayer');
const path = require('path');
class PlayService extends SonorService {
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
        this.#dataFile = path.join(this.dataPath, 'playstate.json');

        this.#mpvPlayer = new MpvPlayer({ updateInterval: 1000 });
        this.#mpvPlayer.onCurrentTimeUpdated((sec) => {
            console.log('mpv current time updated', sec);
            this.emit('player:time', sec);
        });
        this.#mpvPlayer.onEnd(() => {
            console.log('mpv end');
            this.playNext();
        });
        this.#mpvPlayer.onError((err) => {
            console.log('mpv error', err);
        });
    }
    async start() {
        await this.#loadState();
        this.#mpvPlayer.start();
        this.#mpvPlayer.setVolume(this.#persistData.volume);
        this.#mpvPlayer.setEQ(this.#persistData.eq);
        this.#mpvPlayer.setLoop(this.#persistData.loop);
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
        this.#persistData.playlist.push(...trackList);
        await this.#saveState();
    }

    async clearPlaylist() {
        this.#persistData.playlist = [];
        this.#persistData.currentIndex = -1;
        await this.#saveState();
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
        // 过滤掉需要删除的项
        const newList = oldList.filter(item => !removeSet.has(item.uuid));

        // 判断当前index对应的条目是否被删掉
        const currentItem = oldList[this.#persistData.currentIndex];
        if (currentItem && removeSet.has(currentItem.uuid)) {
            this.#persistData.currentIndex = -1;
        }

        this.#persistData.playlist = newList;
        await this.#saveState();
    }

    /**
     * 播放，不传uuid则播放下一曲；传入uuid则播放对应曲目
     * @param {string} [uuid] - 可选，曲目uuid
     * @returns {boolean}
     */
    play(uuid) {
        let idx;
        if (uuid) {
            idx = this.#persistData.playlist.findIndex(item => item.uuid === uuid);
            if (idx === -1) return false;
        } else {
            idx = this.#calcIndex(1);
            if (idx === -1) return false;
        }
        return this.playByIndex(idx);
    }

    playPrevious() {
        const idx = this.#calcIndex(-1);
        if (idx === -1) return false;
        return this.playByIndex(idx);
    }

    playByIndex(index) {
        const item = this.#persistData.playlist[index];
        if (!item || !item.filepath) return false;
        this.#persistData.currentIndex = index;
        this.#saveState();
        this.#mpvPlayer.play(item.filepath);
        this.#playing = true;
        return true;
    }
    pause() {
        this.#mpvPlayer.pause();
        this.#paused = true;
        return this;
    }
    stop() {
        this.#mpvPlayer.stop();
        this.#playing = false;
        this.#paused = false;
        return this;
    }
    seek(pos) {
        this.#mpvPlayer.seek(pos);
        return this;
    }
    setVolume(vol) {
        this.#persistData.volume = Math.min(Math.max(vol, 0), 100);
        this.#mpvPlayer.setVolume(this.#persistData.volume);
        this.#saveState();
        return this;
    }
    mute() {
        this.#mpvPlayer.mute();
        this.#muted = !this.#muted;
        return this;
    }
    setEQ(eqStr) {
        this.#persistData.eq = eqStr ?? '';
        this.#mpvPlayer.setEQ(this.#persistData.eq);
        this.#saveState();
        return this;
    }
    setLoop(enable) {
        this.#persistData.loop = Boolean(enable);
        this.#mpvPlayer.setLoop(this.#persistData.loop);
        this.#saveState();
        return this;
    }
    setRandom(enable) {
        this.#persistData.random = Boolean(enable);
        this.#saveState();
        return this;
    }
    getPlaylist() {
        return [...this.#persistData.playlist];
    }
    async destroy() {
        await super.destroy();
        this.#mpvPlayer.removeAllListeners();
        await this.#mpvPlayer.destroy();
        await this.#saveState();
    }
}
module.exports = PlayService;
