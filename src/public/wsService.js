/**
 * WebSocket 服务，独立封装，AngularJS控制器调用
 */
const WsService = (function() {
    let ws = null;
    let messageHandlers = {};
    let reconnectTimer = null;
    let connected = false;
    let maskDelayTimer = null;
    const maskEl = document.getElementById('wsMask');
    const MASK_DELAY = 300; // 等待300ms，连接没成功才展示遮罩

    function setMask(show) {
        if(!maskEl) return;
        if (show) {
            // 开启遮罩，延迟生效
            maskDelayTimer = setTimeout(() => {
                maskEl.style.display = 'flex';
            }, MASK_DELAY);
        } else {
            // 关闭遮罩，清除等待定时器，立刻隐藏
            if(maskDelayTimer) {
                clearTimeout(maskDelayTimer);
                maskDelayTimer = null;
            }
            maskEl.style.display = 'none';
        }
    }

    /**
     * 建立连接
     */
    function connect() {
        const loc = window.location;
        const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProto}//${loc.host}/api/ws`;
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
            console.log('ws connected');
            connected = true;
            setMask(false);
        };
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            const type = msg.type;
            if (messageHandlers[type]) {
                messageHandlers[type](msg.data);
            }
        };
        ws.onclose = () => {
            connected = false;
            setMask(true);
            console.warn('ws closed, reconnect after 3s');
            if(reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connect, 3000);
        };
        ws.onerror = (err) => {
            connected = false;
            setMask(true);
            console.error('ws error', err);
        };
    }
    /**
     * 注册消息回调
     * @param {string} type 消息类型 current_track / player_status / player_time
     * @param {Function} callback
     */
    function on(type, callback) {
        messageHandlers[type] = callback;
        return this;
    }
    /**
     * 移除消息回调
     * @param {string} type
     */
    function off(type) {
        delete messageHandlers[type];
    }
    /**
     * 发送ws指令
     * @param {object} payload
     */
    function send(payload) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.warn('ws not ready, send fail');
            return;
        }
        ws.send(JSON.stringify(payload));
    }

    function isConnected(){
        return connected;
    }

    function sendCommand(action, payload){
        send({
            action,
            payload
        })
    }
    return {
        connect,
        on,
        off,
        send,
        sendCommand,
        isConnected
    };
})();
