class PlaylistService {
    #_playlist;

    constructor() {
        this.#_playlist = {
            currentIndex: -1,
            filelist: []
        };
    }

    pushFiles(files) {
        if (!Array.isArray(files) || files.length === 0) return;

        this.#_playlist.filelist.push(...files);
        if (this.#_playlist.currentIndex < 0) {
            this.#_playlist.currentIndex = this.#_playlist.filelist.length - 1;
        }
        this.#_savePlaylist();
    }

    getPlaylist() {
        return {
            currentIndex: this.#_playlist.currentIndex,
            filelist: [...this.#_playlist.filelist]
        };
    }

    getCurrentFile() {
        const { currentIndex, filelist } = this.#_playlist;
        return currentIndex >= 0 && currentIndex < filelist.length
            ? filelist[currentIndex]
            : null;
    }

    getRandomFile() {
        const { filelist } = this.#_playlist;
        const len = filelist.length;

        if (len === 0) {
            this.#_playlist.currentIndex = -1;
        } else if (len === 1) {
            this.#_playlist.currentIndex = 0;
        } else {
            let newIdx;
            const oldIdx = this.#_playlist.currentIndex;
            do {
                newIdx = Math.floor(Math.random() * len);
            } while (newIdx === oldIdx);
            this.#_playlist.currentIndex = newIdx;
        }

        this.#_savePlaylist();
        return this.getCurrentFile();
    }

    getNextFile() {
        const { filelist } = this.#_playlist;
        const len = filelist.length;
        if (len === 0) {
            this.#_playlist.currentIndex = -1;
        } else {
            this.#_playlist.currentIndex += 1;
            if (this.#_playlist.currentIndex >= len) {
                this.#_playlist.currentIndex = -1;
            }
        }
        this.#_savePlaylist();
        return this.getCurrentFile();
    }

    getPrevFile() {
        const { filelist } = this.#_playlist;
        const len = filelist.length;
        this.#_playlist.currentIndex -= 1;
        this.#_savePlaylist();
        return this.getCurrentFile();
    }

    setCurrentIndex(idx) {
        const { filelist } = this.#_playlist;
        if (Number.isInteger(idx) && idx >= 0 && idx < filelist.length) {
            this.#_playlist.currentIndex = idx;
            this.#_savePlaylist();
            return this.getCurrentFile();
        }
        return null;
    }

    clear() {
        this.#_playlist.currentIndex = -1;
        this.#_playlist.filelist = [];
        this.#_savePlaylist();
    }

    #_savePlaylist() {
        // TODO: 持久化到json文件
    }
}

module.exports = new PlaylistService();