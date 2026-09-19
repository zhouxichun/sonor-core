const BroadcastService = require('../services/BroadcastService');
const SystemService = require('../services/SystemService');
const AudioLibraryService = require('../services/AudioLibraryService');
const PlayerService = require('../services/PlayerService');
const PlaylistService = require('../services/PlaylistService');
const LyricService = require('../services/LyricService');
const UsbService = require('../services/UsbService');
const logger = require('../utils/logger')('routes');
const { customAlphabet } = require('nanoid');
const nanoid4 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 4);

async function routes(fastify) {
    const audioLibraryService = new AudioLibraryService();
    const playlistService =  new PlaylistService();
    const playerService =  new PlayerService();
    const usbService = new UsbService();
    const lyricService = new LyricService();

    let serviceReady = false;
    // ========== 全部回调放到最前面定义 ==========
    const cbScanNotify = payload => BroadcastService.broadcastNotify(payload.message, payload.level);
    const cbGroupStatsUpdate = (data) => {
        serviceReady = true;
        BroadcastService.broadcast({type:'group-stats',data:data});
    }

    const cbCoverReady = (data) => BroadcastService.broadcast({type:'track-cover',data:data});
    const cbPlaylistUpdated = payload => {
        const {action, count} = payload;
        switch(action){
            case 'add':
                if(count > 0){
                    BroadcastService.broadcastNotify(`播放列表已更新, 增加 ${count} 首曲目`,'success');
                    BroadcastService.broadcast({type:'playlist', data: playlistService.getPlaylist()});
                }else{BroadcastService.broadcastNotify('已在播放列表中, 无需重复操作');}
                break;
            case 'remove':
                if(count > 0){
                    BroadcastService.broadcastNotify(`播放列表已更新, 移除 ${count} 首曲目`, 'success'); 
                    BroadcastService.broadcast({type:'playlist', data: playlistService.getPlaylist()});
                }else{BroadcastService.broadcastNotify('未移除任何曲目');}
                break;
            case 'clear':
                BroadcastService.broadcastNotify('播放列表已清空', 'success'); 
                BroadcastService.broadcast({type:'playlist', data: playlistService.getPlaylist()});
                break;
            default:
                break;
        }
    } 
    const cbCurrentUuid = (uuid) => {
        logger.info('track changed:', uuid);
        if( uuid ){
            const track = audioLibraryService.getTrackByUuid(uuid);
            if(!track){
                logger.error('audio file missing, uuid:', uuid);
                return;
            }
            audioLibraryService.readyCover(track.uuid);
            BroadcastService.broadcast({type:'current-track',data: track});
            playerService.playback(track.filepath);
        }else{
            playerService.stop();
            BroadcastService.broadcast({type:'track-cover',data: {}});
            BroadcastService.broadcast({type:'current-track',data: {}});
        }
        
    }
    const cbPlayerStatusUpdated = (data) => BroadcastService.broadcast({type:'player-status',data});
    const cbEndFile = () =>{
        logger.info('playback end and go next');
        playlistService.goNext();
    }
    const cbTimeUpdated = (data) => BroadcastService.broadcast({type:'player-time',data});
    const cbUsbDeviceAdded = (devices) => {
        logger.info('usb devices added:', devices);
        BroadcastService.broadcast({type:'usb-devices', data: usbService.getDevices()});
        for (const device of devices) {
            BroadcastService.broadcastNotify('发现USB设别');
            audioLibraryService.addDevice(device.path);
        }
        audioLibraryService.GroupStats();
    }

    const cbUsbDeviceRemoved = (devices) => {
        logger.info('usb devices removed:', devices);
        BroadcastService.broadcast({type:'usb-devices', data: devices})
        for (const device of devices) {
            BroadcastService.broadcastNotify('USB设别已移除');
            audioLibraryService.removeDevice(device.path);
        }
        audioLibraryService.GroupStats();
    }

    const cbLyricLoaded = payload => {
        const {uuid,data} = payload;
        if(data && data.lrc)
            BroadcastService.broadcast({type:'lyric_loaded', data:{uuid:uuid, lyric:data.lrc}});
    }

    fastify.addHook('onReady', async () => {
        logger.info('fastify ready, starting business services');
        // 注册监听
        usbService.onDeviceAdded(cbUsbDeviceAdded);
        usbService.onDeviceRemoved(cbUsbDeviceRemoved);
        audioLibraryService.onGroupStatsUpdate(cbGroupStatsUpdate);
        audioLibraryService.onScanNotify(cbScanNotify);
        audioLibraryService.onCoverReady(cbCoverReady);
        playlistService.onPlaylistUpdated(cbPlaylistUpdated);
        playlistService.onCurrentUuid(cbCurrentUuid);
        playerService.onPlayerStatusUpdated(cbPlayerStatusUpdated);
        playerService.onEndFile(cbEndFile);
        playerService.onTimeUpdated(cbTimeUpdated);
        lyricService.onLyricLoaded(cbLyricLoaded);
        //启动服务
        audioLibraryService.start();
        playlistService.start();
        playerService.start();
        usbService.start();
        lyricService.start();
        //
        logger.info('all services ready');
    });

    fastify.addHook('preClose', async () => {
        //
        logger.info('destroying audioLibraryService'); 
        audioLibraryService.offScanNotify(cbScanNotify);
        audioLibraryService.offGroupStatsUpdate(cbGroupStatsUpdate);
        audioLibraryService.offCoverReady(cbCoverReady);
        audioLibraryService.destroy();
        //
        logger.info('destroying playlistService'); 
        playlistService.offPlaylistUpdated(cbPlaylistUpdated);
        playlistService.offCurrentUuid(cbCurrentUuid);
        playlistService.destroy();
        //
        logger.info('destroying playerService'); 
        playerService.offPlayerStatusUpdated(cbPlayerStatusUpdated);
        playerService.offEndFile(cbEndFile);
        playerService.offTimeUpdated(cbTimeUpdated);
        playerService.destroy();
        //
        logger.info('destroying lyricService'); 
        lyricService.offLyricLoaded(cbLyricLoaded);
        lyricService.destroy();
        //
        logger.info('destroying usbService'); 
        usbService.offDeviceAdded(cbUsbDeviceAdded);
        usbService.offDeviceRemoved(cbUsbDeviceRemoved);
        usbService.destroy();
        //
        logger.info('all services destroyed');
    });

    fastify.get('/', () => { return 'Hi Sonor!'});

    fastify.get('/ws', { websocket: true }, socket => {
        if(!serviceReady) {
            socket.close(1013, 'service not ready, retry later');
            return;
        }
        const clientId = nanoid4();
        logger.debug('websocket client connected, id = ', clientId);
        BroadcastService.addClient(clientId, socket);
        
        BroadcastService.sendToClient(clientId, { type: 'hello-sonor', data: {clientId: clientId} });
        BroadcastService.sendToClient(clientId, { type: 'group-stats', data: audioLibraryService.getGroupStats() });
        BroadcastService.sendToClient(clientId, { type: 'player-status', data: playerService.getPlayerStatus() });
        BroadcastService.sendToClient(clientId, { type: 'playlist', data: playlistService.getPlaylist() });
        BroadcastService.sendToClient(clientId, { type: 'playlist-random', data: playlistService.getRandom() });
        const currentUuid = playlistService.getCurrentUuid();
        if(currentUuid){
            audioLibraryService.readyCover(currentUuid);
            BroadcastService.sendToClient(clientId, { type: 'current-track', data: audioLibraryService.getTrackByUuid(currentUuid)});
        }else{
            BroadcastService.sendToClient(clientId, { type: 'current-track', data: {}});
        }
        BroadcastService.sendToClient(clientId, { type: 'usb-devices', data: usbService.getDevices()});

        socket.on('message', async (rawMsg) => {
            let msg;
            try { msg = JSON.parse(rawMsg.toString()); } catch (err) { logger.error('ws message handle error', err); }
            if(!msg) return;
            logger.debug('ws recv:', msg);
            const {action, payload} = msg;
            switch(action){
                case 'lib-filter':
                    const tracks = audioLibraryService.filterTracks(payload);
                    BroadcastService.sendToClient(clientId, { type:'filtered-tracks', data: tracks });
                    break;
                case 'toggle-random':
                    BroadcastService.broadcast({ type:'playlist-random', data:  playlistService.toggleRandom() }); break;
                case 'playlist-add':
                    const {uuids} = payload;
                    const trackList = uuids
                    .map(uuid => audioLibraryService.getTrackByUuid(uuid))
                    .filter(Boolean)
                    .map(item => ({
                        uuid: item.uuid,
                        title: item.title,
                        artist: item.artist,
                        album: item.album,
                        genre: item.genre,
                        filepath: item.filepath
                    }));
                    playlistService.pushList(trackList);
                    break;
                case 'playlist-remove':
                    playlistService.removeTracksByUuids([payload.uuid]); break;
                case 'playlist-clear':
                    playlistService.clearPlaylist(); break;
                case 'play-uuid':
                    playlistService.setCurrentUuid(payload.uuid);
                    break;
                case 'play-pause':
                    playerService.togglePause(); 
                    break;
                case 'play-prev':
                    playlistService.goPrev(); break;
                case 'play-next':
                    playlistService.goNext(); break;
                case 'play-stop':
                    playerService.stop(); break;
                case 'play-seek':
                    playerService.seek(payload.pos); break;
                case 'toggle-loop':
                    playerService.toggleLoop(); break;
                case 'toggle-mute':
                    playerService.toggleMute(); break;
                case 'set-volume':
                    playerService.setVolume(payload.volume); break;
                case 'scan-folder':
                    audioLibraryService.scanFolder(payload.folderPath); break;
                case 'fetch-lyric':
                    lyricService.fetchLyrics(audioLibraryService.getTrackByUuid(payload.uuid)); break;
                case 'update-lyric':
                    audioLibraryService.updateTrackLyric(payload.uuid, payload.lyric); 
                    BroadcastService.broadcastNotify('歌词已更新');
                    break;
                case 'reboot':
                    BroadcastService.notify(clientId, '设备正在重启', 'warn');
                    setTimeout(() => {
                        SystemService.reboot(); 
                    }, 1000); 
                    break;
                case 'shutdown':
                    BroadcastService.notify(clientId, '设备正在关机', 'warn');
                     setTimeout(() => {
                        SystemService.shutdown(); 
                    }, 1000); 
                    break;
                default:
                    break;
            }
        });

        socket.on('close', () => {
            logger.info('websocket client closed');
            BroadcastService.removeClient(clientId, socket);
        });
        
        socket.on('error', (err) => {
            logger.warn(`ws client error: ${err.message}`);
            BroadcastService.removeClient(clientId, socket);
        });
    });
}
module.exports = routes;
