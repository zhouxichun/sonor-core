const logger = require('../utils/logger')('BroadcastService');
class BroadcastService {
    static #clientsSet = new Set();
    static #clientMap = new Map(); // clientId -> ws

    /**
     * @param {string} clientId 唯一标识
     * @param {import('@fastify/websocket').WebSocket} connection
     */
    static addClient(clientId, connection) {
        this.#clientsSet.add(connection);
        this.#clientMap.set(clientId, connection);
        logger.info(`websocket client add. id =[${clientId}], total client: ${this.#clientsSet.size}`);
    }

    /**
     * @param {string} clientId
     * @param {import('@fastify/websocket').WebSocket} connection
     */
    static removeClient(clientId, connection) {
        this.#clientsSet.delete(connection);
        this.#clientMap.delete(clientId);
        logger.info(`ws client remove ${clientId}, total connected ${this.#clientsSet.size}`);
    }

    /**
     * 单点发送消息：发给指定clientId
     */
    static sendToClient(clientId, payload) {
        const ws = this.#clientMap.get(clientId);
        if (!ws || ws.readyState !== ws.OPEN) return false;
        try {
            const msg = JSON.stringify(payload);
            ws.send(msg);
            return true;
        } catch (err) {
            logger.error(`sendToClient failed clientId=${clientId}`, err);
            return false;
        }
    }
    /**
     * 单点发送notify通知
     * @param {string} clientId
     * @param {string} message
     * @param {string} level
     * @returns {boolean}
     */
    static notify(clientId, message, level='info'){
        return BroadcastService.sendToClient(
            clientId,
            {
                type: 'notification',
                data:{
                    message,
                    level,
                    timestamp: Date.now()
                }
            })
    }

    /**
     * 广播JSON消息给全部客户端
     * @param {object} msg
     */
    static broadcast(msg) {
        const payload = JSON.stringify(msg);
        const clientCount = this.#clientsSet.size;
        logger.debug(`broadcast send ${msg.type}, target clients: ${clientCount}`);
        let sendOk = 0;
        for (const ws of this.#clientsSet) {
            if (ws.readyState === ws.OPEN) {
                ws.send(payload);
                sendOk++;
            }
        }
        logger.debug(`broadcast done, delivered: ${sendOk}`);
    }
    
    static broadcastNotify(message, level='info'){
        BroadcastService.broadcast({
            type:'notification',
            data:{
                level,
                message,
                timestamp: Date.now()
            }})
    }
}
module.exports = BroadcastService;
