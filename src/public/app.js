const app = angular.module('sonorApp', []);
app.controller('MainCtrl',['$scope','$timeout',function($scope,$timeout){
    // ====================== 全局状态变量 ======================
    const apiBase = '/api';
    $scope.clientId = null;
    // ====================== UI相关 ======================
    // 视图与筛选状态
    $scope.viewMode = 'player';
    // 弹出菜单
    $scope.openDropdownUuid = null;
    //toasts
    $scope.toastList = [];

    // 分组统计及浏览
    $scope.groupStats = {};    
    $scope.activeGroup = 'artists';
    $scope.groupList = [];
    $scope.libFilter = {keyword:''};
    $scope.libTracks = []; 

    // ====================== 播放列表 ======================
    $scope.playlist = [];
    $scope.random = false;

    // ====================== 播放相关 ======================
    $scope.playerStatus = {};
    $scope.currentTime = 0;
    $scope.totalTime = 0;
    $scope.progressPercent = 0;
    $scope.currentTrack = {};
    $scope.cover = null;
    $scope.parsedLyric = [];
    $scope.lyricAutoScroll = true;
    $scope.showCoverPopup = false;

    // ====================== 设置相关 ======================
    $scope.folderList = [];


    // ====================== UI通用工具函数 ======================
    /**
     * 弹出toast提示，支持级别、堆叠，带入场退场动画
     * @param {string} msg 消息文本
     * @param {string} level 级别: info / success / warn / error
     */
    $scope.showToast = function(payload){
        const toastId = Date.now();
        $scope.toastList.push({
            id: toastId,
            message: payload.message,
            level: payload.level || 'info',
            leaving: false // 标记是否开始退场动画
        });

        $timeout(() => {
            // 第一步：标记退场，触发css动画
            const item = $scope.toastList.find(t => t.id === toastId);
            if (!item) return;
            item.leaving = true;
            // 等退场动画结束再删除DOM
            $timeout(() => {
                const idx = $scope.toastList.findIndex(t => t.id === toastId);
                if(idx > -1){
                    $scope.toastList.splice(idx, 1);
                }
            }, 600); // 和css动画时长保持一致
        }, 2000);
    };
    /**
     * 切换页面视图
     * @param {string} mode player / library / playlist / setup
     */
    $scope.switchView = function(mode){ $scope.viewMode = mode; };
    /**
     *
     */
    $scope.$watch('viewMode', function(newVal){
        (newVal === 'playlist') && $scope.scrollToCurrentPlaying();
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
     * 切换歌词是否自动滚动
     */
    $scope.toggleLyricAutoScroll = function(){ $scope.lyricAutoScroll = !$scope.lyricAutoScroll; };
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
        if (!$scope.currentTrack) return;
        $timeout(function(){
            const domId = `pl-${$scope.currentTrack.uuid}`;
            const el = document.getElementById(domId);
            el && el.scrollIntoView({behavior: 'smooth', block: 'center'});
        })
    };
    /**
     * 打开封面弹窗
     * @param {Event} $event
     */
    $scope.openCoverPopup = function($event) {
        $event.stopPropagation();
        $scope.showCoverPopup = !!$scope.cover.base64;
    };
    /**
     * 关闭封面弹窗
     */
    $scope.closeCoverPopup = function() { $scope.showCoverPopup = false; };
  

    // ====================== webservice 消息处理 ======================
    /**
     * 筛选不同分组的统计数据并排序
     * @param {*} activeGroup 
     * @returns 
     */
    function selectGroup(activeGroup) {
        const list = $scope.groupStats[activeGroup];
        if(list && list.length > 0)
            return list.sort((a,b) => a.name.localeCompare(b.name, 'zh-CN'));
        else
            return [];
    }
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
        result.push({time:99999,text:'-> End <-'});
        return result;
    }
    WsService.on('group-stats', data => {
         $scope.$evalAsync(()=>{
            $scope.groupStats = data;
            $scope.groupList = selectGroup($scope.activeGroup);
        });
    })
    .on('filtered-tracks', data => {
         $scope.$evalAsync(()=>{
            $scope.libTracks = data;
        });
    })
    .on('playlist', data => {
        $scope.$evalAsync(()=>{
            $scope.playlist = data;
        });
    })
    .on('playlist-random', data => {
        $scope.$evalAsync(()=>{
            $scope.random = data;
        });
    })
    .on('current-track', (data)=>{
        $scope.$evalAsync(()=>{
            $scope.currentTrack = data;
            if(!$scope.currentTrack) return;
            $scope.totalTime = $scope.currentTrack.duration || 0;
            $scope.progressPercent = $scope.totalTime > 0 ? ($scope.currentTime / $scope.totalTime)*100 : 0;
            $scope.parsedLyric = parseLrc($scope.currentTrack.lyric);
            $scope.scrollToCurrentPlaying();
        });
    })
    .on('track-cover', (data)=>{
        $scope.$evalAsync(()=>{
           $scope.cover = data;
           if( data && data.theme )
            document.documentElement.style.setProperty('--base-h', $scope.cover.theme.h);
        });
    })
    .on('player-status', (data)=>{
        $scope.$evalAsync(()=>{
            $scope.playerStatus = data;
        });
    })
    .on('player-time', (data)=>{
        $scope.$evalAsync(()=>{
            const sec = data;
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
            list.forEach((item,idx)=>{ item.isActive = (idx === activeIndex);});
            if(!$scope.lyricAutoScroll) return;
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
    })
    .on('usb-devices', data => {
        $scope.$evalAsync(()=>{ $scope.usbDevices = data;});
    })
    .on('notification', payload => {
       $scope.$evalAsync(()=>{ $scope.showToast(payload); }); 
    });

    // ====================== 播放 ======================
    /**
     * 点击播放列表释放歌曲
     * @param {string} uuid
     */
    $scope.playTrack = function(uuid) {
        $scope.openDropdownUuid = null;
        WsService.sendCommand('play-uuid',{uuid:uuid});
        $scope.viewMode = "player";
    };
   
    $scope.playPause = function(){ $scope.playerStatus.playing ? WsService.sendCommand('play-pause') : WsService.sendCommand('play-uuid', {uuid:$scope.currentTrack.uuid}); };

    $scope.playPrev = function(){ WsService.sendCommand('play-prev')};

    $scope.playNext = function(){ WsService.sendCommand('play-next')};

    $scope.playerStop = function(){ WsService.sendCommand('play-stop')};

    $scope.toggleLoop = function(){ WsService.sendCommand('toggle-loop')};
  
    $scope.toggleRandom = function(){ WsService.sendCommand('toggle-random')};

    $scope.toggleMute = function(){ WsService.sendCommand('toggle-mute')};

    $scope.seekBarClick = function($event){
        if(!$scope.totalTime) return;
        const barEl = $event.currentTarget;
        const rect = barEl.getBoundingClientRect();
        const percent = ($event.clientX - rect.left) / rect.width;
        const targetSec = percent * $scope.totalTime;
        WsService.sendCommand('play-seek',{pos:targetSec});
    };
    
    // ====================== 播放列表 ======================

    /**
     * 从播放列表移除单首歌曲
     * @param {string} uuid
     */
    $scope.removeFromPlaylist = function(uuid){
        $scope.openDropdownUuid = null;
        confirm("确定将该曲目从播放列表移除？") && WsService.sendCommand('playlist-remove',{uuid: uuid});
    };
    /**
     * 清空整个播放列表
     */
    $scope.clearPlaylist = function(){ confirm("确定清空播放列表？") && WsService.sendCommand('playlist-clear'); };
    /**
     * 添加一个曲目或所有曲目到播放列表
     * @param {string} uuid
     */
    $scope.addTrackToPlaylist = function(uuid){
        $scope.openDropdownUuid = null;
        let uuidList = uuid ? [uuid] : $scope.libTracks.map(t => t.uuid);
        WsService.sendCommand('playlist-add',{uuids: uuidList});
    };

    // ====================== 音乐库 ======================
    /**
     * 搜索音乐库曲目
     */
    $scope.doSearch = function () {
        if (!$scope.libFilter.keyword.trim()) return;
        $scope.selectedGroupName = null;
        WsService.sendCommand('lib-filter', {keyword:$scope.libFilter.keyword.trim()});
    };
    /**
     * 切换分组类型 artist / album / genre
     * @param {string} group
     */
    $scope.switchGroup = function(group){
        $scope.libFilter.keyword = '';
        $scope.activeGroup = group;
        $scope.selectedGroupName = null;
        $scope.groupList = selectGroup(group);
    };
    /**
     * 点开分组项，筛选该分组下全部曲目
     * @param {object} item
     */
    $scope.openGroupItem = function(item){
        $scope.selectedGroupName = item.name;
        let filter = {};
        switch($scope.activeGroup){
            case 'artists': filter.artist = item.name; break;
            case 'albums': filter.album = item.name; break;
            case 'genres': filter.genre = item.name; break;
        }
        $scope.libTracks = [];
        WsService.sendCommand('lib-filter', filter);
    };
    // ====================== 设置模块 ======================
    /**
     * 触发后台扫描指定文件夹
     * @param {string} folderPath
     */
    $scope.scanFolder = function(folderPath){ WsService.sendCommand('scan-folder',{folderPath: folderPath}); };
  
    $scope.setVolume = function(volume){ WsService.sendCommand('set-volume',{volume: $scope.playerStatus.volume}); };

    $scope.systemReboot = function () { confirm('确认要重启设备？') && WsService.sendCommand('reboot'); };

    $scope.systemShutdown = function () { confirm('确认要关机设备？') && WsService.sendCommand('shutdown'); };

    // ====================== 页面初始化入口 ======================
    WsService.setClientIdChangeHandler((id) => {
        if(!id){
            $scope.clientId = id;
            $scope.$apply(); 
        }else{
            $timeout(() => { $scope.clientId = id; }, 1500);
        }
    });
    WsService.connect();
}])
.directive('debounceClick', function() {
    return {
        restrict: 'A',
        scope: {
            debounceClick: '&',
            debounceDelay: '@'
        },
        link: function(scope, element, attrs) {
            let locked = false;
            const delay = parseInt(scope.debounceDelay) || 500;
            
            element.on('click', function() {
                if (locked) return;
                locked = true;
                
                // 执行点击逻辑
                scope.$apply(() => {
                    scope.debounceClick();
                });
                
                // 延迟解锁
                setTimeout(() => { locked = false; }, delay);
            });
        }
    };
});
