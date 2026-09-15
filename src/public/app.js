const app = angular.module('sonorApp', []);
app.controller('MainCtrl',['$scope','$timeout',function($scope,$timeout){
    const apiBase = '/api';
    // ====================== 全局状态变量 ======================
    // 视图与筛选状态
    $scope.viewMode = 'player';
    
    $scope.libGroups = {};
    $scope.libFilter = {keyword:''};
    $scope.libTracks = [];
    $scope.activeGroup = 'artists';
    $scope.groupList = [];
    // 播放器状态（websocket同步更新）
    $scope.playerStatus = {};
    $scope.currentTime = 0;
    $scope.totalTime = 0;
    $scope.progressPercent = 0;
    $scope.currentTrack = null;
    $scope.parsedLyric = [];
    $scope.currentCover = null;
    $scope.folderList = [];
    //歌词滚动开关
    $scope.lyricAutoScroll = true;

    // UI通用状态
    $scope.toastMessage = '';
    $scope.openDropdownUuid = null;
    // 弹窗状态
    $scope.showCoverPopup = false;
    $scope.toastList = [];

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
        $scope.showCoverPopup = !!$scope.currentCover;
    };
    /**
     * 关闭封面弹窗
     */
    $scope.closeCoverPopup = function() { $scope.showCoverPopup = false; };
    // ====================== LRC歌词解析工具 ======================
  

    // ====================== 【WS订阅，精简】======================
    WsService.on('group-stats', data => {
         $scope.$evalAsync(()=>{
            $scope.libGroups = data;
            $scope.groupList = $scope.libGroups[$scope.activeGroup];
        });
    })
    .on('filtered-tracks', data => {
         $scope.$evalAsync(()=>{
            $scope.libTracks = data;
        });
    })
    .on('playlist', data => {
        $scope.$evalAsync(()=>{
            $scope.playlistTracks = data;
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
            $scope.currentCover = data.base64;
            document.documentElement.style.setProperty('--base-h', data.theme.h);
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
        $scope.folderList = data;
    })
    .on('notification', payload => {
       $scope.$evalAsync(()=>{
            $scope.showToast(payload);
        }); 
    });

    // ====================== 播放器控制 HTTP接口 ======================
    /**
     * 通过uuid播放曲目
     * @param {string} uuid
     */
    $scope.playTrack = function(uuid) {
        $scope.openDropdownUuid = null;
        WsService.sendCommand('play-uuid',{uuid:uuid});
    };
    /**
     * 播放 / 暂停切换
     */
    $scope.playPause = function(){ WsService.sendCommand('play-pause') };
    /**
     * 上一曲
     */
    $scope.playPrev = function(){ WsService.sendCommand('play-prev')};
    /**
     * 下一曲
     */
    $scope.playNext = function(){ WsService.sendCommand('play-next')};
    /**
     * 停止播放
     */
    $scope.playerStop = function(){ WsService.sendCommand('play-stop')};
    /**
     * 切换循环模式
     */
    $scope.toggleLoop = function(){ WsService.sendCommand('toggle-loop')};
    /**
     * 切换随机模式
     */
    $scope.toggleRandom = function(){ WsService.sendCommand('toggle-random')};
    /**
     * 切换静音
     */
    $scope.toggleMute = function(){ WsService.sendCommand('toggle-mute')};
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
        WsService.sendCommand('play-seek',{pos:targetSec});
    };
    
    // ====================== 播放列表管理 ======================
    /**
     * 从播放列表移除单首歌曲
     * @param {string} uuid
     */
    $scope.removeFromPlaylist = function(uuid){
        $scope.openDropdownUuid = null;
        if(!confirm("确定将该曲目从播放列表移除？")) return;
        WsService.sendCommand('playlist-remove',{uuid: uuid});
    };
    /**
     * 清空整个播放列表
     */
    $scope.clearPlaylist = function(){
        if(!confirm("确定清空播放列表？")) return;
        WsService.sendCommand('playlist-clear');
    };
    /**
     * 添加单首曲目到播放列表
     * @param {string} uuid
     */
    $scope.addTrackToPlaylist = function(uuid){
        $scope.openDropdownUuid = null;
        let uuidList = uuid ? [uuid] : $scope.libTracks.map(t => t.uuid);
        WsService.sendCommand('playlist-add',{uuids: uuidList});
    };
    // ====================== 音乐库逻辑（艺术家/专辑/流派分组） ======================
    /**
     * 搜索音乐库曲目
     */
    $scope.doSearch = function () {
        if (!$scope.libFilter.keyword.trim()) return;
        $scope.selectedGroupName = null;
        WsService.sendCommand('lib-filter', {keyword:$scope.libFilter.keyword.trim()})
    };
    /**
     * 切换分组类型 artist / album / genre
     * @param {string} group
     */
    $scope.switchGroup = function(group){
        $scope.libFilter.keyword = '';
        $scope.activeGroup = group;
        $scope.selectedGroupName = null;
        $scope.groupList = $scope.libGroups[group];
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
        WsService.sendCommand('lib-filter', filter)
    };
    // ====================== 设置模块：音源目录扫描 ======================
    
    /**
     * 触发后台扫描指定文件夹
     * @param {string} folderPath
     */
    $scope.scanFolder = function(folderPath){ WsService.sendCommand('scan-folder',{folderPath: folderPath}); };
    /**
     * 切换静音
     */
    $scope.setVolume = function(volume){ WsService.sendCommand('set-volume',{volume: $scope.playerStatus.volume}); };
    // 重启
    $scope.systemReboot = function () {
        if (!confirm('确认要重启设备？')) return;
        WsService.sendCommand('reboot');

    };
    // 关机
    $scope.systemShutdown = function () {
        if (!confirm('确认要关机设备？')) return;
        WsService.sendCommand('shutdown');
    };

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

    // ====================== 页面初始化入口 ======================
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
