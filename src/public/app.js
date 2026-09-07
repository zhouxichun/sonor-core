const app = angular.module('sonorApp', []);
app.controller('MainCtrl',['$scope','$http','$timeout',function($scope,$http,$timeout){
    const apiBase = '/api';

    // ====================== 全局状态变量 ======================
    // 视图与筛选状态
    $scope.viewMode = 'player';
    $scope.libFilter = {keyword:'',offset:0,limit:100};
    $scope.libTracks = [];
    $scope.activeGroup = 'artist';
    $scope.groupList = [];
    $scope.selectedGroupName = null;

    // 播放器状态（websocket同步更新）
    $scope.currentTime = 0;
    $scope.totalTime = 0;
    $scope.progressPercent = 0;
    $scope.isPlaying = false;
    $scope.isPaused = true;
    $scope.volume = 50;
    $scope.loopMode = false;
    $scope.randomMode = false;
    $scope.isMuted = false;
    $scope.currentIndex = -1;
    $scope.currentTrack = null;
    $scope.parsedLyric = [];
    $scope.currentTrackLoadedCover = null;

    // UI通用状态
    $scope.loading = false;
    $scope.toastMessage = '';
    $scope.openDropdownUuid = null;

    // 封面内存缓存
    $scope.coverCache = {};

    // 弹窗状态
    $scope.showCoverPopup = false;

    // ====================== UI通用工具函数 ======================
    /**
     * 全局防重复提交，共用一把loading锁
     * @param {Function} fn 异步业务函数
     */
    $scope.withLoading = async function(fn) {
        if ($scope.loading) return;
        $scope.loading = true;
        // 5秒超时兜底，强制解除loading
        const timeoutId = setTimeout(() => {
            $scope.$apply(() => { $scope.loading = false; });},
            5000);
        try {
            return await fn();
        } finally {
            clearTimeout(timeoutId);
            $scope.loading = false;
        }
    };

    /**
     * 弹出toast提示，3秒自动消失
     * @param {string} msg
     */
    $scope.showToast = function(msg){
        $scope.toastMessage = msg;
        setTimeout(()=>{ $scope.$apply(()=>{ $scope.toastMessage = ''; }); },3000);
    };

    /**
     * 获取音频无损/有损标签文本
     * @param {object} track
     * @returns {string}
     */
    $scope.getLosslessLabel = function(track){
        if(!track || !track.format) return '未知';
        return track.format.lossless ? '无损' : '有损';
    };

    /**
     * 切换页面视图
     * @param {string} mode player / library / playlist / setup
     */
    $scope.switchView = function(mode){ $scope.viewMode = mode; };

    /**
     * 秒数格式化 mm:ss
     * @param {number} s 秒
     * @returns {string}
     */
    $scope.formatSec = function(s){
        if(isNaN(s)) return '00:00';
        const m = Math.floor(s/60);
        const sec = Math.floor(s%60);
        return String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0');
    };

    /**
     * 关闭播放列表下拉菜单
     */
    $scope.closeDropdown = function(){ $scope.openDropdownUuid = null; };

    /**
     * 切换播放列表项下拉菜单
     * @param {string} uuid
     */
    $scope.toggleDropdown = function(uuid) {
        $scope.openDropdownUuid = ($scope.openDropdownUuid === uuid) ? null : uuid;
    };

    /**
     * 将播放列表当前播放条目滚动到视口居中
     */
    $scope.scrollToCurrentPlaying = function () {
        if ($scope.currentIndex === undefined || $scope.currentIndex < 0) {
            return;
        }
        const domId = `playlist-item-${$scope.currentIndex}`;
        const el = document.getElementById(domId);
        if (!el) return;
        el.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
        });
    };

    /**
     * 打开封面弹窗
     * @param {Event} $event
     */
    $scope.openCoverPopup = function($event) {
        $event.stopPropagation();
        $scope.currentTrackLoadedCover && ($scope.showCoverPopup = true);
    };

    /**
     * 关闭封面弹窗
     */
    $scope.closeCoverPopup = function() { $scope.showCoverPopup = false; };

    // ====================== LRC歌词解析工具 ======================
    /**
     * 解析lrc歌词字符串
     * @param {string} lrcStr
     * @returns Array<{time:number,text:string,isActive?:boolean}>
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

    // ====================== 封面加载 ======================
    /**
     * 加载曲目缩略封面，带内存缓存
     * @param {string} uuid
     */
    $scope.loadTrackThumbCover = async function(uuid) {
        if (!$scope.coverCache[uuid]) {
            try {
                const res = await $http.get(`/api/lib/track/${uuid}/cover`, {
                    params: { thumbnailWidth: 640 }
                });
                $scope.coverCache[uuid] = res.data.data.result;
            } catch (e) { 
                $scope.coverCache[uuid] = null;
            }
        }
        return $scope.coverCache[uuid];
    };

    // ====================== WebSocket连接与消息处理 ======================
    let ws = null;
    /**
     * 建立websocket连接，断开自动重连
     */
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
                        $scope.isPaused = d.paused;
                        $scope.volume = d.volume;
                        $scope.loopMode = d.loop;
                        $scope.randomMode = d.random;
                        $scope.isMuted = d.muted;
                        $scope.currentIndex = d.currentIndex;

                        if(!$scope.playlistTracks) return;
                        $scope.currentTrack = $scope.playlistTracks[d.currentIndex];
                        if(!$scope.currentTrack) return;
                        //进度条
                        $scope.totalTime = $scope.currentTrack.duration || 0;
                        $scope.progressPercent = $scope.totalTime > 0 ? ($scope.currentTime / $scope.totalTime)*100 : 0;
                        //封面
                        $scope.loadTrackThumbCover($scope.currentTrack.uuid).then(cover => {
                            $scope.$apply(()=>{
                                $scope.currentTrackLoadedCover = cover;
                            });
                        });
                        //歌词
                        if($scope.currentTrack.lyric){
                            $scope.parsedLyric = parseLrc($scope.currentTrack.lyric);
                            $scope.scrollToCurrentPlaying();
                        }else{
                            $scope.parsedLyric = [];
                        }
                    });
                    break;
                }
                case 'player_time':{
                    const sec = msg.data;
                    $scope.$apply(()=>{
                        $scope.currentTime = sec;
                        $scope.progressPercent = $scope.totalTime > 0 ? (sec / $scope.totalTime)*100 : 0;
                        // 标记当前激活歌词行
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
                        list.forEach((item,idx)=>{
                            item.isActive = (idx === activeIndex);
                        });
                        // 歌词容器滚动到激活行，居中
                        if (activeIndex >= 0) {
                            $timeout(() => {
                                const wrap = document.querySelector('.lyric-scroll-wrap');
                                const domLines = wrap?.querySelectorAll('.lyric-line');
                                if (!wrap || !domLines || !domLines[activeIndex]) return;
                                const activeDom = domLines[activeIndex];
                                const wrapRect = wrap.getBoundingClientRect();
                                const lineRect = activeDom.getBoundingClientRect();
                                const relativeTop = lineRect.top - wrapRect.top + wrap.scrollTop;
                                const halfWrap = wrap.clientHeight / 2;
                                const targetScrollTop = relativeTop - halfWrap + (activeDom.offsetHeight / 2);
                                wrap.scrollTo({
                                    top: targetScrollTop,
                                    behavior: 'smooth'
                                });
                            }, 80);
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
    /**
     * 通过uuid播放曲目
     * @param {string} uuid
     */
    $scope.playTrack = async function(uuid) {
        $scope.openDropdownUuid = null;
        if (!uuid) { console.warn('track uuid 缺失'); return; }
        return $scope.withLoading(async() => {
            try{ await $http.post('/api/player/play/uuid', {uuid: uuid}); }catch (err) { console.error('播放请求失败', err); }
        });
    };

    /**
     * 播放 / 暂停切换
     */
    $scope.playPause = async function(){
        return $scope.withLoading(async ()=>{
            try{ await $http.post(`${apiBase}/player/playpause`); }catch(e){ $scope.showToast('操作失败'); }
        });
    };

    /**
     * 上一曲
     */
    $scope.playPrev = async function(){
        return $scope.withLoading(async ()=>{
            try{ await $http.post(`${apiBase}/player/prev`); }catch(e){ $scope.showToast('操作失败'); }
        });
    };

    /**
     * 下一曲
     */
    $scope.playNext = async function(){
        return $scope.withLoading(async ()=>{
            try{ await $http.post(`${apiBase}/player/next`); }catch(e){ $scope.showToast('操作失败'); }
        });
    };

    /**
     * 停止播放
     */
    $scope.playerStop = async function(){
        return $scope.withLoading(async ()=>{
            try{ await $http.post(`${apiBase}/player/stop`); }catch(e){ $scope.showToast('操作失败'); }
        });
    };

    /**
     * 切换循环模式
     */
    $scope.toggleLoop = async function(){
        return $scope.withLoading(async ()=>{
            try{ await $http.post(`${apiBase}/player/loop`); }catch(e){ $scope.showToast('操作失败'); }
        });
    };

    /**
     * 切换随机模式
     */
    $scope.toggleRandom = async function(){
        return $scope.withLoading(async ()=>{
            try{ await $http.post(`${apiBase}/player/random`); }catch(e){ $scope.showToast('操作失败'); }
        });
    };

    /**
     * 切换静音
     */
    $scope.toggleMute = async function(){
        return $scope.withLoading(async ()=>{
            try{ await $http.post(`${apiBase}/player/mute`); }catch(e){ $scope.showToast('操作失败'); }
        });
    };

    /**
     * 设置音量，鼠标抬起触发
     * @param {number} val
     */
    $scope.setVolume = async function(val){
        const numVal = Number(val);
        try { await $http.post(`${apiBase}/player/volume`, {volume: numVal}); } catch(e) { $scope.showToast('设置音量失败'); }
    };

    /**
     * 进度条点击跳转
     * @param {MouseEvent} $event
     */
    $scope.seekBarClick = async function($event){
        if(!$scope.totalTime) return;
        const barEl = $event.currentTarget;
        const rect = barEl.getBoundingClientRect();
        const percent = ($event.clientX - rect.left) / rect.width;
        const targetSec = percent * $scope.totalTime;
        return $scope.withLoading(async ()=>{
            try{ await $http.post(`${apiBase}/player/seek`, {pos: targetSec}); }catch(e){ $scope.showToast('跳转失败'); }
        });
    };

    // ====================== 播放列表管理 ======================
    /**
     * 加载播放列表，同时保证ws连接
     */
    $scope.loadPlaylist = async function(){
        try {
            const res = await $http.get(`${apiBase}/player/list`);
            $scope.$apply(()=>{ $scope.playlistTracks = res.data.data.result || []; });
        } catch(e) { $scope.showToast("获取播放列表失败"); }
        if (!ws || ws.readyState !== WebSocket.OPEN) connectWs();
    };

    /**
     * 从播放列表移除单首歌曲
     * @param {string} uuid
     */
    $scope.removeFromPlaylist = async function(uuid){
        $scope.openDropdownUuid = null;
        if(!confirm("确定将该曲目从播放列表移除？")) return;
        return $scope.withLoading(async ()=>{
            try {
                await $http.post(`${apiBase}/player/list/remove`, [uuid]);
                $scope.showToast("已从播放列表移除");
                await $scope.loadPlaylist();
            } catch(e) { $scope.showToast("移除失败"); }
        });
    };

    /**
     * 清空整个播放列表
     */
    $scope.clearPlaylist = async function(){
        if(!confirm("确定清空播放列表？")) return;
        return $scope.withLoading(async ()=>{
            try {
                await $http.post(`${apiBase}/player/list/clear`);
                $scope.showToast("已清空播放列表");
                $scope.$apply(()=>{ $scope.playlistTracks = []; });
            } catch(e) { $scope.showToast("清空失败"); }
        });
    };

    /**
     * 添加单首曲目到播放列表
     * @param {string} uuid
     */
    $scope.addTrackToPlaylist = async function(uuid){
        $scope.openDropdownUuid = null;
        let uuidList = uuid ? [uuid] : $scope.libTracks.map(t => t.uuid);
        return $scope.withLoading(async ()=>{
            try{
                await $http.post(`${apiBase}/player/list`, uuidList);
                await $scope.loadPlaylist();
                $scope.showToast('成功添加到播放列表');
            }catch(e){ $scope.showToast('添加失败'); }
        });
    };

    // ====================== 音乐库逻辑（艺术家/专辑/流派分组） ======================
    /**
     * 搜索音乐库曲目
     */
    $scope.doSearch = async function () {
        if (!$scope.libFilter.keyword.trim()) return;
        $scope.selectedGroupName = null;
        const url = `${apiBase}/lib/filtertracks?keyword=${encodeURIComponent($scope.libFilter.keyword.trim())}`;
        const res = await $http.get(url);
        $scope.$apply(() => { $scope.libTracks = res.data.data.result; });
    };

    /**
     * 切换分组类型 artist / album / genre
     * @param {string} group
     */
    $scope.switchGroup = async function(group){
        $scope.libFilter.keyword = '';
        $scope.activeGroup = group;
        $scope.selectedGroupName = null;
        let url = `${apiBase}/lib/grouptotal/${group}`;
        const res = await $http.get(url);
        console.log('group list:', res.data);
        $scope.$apply(()=>{ $scope.groupList = res.data.data.result; });
    };

    /**
     * 点开分组项，筛选该分组下全部曲目
     * @param {object} item
     */
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


    // ====================== 设置模块：音源目录扫描 ======================
    $scope.folderList = [];

    /**
     * 获取音源目录列表
     */
    $scope.loadFolderList = async function () {
        try {
            const res = await $http.get(`${apiBase}/lib/folders`);
            $scope.$apply(() => {
                $scope.folderList = res.data.data.result || [];
            });
        } catch (e) { $scope.showToast("获取目录列表失败"); }
    };

    /**
     * 触发后台扫描指定文件夹
     * @param {string} folderPath
     */
    $scope.scanFolder = async function(folderPath){
        return $scope.withLoading(async ()=>{
            try {
                await $http.post(`${apiBase}/lib/folder/scan`, { folder: folderPath });
                $scope.showToast(`启动后台扫描: ${folderPath}`);
            } catch(e){
                $scope.showToast("扫描启动失败");
            }
        });
    };

    // ====================== $watch 视图变更监听 ======================
    $scope.$watch('viewMode', function(newVal){
        // 切到播放列表视图，等待dom渲染完成，滚动到当前播放项
        if(newVal === 'playlist'){
            $timeout(function(){
                $scope.scrollToCurrentPlaying();
            },50);
        }
        // 切到设置页面，加载目录列表
        if(newVal === 'setup'){
            $scope.loadFolderList();
        }
    });

    // ====================== 页面初始化入口 ======================
    $scope.loadPlaylist();
    $scope.switchGroup('artist');
}]);