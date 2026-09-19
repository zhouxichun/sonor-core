const SonorService = require('./SonorService');
const logger = require('../utils/logger')('LyricService');
class LyricService extends SonorService {
  static EVENTS = {
    LYRICS_LOADED: 'lyrics:loaded'
  };
  #apiBase = 'http://127.0.0.1:3000';
  constructor(opts) {
    super();
  }
  onLyricLoaded = function(callback){ return this.on(LyricService.EVENTS.LYRICS_LOADED, callback); }
  offLyricLoaded = function(callback){ return this.off(LyricService.EVENTS.LYRICS_LOADED, callback); }
  fetchLyrics(track) {
    const {uuid, title, artist } = track;
    
    const keywords = `${title || ''} ${artist || ''}`.trim();
    if (!keywords) {
      this.emit(LyricService.EVENTS.LYRICS_LOADED, { uuid, data: null });
      return;
    }
    const searchParams = new URLSearchParams();
    searchParams.set('keywords', keywords);
    const searchUrl = `${this.#apiBase}/search?${searchParams.toString()}`;
    const fetchOpts = {
      signal: AbortSignal.timeout(6000)
    };
    fetch(searchUrl, fetchOpts)
    .then(resp => resp.json())
    .then(searchRes => {
      if (!searchRes.result || !searchRes.result.songs || searchRes.result.songs.length === 0) {
        this.emit(LyricService.EVENTS.LYRICS_LOADED, { uuid, data: null });
        return null;
      }
      const songId = searchRes.result.songs[0].id;
      const lyricUrl = `${this.#apiBase}/lyric?id=${songId}`;
      return fetch(lyricUrl, fetchOpts);
    })
    .then(resp => {
      if (!resp) return;
      return resp.json();
    })
    .then(lrcRes => {
      if (!lrcRes || !lrcRes.lrc || !lrcRes.lrc.lyric) {
        this.emit(LyricService.EVENTS.LYRICS_LOADED, { uuid, data: null });
        return;
      }
      const rawItem = {
        syncedLyrics: lrcRes.lrc.lyric,
        plainLyrics: lrcRes.tlyric?.lyric || ''
      };
      this.#packResult(rawItem, uuid);
    })
    .catch(err => {
      logger.error('netease lyrics fetch error', err.message);
    });
  }
  #packResult(rawItem, uuid) {
    const result = {
      lrc: rawItem.syncedLyrics || '',
      plain: rawItem.plainLyrics || '',
      lines: this.#parseLrc(rawItem.syncedLyrics || '')
    };
    this.emit(LyricService.EVENTS.LYRICS_LOADED, { uuid, data: result });
  }
  #parseLrc(lrcText) {
    if (!lrcText) return [];
    const reg = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/g;
    const lines = [];
    let match;
    while ((match = reg.exec(lrcText)) !== null) {
      const min = Number(match[1]);
      const sec = Number(match[2]);
      const ms = Number(match[3]);
      const time = min * 60 + sec + ms / 1000;
      lines.push({ time, text: match[4].trim() });
    }
    return lines.sort((a, b) => a.time - b.time);
  }
  destroy() {
    logger.info('LyricService destroy done');
  }
}
module.exports = LyricService;
