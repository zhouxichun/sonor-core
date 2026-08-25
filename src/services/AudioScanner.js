// src/services/AudioScanner.js
const fs = require('fs').promises;
const path = require('path');
const { EventEmitter } = require('events');
const MusicMetadata = require('music-metadata');

const DEFAULT_AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.ape']);

class AudioScanner extends EventEmitter {
    #_targetFolderPath;
    #_folderItem;
    #_audioExtSet;
    #_scanning;
    #_abort;
    #_existingFilePaths; // 扫描启动时构建

    /**
     * 单文件夹扫描器，强耦合：直接修改传入 folderItem.traces
     * @param {string} folderPath 扫描目录绝对路径
     * @param {object} folderItem 上层引用 {folder:string, traces:[]}
     * @param {Set<string>} [audioExtSet] 音频后缀集合
     */
    constructor(folderPath, folderItem, audioExtSet = DEFAULT_AUDIO_EXT) {
        super();
        this.#_targetFolderPath = folderPath;
        this.#_folderItem = folderItem;
        this.#_audioExtSet = audioExtSet;

        this.#_scanning = false;
        this.#_abort = false;
        this.#_existingFilePaths = new Set();
    }

    async start() {
        if (this.#_scanning) return;
        this.#_scanning = true;
        this.#_abort = false;

        // 扫描启动瞬间快照旧文件集合
        this.#_existingFilePaths = new Set(this.#_folderItem.traces.map(t => t.path));

        try {
            await this.#_scanDir(this.#_targetFolderPath);
            if (!this.#_abort) {
                // 计算本次新增数量
                const addedCount = this.#_folderItem.traces.length - this.#_existingFilePaths.size;
                this.emit('scan:finish', this.#_targetFolderPath, addedCount);
            }
        } catch (err) {
            this.emit('scan:error', this.#_targetFolderPath, err);
        } finally {
            this.#_scanning = false;
        }
    }


    stop() {
        this.#_abort = true;
    }

    getStatus() {
        return {
            scanning: this.#_scanning,
            abort: this.#_abort,
            folderPath: this.#_targetFolderPath
        };
    }

    async #_scanDir(dir) {
        if (this.#_abort) return;
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            if (this.#_abort) return;

            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await this.#_scanDir(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (!this.#_audioExtSet.has(ext)) continue;

                // 扫描启动那一刻已经存在的文件，跳过元解析
                if (this.#_existingFilePaths.has(fullPath)) {
                    continue;
                }

                const trace = await this.#_parseSingleFile(fullPath).catch(() => null);
                if (trace) {
                    this.#_folderItem.traces.push(trace);
                }
            }
        }
    }

    async #_parseSingleFile(filePath) {
        const meta = await MusicMetadata.parseFile(filePath, { duration: true });
        return {
            path: filePath,
            filename: path.basename(filePath),
            title: meta.common.title ?? path.basename(filePath, path.extname(filePath)),
            artist: meta.common.artist ?? '',
            album: meta.common.album ?? '',
            duration: meta.format.duration ?? 0,
            genre: meta.common.genre?.join(',') ?? ''
        };
    }
}

module.exports = AudioScanner;
