const app = angular.module('sonorApp', []);
app.controller('MainCtrl',['$scope','$http','$timeout',function($scope,$http,$timeout){
    const apiBase = '/api';
    // ====================== 全局状态变量 ======================
    // 视图与筛选状态
    $scope.viewMode = 'player';
    $scope.libFilter = {keyword:''};
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
    $scope.withLoading = function(fn) {
        if ($scope.loading) return;
        $scope.loading = true;
        const done = () => {
            clearTimeout(timeoutId);
            $scope.$applyAsync(() => $scope.loading = false);
        };
        const timeoutId = setTimeout(() => {
            console.warn('withLoading timeout fallback trigger! maybe done() not called');
            done();
        }, 5000);
        return fn(done);
    };
    /**
     * 弹出toast提示，3秒自动消失
     * @param {string} msg
     */
    $scope.showToast = function(msg){
        $scope.toastMessage = msg;
        setTimeout(()=>{
            $scope.$apply(()=>{ $scope.toastMessage = ''; });
        },3000);
    };
    /**
     * 获取音频无损/有损标签文本
     * @param {object} track
     * @returns {string}
     */
    $scope.getLosslessLabel = function(track){ return track.format.lossless ? '无损' : '有损'; };
    /**
     * 切换页面视图
     * @param {string} mode player / library / playlist / setup
     */
    $scope.switchView = function(mode){ $scope.viewMode = mode; };
    /**
     * 
     */
    $scope.$watch('viewMode', function(newVal){
        if(newVal === 'playlist'){
           $scope.loadPlaylist();
        }
        // 切到设置页面，加载目录列表
        if(newVal === 'setup'){
            $scope.loadFolderList();
        }
    });
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
    $scope.toggleDropdown = function(uuid) { $scope.openDropdownUuid = ($scope.openDropdownUuid === uuid) ? null : uuid; };
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
                case 'current_track':{
                    console.log(msg.data);
                    $scope.currentTrack = msg.data;
                    if(!$scope.currentTrack) return;
                    //进度条
                    $scope.totalTime = $scope.currentTrack.duration || 0;
                    $scope.progressPercent = $scope.totalTime > 0 ? ($scope.currentTime / $scope.totalTime)*100 : 0;
                    //封面
                    $scope.loadTrackThumbCover($scope.currentTrack.uuid);
                    //歌词
                    $scope.parsedLyric = parseLrc($scope.currentTrack.lyric);
                    //
                    $scope.scrollToCurrentPlaying();
                    break;
                }
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
    $scope.playTrack = function(uuid) {
        $scope.openDropdownUuid = null;
        if (!uuid) { console.warn('track uuid 缺失'); return; }
        $scope.withLoading((done) => {
            return $http.post('/api/player/play/uuid', {uuid: uuid})
            .catch(err => {
                console.error('播放请求失败', err);
            })
            .finally(done);
        });
    };
    /**
     * 播放 / 暂停切换
     */
    $scope.playPause = function(){
        $scope.withLoading((done)=>{
            return $http.post(`${apiBase}/player/playpause`)
            .catch(()=>{ $scope.showToast('操作失败'); })
            .finally(done);
        });
    };
    /**
     * 上一曲
     */
    $scope.playPrev = function(){
        $scope.withLoading((done)=>{
            return $http.post(`${apiBase}/player/prev`)
            .catch(()=>{ $scope.showToast('操作失败'); })
            .finally(done);
        });
    };
    /**
     * 下一曲
     */
    $scope.playNext = function(){
        $scope.withLoading((done)=>{
            return $http.post(`${apiBase}/player/next`)
            .catch(()=>{ $scope.showToast('操作失败'); })
            .finally(done);
        });
    };
    /**
     * 停止播放
     */
    $scope.playerStop = function(){
        $scope.withLoading((done)=>{
            return $http.post(`${apiBase}/player/stop`)
            .catch(()=>{ $scope.showToast('操作失败'); })
            .finally(done);
        });
    };
    /**
     * 切换循环模式
     */
    $scope.toggleLoop = function(){
        $scope.withLoading((done)=>{
            return $http.post(`${apiBase}/player/loop`)
            .catch(()=>{ $scope.showToast('操作失败'); })
            .finally(done);
        });
    };
    /**
     * 切换随机模式
     */
    $scope.toggleRandom = function(){
        $scope.withLoading((done)=>{
            return $http.post(`${apiBase}/player/random`)
            .catch(()=>{ $scope.showToast('操作失败'); })
            .finally(done);
        });
    };
    /**
     * 切换静音
     */
    $scope.toggleMute = function(){
        $scope.withLoading((done)=>{
            return $http.post(`${apiBase}/player/mute`)
            .catch(()=>{ $scope.showToast('操作失败'); })
            .finally(done);
        });
    };
    /**
     * 进度条点击跳转
     * @param {MouseEvent} $event
     */
    $scope.seekBarClick = function($event){
        if(!$scope.totalTime) return;
        const barEl = $event.currentTarget;
        const rect = barEl.getBoundingClientRect();
        const percent = ($event.clientX - rect.left) / rect.width;
        const targetSec = percent * $scope.totalTime;
        $scope.withLoading((done)=>{
            return $http.post(`${apiBase}/player/seek`, {pos: targetSec})
            .catch(()=>{ $scope.showToast('跳转失败'); })
            .finally(done);
        });
    };
    
    // ====================== 封面加载 ======================
    /**
     * 加载曲目缩略封面，带内存缓存
     * @param {string} uuid
     * @returns {Promise<string|null>}
     */
    $scope.loadTrackThumbCover = function(uuid) {
        if($scope.coverCache[uuid]){
             $scope.currentTrackLoadedCover = $scope.coverCache[uuid];
             return;
        }
        // 没缓存，发起http请求返回promise
        $http.get(`/api/lib/track/${uuid}/cover`, {
            params: { thumbnailWidth: 640 }
        })
        .then(res => {
            $scope.coverCache[uuid] = res.data.cover;
            $scope.currentTrackLoadedCover = res.data.cover;
        })
        .catch(() => {
            $scope.currentTrackLoadedCover = null;
        });
    };
    // ====================== 播放列表管理 ======================
    /**
     * 加载播放列表，同时保证ws连接
     */
    $scope.loadPlaylist = function(){
        $http.get(`${apiBase}/player/list`)
        .then(res=>{
            $scope.playlistTracks = res.data || [];
            $scope.scrollToCurrentPlaying();
        })
        .catch(()=>{
            $scope.showToast("获取播放列表失败");
        });
    };
        /**
     * 从播放列表移除单首歌曲
     * @param {string} uuid
     */
    $scope.removeFromPlaylist = function(uuid){
        $scope.openDropdownUuid = null;
        if(!confirm("确定将该曲目从播放列表移除？")) return;
        $scope.withLoading((done)=>{
            return $http.post(`${apiBase}/player/list/remove`, {uuid:uuid})
            .then(()=>{
                $scope.showToast("已从播放列表移除");
            })
            .catch(()=>{ $scope.showToast("移除失败"); })
            .finally(done);
        });
    };
    /**
     * 清空整个播放列表
     */
    $scope.clearPlaylist = function(){
        if(!confirm("确定清空播放列表？")) return;
        $scope.withLoading((done)=>{
            return $http.post(`${apiBase}/player/list/clear`)
            .then(()=>{
                $scope.showToast("已清空播放列表");
                $scope.playlistTracks = [];;
            })
            .catch(()=>{ $scope.showToast("清空失败"); })
            .finally(done);
        });
    };
    /**
     * 添加单首曲目到播放列表
     * @param {string} uuid
     */
    $scope.addTrackToPlaylist = function(uuid){
        $scope.openDropdownUuid = null;
        let uuidList = uuid ? [uuid] : $scope.libTracks.map(t => t.uuid);
        $scope.withLoading((done)=>{
            return $http.post(`${apiBase}/player/list`, uuidList)
            .then(res=>{
                const count = res.data.addedCount || 0;
                count > 0 ? $scope.showToast(`成功添加${count}首曲目到播放列表`) : $scope.showToast(`首曲已在播放列表中`);
            })
            .catch(()=>{ $scope.showToast('添加失败'); })
            .finally(done);
        });
    };
    // ====================== 音乐库逻辑（艺术家/专辑/流派分组） ======================
    /**
     * 搜索音乐库曲目
     */
    $scope.doSearch = function () {
        if (!$scope.libFilter.keyword.trim()) return;
        $scope.selectedGroupName = null;
        const url = `${apiBase}/lib/filtertracks?keyword=${encodeURIComponent($scope.libFilter.keyword.trim())}`;
        $http.get(url)
        .then(res => {
            $scope.libTracks = res.data;
        })
        .catch(err => console.error('搜索失败', err));
    };
    /**
     * 切换分组类型 artist / album / genre
     * @param {string} group
     */
    $scope.switchGroup = function(group){
        $scope.libFilter.keyword = '';
        $scope.activeGroup = group;
        $scope.selectedGroupName = null;
        let url = `${apiBase}/lib/grouptotal/${group}`;
        $http.get(url)
        .then(res => {
            $scope.groupList = res.data;
        })
        .catch(err => console.error('获取分组列表失败', err));
    };
    /**
     * 点开分组项，筛选该分组下全部曲目
     * @param {object} item
     */
    $scope.openGroupItem = function(item){
        $scope.selectedGroupName = item.name;
        let baseUrl = `${apiBase}/lib/filtertracks`;
        let queryStr = '';
        switch($scope.activeGroup){
            case 'artist': queryStr = 'artist=' + encodeURIComponent(item.name); break;
            case 'album': queryStr = 'album=' + encodeURIComponent(item.name); break;
            case 'genre': queryStr = 'genre=' + encodeURIComponent(item.name); break;
        }
        const finalUrl = queryStr ? `${baseUrl}?${queryStr}` : baseUrl;
        $http.get(finalUrl)
        .then(res => {
            $scope.libTracks = res.data;
        })
        .catch(err => console.error('获取分组曲目失败', err));
    };
    // ====================== 设置模块：音源目录扫描 ======================
    $scope.folderList = [];
    /**
     * 获取音源目录列表
     */
    $scope.loadFolderList = function () {
        $http.get(`${apiBase}/lib/folders`)
        .then(res => {
            $scope.folderList = res.data || [];
        })
        .catch(err => $scope.showToast("获取目录列表失败"));
    };
    /**
     * 触发后台扫描指定文件夹
     * @param {string} folderPath
     */
    $scope.scanFolder = function(folderPath){
        $scope.withLoading((done)=>{
            return $http.post(`${apiBase}/lib/folder/scan`, { folder: folderPath })
            .then(()=>{
                $scope.showToast(`启动后台扫描: ${folderPath}`);
            })
            .catch(err => $scope.showToast("扫描启动失败"))
            .finally(done);
        });
    };
    
    // ====================== 页面初始化入口 ======================
    $scope.switchGroup('artist');
    connectWs();
}]);