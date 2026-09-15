const fs = require('fs');
const path = require('path');
const BroadcastService = require('../services/BroadcastService');
const logger = require('../utils/logger')('routes');

async function routes(fastify, opts) {
    const {playService, audioLibraryService, systemService } = fastify;

    fastify.get('/', () => { return 'Hi Sonor!'});
    
    // 保存回调引用
    const onNotification = (data) => BroadcastService.broadcast({ type: 'notification', data });
    const onGroupStatsUpdate = (data) => BroadcastService.broadcast({type:'group-stats',data});
    const onCoverReady = (data) => BroadcastService.broadcast({type:'track-cover',data});
    const onStateUpdated = (data) => BroadcastService.broadcast({type:'player-status',data});
    const onTimeUpdated = (data) => BroadcastService.broadcast({type:'player-time',data});
    const onCurrentTrack = (uuid) => {
        const track = audioLibraryService.getTrackByUuid(uuid);
        BroadcastService.broadcast({type:'current-track',data:track});
        audioLibraryService.readyCover(uuid);
    };
    const onPlaylistUpdated = (playlist) => BroadcastService.broadcast({type:'playlist',data:playlist});

    // 注册监听
    
    audioLibraryService.onGroupStatsUpdate(onGroupStatsUpdate);
    audioLibraryService.onCoverReady(onCoverReady);
    audioLibraryService.onNotification(onNotification);
    playService.onStateUpdated(onStateUpdated);
    playService.onTimeUpdated(onTimeUpdated);
    playService.onCurrentTrack(onCurrentTrack);
    playService.onPlaylistUpdated(onPlaylistUpdated);
    playService.onNotification(onNotification);
    // 插件关闭时解绑，防止重复注册
    fastify.addHook('onClose', async () => {
        audioLibraryService.offGroupStatsUpdate(onGroupStatsUpdate);
        audioLibraryService.offCoverReady(onCoverReady);
        audioLibraryService.offNotification(onNotification);
        playService.offStateUpdated(onStateUpdated);
        playService.offTimeUpdated(onTimeUpdated);
        playService.offCurrentTrack(onCurrentTrack);
        playService.offPlaylistUpdated(onPlaylistUpdated);
        playService.offNotification(onNotification);
    });

    fastify.get('/ws', { websocket: true }, socket => {
        logger.debug('websocket client connected');
        BroadcastService.addClient(socket);
        // 同步加入fastify.wsClients集合，用于优雅关闭时批量断开
        fastify.wsClients.add(socket);
        // 新客户端连上，立刻下发播放器状态  
        function safeSend(payload) {
            try {
                socket.send(JSON.stringify(payload));
            } catch (e) { logger.debug('ws send failed, client may be disconnected:', e.message); }
        }      

        safeSend({ type: 'player-status', data: playService.getStatus() });
        safeSend({ type: 'playlist', data: playService.getPlaylist() });
        safeSend({ type: 'group-stats', data: audioLibraryService.getGroupStats() });
        safeSend({ type: 'usb-devices', data: audioLibraryService.getFolders() });

        const uuid = playService.getCurrentUuid();
        if (uuid) {
            safeSend({ type: 'current-track', data: audioLibraryService.getTrackByUuid(uuid)});
            audioLibraryService.readyCover(uuid);
        }
        
        socket.on('message', async (rawMsg) => {
            let msg;
            try {
                msg = JSON.parse(rawMsg.toString());
            } catch (err) { logger.error('ws message handle error', err); }

            if(!msg) return;
            logger.debug('ws recv:', msg);

            const {action, payload} = msg;
            switch(action){
                case 'lib-filter':
                    const tracks = audioLibraryService.filterTracks(payload);
                    safeSend({ type:'filtered-tracks', data: tracks });
                    break;
                case 'play-uuid':
                    playService.playByUuid(payload.uuid); break;
                case 'play-pause':
                    playService.playPause(); break;
                case 'play-prev':
                    playService.playNext(-1); break;
                case 'play-next':
                    playService.playNext(1); break;
                case 'play-stop':
                    playService.stop(); break;
                case 'play-seek':
                    playService.seek(payload.pos); break;
                case 'toggle-loop':
                    playService.toggleLoop(); break;
                case 'toggle-random':
                    playService.toggleRandom(); break;
                case 'toggle-mute':
                    playService.toggleMute(); break;
                case 'set-volume':
                    playService.setVolume(payload.volume); break;
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
                    playService.pushList(trackList);
                    break;
                case 'playlist-remove':
                    playService.removeTracksByUuids([payload.uuid]); break;
                case 'playlist-clear':
                    playService.clearPlaylist(); break;
                case 'scan-folder':
                    audioLibraryService.scanFolder(payload.folderPath); break;
                case 'reboot':
                    systemService.reboot(); break;
                case 'shutdown':
                    systemService.shutdown(); break;
                default:
                    break;
            }

        });
        // ==========================================

        socket.on('close', () => {
            logger.info('websocket client closed');
            BroadcastService.removeClient(socket);
            fastify.wsClients.delete(socket);
        });
        socket.on('error', (err) => {
            logger.warn(`ws client error: ${err.message}`);
            BroadcastService.removeClient(socket);
            fastify.wsClients.delete(socket);
        });
    });
}
module.exports = routes;