const { EventEmitter } = require('events');
const mpvDriver = require('./mpvDriver');
const BroadcastService = require('./BroadcastService');
const AudioProvider = require('./AudioProvider');

class PlayerService extends EventEmitter {
    constructor() {
        super();

        // 内部组件：USB磁盘数据提供者
        this._audioProvider= new AudioProvider();

        this._rawAudioList = [];
        this._fileFilter = null;
        this._filteredList = [];

        this._bindProviderEvents();
        this._bindMpvDriverEvents();

        this._playState = {
            filter: [],
            currentIndex: -1,
            useEQ: false,
            volume: 50,
            playing: false,
            paused: false,
            muted: false,
            loop: false,
            random: false
        }
    }

    /**
     * 初始化内部usb提供者，需要外部调用
     * @param {object} [options]
     */
    init(options = {}) {
      this.options = {...options};
      this._audioProvider.init();
    }

    _refreshFilteredList() {
        this._filteredList = [...this._rawAudioList];

        if (this._currentIndex >= this._filteredList.length) {
            this._currentIndex = -1;
        }

        this.emit('filelist:changed', this._filteredList);
        BroadcastService.broadcast({
            type: 'player:filelist',
            data: this._filteredList
        });
    }

    _bindProviderEvents() {
        const provider = this._audioProvider;
        provider.on(AudioProvider.EVENTS.AUDIOS_LOADED, (payload) => {
            this._rawAudioList = Array.isArray(payload) ? payload : [];
            this._refreshFilteredList();
            if(this._filteredList.length === 0){
              this._playState.currentIndex = -1;
              this.stop();
            }
        });
    }

    _bindMpvDriverEvents() {
        
        mpvDriver.onCurrentTimeUpdated((payload) => {
            BroadcastService.broadcast({ type: 'player:time', data: payload });
        });

        mpvDriver.onEnd((status) => {
            BroadcastService.broadcast({ type: 'player:end', data: status });
        });

        mpvDriver.onError((err) => {
            BroadcastService.broadcast({ type: 'player:error', data: err });
        });
    }

    setFileFilter(filter) {
        this._playState.filter = filter;
        this._refreshFilteredList();
    }

    calcNextIndex(direction, isRandom) {
        const len = this._filteredList.length;
        if (len === 0) return -1;

        if (isRandom) {
            return Math.floor(Math.random() * len);
        }

        let next = this._currentIndex + direction;
        if (next >= len) next = 0;
        else if (next < 0) next = len - 1;
        return next;
    }

    playFile(filePath) {
        mpvDriver.Play(filePath);
        return this;
    }

    playByIndex(index) {
        const list = this._filteredList;
        const item = list[index];
        if (!item || !item.path) return false;

        this._currentIndex = index;
        mpvDriver.Play(item.path);
        return true;
    }

    playNext(direction, isRandom) {
        const idx = this.calcNextIndex(direction, isRandom);
        if (idx === -1) return false;
        return this.playByIndex(idx);
    }

    pause() {
        mpvDriver.Pause();
        return this;
    }

    stop() {
        mpvDriver.Stop();
        return this;
    }

    seek(pos) {
        mpvDriver.Seek(pos);
        return this;
    }

    setVolume(vol) {
        mpvDriver.SetVolume(vol);
        return this;
    }

    mute() {
        mpvDriver.Mute();
        return this;
    }

    getPlayerStatus() {
        return mpvDriver.GetStatus();
    }

    getCurrentIndex() {
        return this._currentIndex;
    }

    /**
     * 对外暴露设置激活磁盘，透传给内部provider
     * @param {string} mountpoint
     */
    selectDisk(mountpoint) {
        this._audioProvider.setActiveDisk(mountpoint);
    }

    destroy() {
        // 销毁内部usb组件
        this._audioProvider.destroy();

        mpvDriver.removeAllListeners();
        mpvDriver.Destroy();

        this._rawAudioList = [];
        this._filteredList = [];
        this._fileFilter = null;
        this._currentIndex = -1;
        this.removeAllListeners();
    }
}

module.exports = PlayerService;