const WsService = (function() {
    let ws = null;
    let messageHandlers = {};
    let reconnectTimer = null;
    let connected = false;
    let clientId = null;
    let onClientIdChange = null; // 新增：clientId变化回调

    function connect() {
        const loc = window.location;
        const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProto}//${loc.host}/api/ws`;
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
            console.log('ws connected');
            connected = true;
        };
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            console.log(msg);
            if(msg.type === 'hello-sonor'){
                clientId = msg.data.clientId;
                if(onClientIdChange) onClientIdChange(clientId);
            }
            const type = msg.type;
            if (messageHandlers[type]) {
                messageHandlers[type](msg.data);
            }
        };
        ws.onclose = () => {
            connected = false;
            clientId = null;
            if(onClientIdChange) onClientIdChange(clientId);
            console.warn('ws closed, reconnect after 3s');
            if(reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connect, 3000);
        };
        ws.onerror = (err) => {
            connected = false;
            clientId = null;
            if(onClientIdChange) onClientIdChange(clientId);
            console.error('ws error', err);
        };
    }

    function on(type, callback) {
        messageHandlers[type] = callback;
        return this;
    }

    function off(type) { delete messageHandlers[type];}
    
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
    
    function sendCommand(action, payload){ send({ action, payload }); }
    
    function getClientId() { return clientId; }
    
    function setClientIdChangeHandler(cb) { onClientIdChange = cb; }

    return {
        connect,
        on,
        off,
        send,
        sendCommand,
        isConnected,
        getClientId,
        setClientIdChangeHandler
    };
})();
