const fs = require('fs').promises;
const path = require('path');
const { EventEmitter } = require('events');
const MusicMetadata = require('music-metadata');
const DEFAULT_AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.ape']);
const crypto = require('crypto');
const logger = require('../utils/logger')('AudioScanner');
class AudioScanner extends EventEmitter {
    #targetFolderPath;
    #audioExtSet;
    #scanning;
    #abort;
    #existFiles;
    #addedCount;
    #bufferSize;
    #bufferItems;
    /**
     * 单目录音频扫描器
     * @param {string} folderPath 扫描目录绝对路径
     * @param {string[]} existingPaths 已入库音频文件完整路径数组，扫描时跳过
     * @param {Set<string>} [audioExtSet] 音频后缀集合
     * @param {number} [bufferSize=50] 批量缓冲区大小，攒够该数量触发scan:buffer事件
     */
    constructor(folderPath, existFiles, audioExtSet = DEFAULT_AUDIO_EXT, bufferSize = 50) {
        super();
        this.#targetFolderPath = folderPath;
        this.#audioExtSet = audioExtSet;
        this.#scanning = false;
        this.#abort = false;
        this.#existFiles = new Set(existFiles);
        this.#addedCount = 0;
        this.#bufferSize = bufferSize;
        this.#bufferItems = [];
        logger.info(`created, folder:${folderPath}, existFiles:${this.#existFiles.size}, bufferSize:${bufferSize}`);
    }
    async start() {
        if (this.#scanning) {
            logger.warn('already scanning, pass', this.#targetFolderPath);
            return;
        }
        this.#scanning = true;
        this.#abort = false;
        this.#addedCount = 0;
        this.#bufferItems = [];
        logger.info('scanning', this.#targetFolderPath);
        try {
            await this.#scanDir(this.#targetFolderPath);
            await this.#flushBuffer();
            if (!this.#abort) {
                logger.info(`scan complete, folder:${this.#targetFolderPath}, addedCount:${this.#addedCount}`);
                this.emit('scan:finish', this.#targetFolderPath, this.#addedCount);
            } else {
                logger.info(`aborted, folder:${this.#targetFolderPath}, addedCount:${this.#addedCount}`);
            }
        } catch (err) {
            await this.#flushBuffer();
            logger.error('scan exception', this.#targetFolderPath, err);
            this.emit('scan:error', this.#targetFolderPath, err);
        } finally {
            this.#scanning = false;
        }
    }
    stop() {
        logger.info('stop requested', this.#targetFolderPath);
        this.#abort = true;
    }
    /**
     * 强制刷出缓冲区，触发scan:buffer事件，清空本地buffer
     */
    async #flushBuffer() {
        if (this.#bufferItems.length === 0) return;
        const items = [...this.#bufferItems];
        this.#bufferItems = [];
        this.emit('scan:buffer', items);
    }
    async #scanDir(dir) {
        if (this.#abort) return;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (this.#abort) return;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await this.#scanDir(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (!this.#audioExtSet.has(ext)) continue;
                if (this.#existFiles.has(fullPath)) {
                    continue;
                }
                const trace = await this.#parseSingleFile(fullPath)
                    .catch((err) => {
                        logger.warn('file parse failed', fullPath, err);
                        return null;
                    });
                if (trace) {
                    this.#addedCount++;
                    this.#bufferItems.push(trace);
                    if (this.#bufferItems.length >= this.#bufferSize) {
                        await this.#flushBuffer();
                    }
                }
            }
        }
    }
    async #parseSingleFile(filePath) {
        try {
            const meta = await MusicMetadata.parseFile(filePath, {
                duration: true,
                skipCover: true
            });
            // 提取内嵌歌词，取第一条
            let lyric = '';
            if (meta.common.lyrics && meta.common.lyrics.length > 0) {
                lyric = meta.common.lyrics[0].text ?? '';
            }
            return {
                uuid: crypto.randomUUID(),
                filepath: filePath,
                filename: path.basename(filePath),
                title: meta.common.title,
                artist: meta.common.artist ?? '',
                album: meta.common.album ?? '',
                duration: meta.format?.duration ?? 0,
                genre: meta.common.genre?.join(',') ?? '未知',
                lyric,
                format: meta.format ?? {}
            };
        } catch (err) {
            logger.warn('parse file meta failed', filePath, err);
            // 解析失败兜底结构
            return {
                uuid: crypto.randomUUID(),
                filepath: filePath,
                filename: path.basename(filePath),
                title: null,
                artist: '',
                album: '',
                duration: 0,
                genre: '',
                lyric: '',
                format: {}
            };
        }
    }
}
module.exports = AudioScanner;