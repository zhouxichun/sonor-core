const app = angular.module('sonorApp', []);
app.controller('MainCtrl',['$scope','$http','$timeout',function($scope,$http,$timeout){
    const apiBase = '/api';

    // ====================== 视图 & 筛选状态 ======================
    $scope.viewMode = 'player';
    $scope.libFilter = {keyword:'',offset:0,limit:100};
    $scope.libTracks = [];
    $scope.activeGroup = 'artist';
    $scope.groupList = [];
    $scope.selectedGroupName = null;

    // ====================== 播放器状态（websocket同步） ======================
    $scope.currentTime = 0;
    $scope.totalTime = 0;
    $scope.progressPercent = 0;
    $scope.isPlaying = false;
    $scope.volume = 50;
    $scope.loopMode = false;
    $scope.randomMode = false;
    $scope.isMuted = false;
    $scope.currentIndex = -1;
    $scope.currentTrack = null;

    // ====================== UI通用工具 ======================
    $scope.toastMessage = '';
    $scope.showToast = function(msg){
        $scope.toastMessage = msg;
        setTimeout(()=>{ $scope.$apply(()=>{ $scope.toastMessage = ''; }); },2000);
    };

    $scope.getLosslessLabel = function(track){
        if(!track || !track.format) return '未知';
        return track.format.lossless ? '无损' : '有损';
    };

    $scope.switchView = function(mode){
        $scope.viewMode = mode;
        if(mode === 'library') $scope.switchGroup($scope.activeGroup);
    };
    $scope.openPlayerDetail = function(){ $scope.switchView('player'); };

    $scope.formatSec = function(s){
        if(isNaN(s)) return '00:00';
        const m = Math.floor(s/60);
        const sec = Math.floor(s%60);
        return String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0');
    };

    // ====================== 播放列表下拉菜单 ======================
    $scope.openDropdownUuid = null;
    $scope.toggleDropdown = function(uuid) {
        $scope.openDropdownUuid = ($scope.openDropdownUuid === uuid) ? null : uuid;
    };

    // ====================== WebSocket连接处理 ======================
    let ws = null;
    function connectWs(){
        const loc = window.location;
        const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProto}//${loc.host}/api/ws`;
        ws = new WebSocket(wsUrl);
        ws.onopen = ()=>{ console.log('ws connected'); };
        ws.onmessage = (event)=>{
            const msg = JSON.parse(event.data);
            switch(msg.type){
                case 'player_status':{
                    const d = msg.data;
                    $scope.$apply(()=>{
                        $scope.isPlaying = d.playing;
                        $scope.volume = d.volume;
                        $scope.loopMode = d.loop;
                        $scope.randomMode = d.random;
                        $scope.isMuted = d.muted;
                        $scope.currentIndex = d.currentIndex;
                        if($scope.playlistTracks && $scope.playlistTracks[d.currentIndex]){
                            $scope.currentTrack = $scope.playlistTracks[d.currentIndex];
                            $scope.totalTime = $scope.currentTrack.duration || 0;
                        }else{
                            $scope.currentTrack = null;
                            $scope.totalTime = 0;
                        }

                        if($scope.currentTrack && $scope.currentTrack.lyric){
                            $scope.parsedLyric = parseLrc($scope.currentTrack.lyric);
                        }else{
                            $scope.parsedLyric = [];
                        }

                        $scope.progressPercent = $scope.totalTime > 0 ? ($scope.currentTime / $scope.totalTime)*100 : 0;
                    });
                    break;
                }
                case 'player_time':{
                    const sec = msg.data;
                    $scope.$apply(()=>{
                        $scope.currentTime = sec;
                        $scope.progressPercent = $scope.totalTime > 0 ? (sec / $scope.totalTime)*100 : 0;

                        // 标记哪一行是当前激活
                        const list = $scope.parsedLyric;
                        let activeIndex = -1;
                        for(let i=0;i<list.length;i++){
                            const line = list[i];
                            if(line.time <= sec){
                                activeIndex = i;
                            }else{
                                break;
                            }
                        }
                        // 全部重置isActive
                        list.forEach((item,idx)=>{
                            item.isActive = (idx === activeIndex);
                        });

                        // 滚动到激活行
                        if(activeIndex >=0){
                            $timeout(()=>{
                                const domLines = document.querySelectorAll('.lyric-line');
                                const activeDom = domLines[activeIndex];
                                if(activeDom){
                                    const wrap = document.querySelector('.player-detail-lyric');
                                    if(wrap){
                                        // 把当前行滚动到容器中间
                                        activeDom.scrollIntoView({behavior:'smooth', block:'center'});
                                    }
                                }
                            },0);
                        }
                    });
                    break;
                }
            }
        };
        ws.onclose = ()=>{
            console.warn('ws closed, reconnect after 3s');
            setTimeout(connectWs, 3000);
        };
        ws.onerror = (err)=>{ console.error('ws error', err); };
    }

    // ====================== 播放器控制 HTTP接口 ======================
    // 通过uuid播放曲目
    $scope.playTrack = async function(uuid) {
        $scope.openDropdownUuid = null;
        if (!uuid) { console.warn('track uuid 缺失'); return; }
        try{ 
            await $http.post('/api/player/play/uuid', {uuid: uuid}); 
        }catch (err) { console.error('播放请求失败', err); }
    };
    // 播放暂停切换
    $scope.playPause = async function(){
        try{ await $http.post(`${apiBase}/player/playpause`); }catch(e){ $scope.showToast('操作失败'); }
    };
    // 上一曲
    $scope.playPrev = async function(){
        try{ await $http.post(`${apiBase}/player/prev`); }catch(e){ $scope.showToast('操作失败'); }
    };
    // 下一曲
    $scope.playNext = async function(){
        try{ await $http.post(`${apiBase}/player/next`); }catch(e){ $scope.showToast('操作失败'); }
    };
    // 停止播放
    $scope.playerStop = async function(){
        try{ await $http.post(`${apiBase}/player/stop`); }catch(e){ $scope.showToast('操作失败'); }
    };
    // 切换循环
    $scope.toggleLoop = async function(){
        try{ await $http.post(`${apiBase}/player/loop`); }catch(e){ $scope.showToast('操作失败'); }
    };
    // 切换随机
    $scope.toggleRandom = async function(){
        try{ await $http.post(`${apiBase}/player/random`); }catch(e){ $scope.showToast('操作失败'); }
    };
    // 设置音量
    $scope.setVolume = async function(){
        try{ await $http.post(`${apiBase}/player/volume`, {volume: $scope.volume}); }catch(e){ $scope.showToast('设置音量失败'); }
    };
    // 进度跳转
    $scope.seekBarClick = async function($event){
        if(!$scope.totalTime) return;
        const barEl = $event.currentTarget;
        const rect = barEl.getBoundingClientRect();
        const percent = ($event.clientX - rect.left) / rect.width;
        const targetSec = percent * $scope.totalTime;
        try{ await $http.post(`${apiBase}/player/seek`, {pos: targetSec}); }catch(e){ $scope.showToast('跳转失败'); }
    };

    // ====================== 播放列表管理 ======================
    $scope.loadPlaylist = async function(){
        try {
            const res = await $http.get(`${apiBase}/player/list`);
            $scope.$apply(()=>{ $scope.playlistTracks = res.data.data.result || []; });
        } catch(e) { $scope.showToast("获取播放列表失败"); }
        if (!ws || ws.readyState !== WebSocket.OPEN) connectWs();
    };

    $scope.removeFromPlaylist = async function(uuid){
        $scope.openDropdownUuid = null;
        if(!confirm("确定要将该曲目从播放列表移除？")) return;
        try {
            await $http.post(`${apiBase}/player/list/remove`, [uuid]);
            $scope.showToast("已从播放列表移除");
            // 直接本地数组删除，不请求接口
            const idx = $scope.playlistTracks.findIndex(item => item.uuid === uuid);
            if(idx !== -1) $scope.playlistTracks.splice(idx, 1);
        } catch(e) {
            $scope.showToast("移除失败");
        }
    };

    $scope.clearPlaylist = async function(){
        if(!confirm("确定要清空整个播放列表？此操作不可恢复！")) return;
        try {
            await $http.post(`${apiBase}/player/list/clear`);
            $scope.showToast("已清空播放列表");
            $scope.$apply(()=>{ $scope.playlistTracks = []; });
        } catch(e) { $scope.showToast("清空失败"); }
    };

    // ====================== 音乐库逻辑 ======================
    $scope.doSearch = async function () {
        if (!$scope.libFilter.keyword.trim()) return;
        $scope.selectedGroupName = null;
        const url = `${apiBase}/lib/filtertracks?keyword=${encodeURIComponent($scope.libFilter.keyword.trim())}`;
        const res = await $http.get(url);
        $scope.$apply(() => { $scope.libTracks = res.data.data.result; });
    };

    $scope.clearSearch = function () {
        $scope.libFilter.keyword = '';
        $scope.libTracks = [];
        $scope.switchGroup($scope.activeGroup);
    };

    $scope.switchGroup = async function(group){
        $scope.libFilter.keyword = '';
        $scope.activeGroup = group;
        $scope.selectedGroupName = null;
        let url;
        switch(group){
            case 'artist': url = `${apiBase}/lib/artists`; break;
            case 'album': url = `${apiBase}/lib/albums`; break;
            case 'genre': url = `${apiBase}/lib/genres`; break;
        }
        const res = await $http.get(url);
        $scope.$apply(()=>{ $scope.groupList = res.data.data.result; });
    };

    $scope.openGroupItem = async function(item){
        $scope.selectedGroupName = item.name;
        let baseUrl = `${apiBase}/lib/filtertracks`;
        let queryStr = '';
        switch($scope.activeGroup){
            case 'artist': queryStr = 'artist=' + encodeURIComponent(item.name); break;
            case 'album': queryStr = 'album=' + encodeURIComponent(item.name); break;
            case 'genre': queryStr = 'genre=' + encodeURIComponent(item.name); break;
        }
        const finalUrl = queryStr ? `${baseUrl}?${queryStr}` : baseUrl;
        const res = await $http.get(finalUrl);
        $scope.$apply(()=>{ $scope.libTracks = res.data.data.result; });
    };

    $scope.backGroupList = function(){
        $scope.selectedGroupName = null;
        $scope.switchGroup($scope.activeGroup);
    };

    $scope.playAllCurrentTracks = async function(){
        try{
            const uuidList = $scope.libTracks.map(t => t.uuid);
            if(uuidList.length === 0) return;
            await $http.post(`${apiBase}/player/list`, uuidList);
            $scope.showToast('已全部加入播放列表');
        }catch(e){ $scope.showToast('操作失败'); }
    };

    $scope.addTrackToPlaylist = async function(track){
        try{ await $http.post(`${apiBase}/player/list`, [track.uuid]); $scope.showToast('已添加到播放列表'); }
        catch(e){ $scope.showToast('添加失败'); }
    };

    /**
     * 解析lrc歌词字符串
     * @param {string} lrcStr
     * @returns Array<{time:number,text:string}>
     */
    function parseLrc(lrcStr){
        if(!lrcStr) return [];
        const lines = lrcStr.split('\n');
        const result = [];
        // [mm:ss.xx] 正则
        const reg = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;
        for(const line of lines){
            const match = line.match(reg);
            if(!match) continue;
            const min = parseInt(match[1],10);
            const sec = parseInt(match[2],10);
            const ms = parseInt(match[3],10);
            const time = min*60 + sec + ms/1000;
            const text = line.replace(reg,'').trim();
            if(text){
                result.push({time, text});
            }
        }
        // 按时间升序
        result.sort((a,b)=>a.time - b.time);
        return result;
    }


    // ====================== 页面初始化 ======================
    $scope.loadPlaylist();
    $scope.switchGroup('artist');
}]);
