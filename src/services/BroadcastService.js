const logger = require('../utils/logger')(__dirname);
class BroadcastService {
    /** @type {Set<import('@fastify/websocket').WebSocket>} */
    static #clients = new Set();
    /**
     * @param {import('@fastify/websocket').WebSocket} connection
     */
    static addClient(connection) {
        this.#clients.add(connection);
        logger.info(`ws client add, total connected ${this.#clients.size}`);
    }
    /**
     * @param {import('@fastify/websocket').WebSocket} connection
     */
    static removeClient(connection) {
        this.#clients.delete(connection);
        logger.info(`ws client remove, total connected ${this.#clients.size}`);
    }
    /**
     * 广播JSON消息给全部客户端
     * @param {object} msg
     */
    static broadcast(msg) {
        const payload = JSON.stringify(msg);
        const clientCount = this.#clients.size;
        logger.debug(`broadcast send ${msg.type}, target clients: ${clientCount}`);
        let sendOk = 0;
        for (const ws of this.#clients) {
            if (ws.readyState === ws.OPEN) {
                ws.send(payload);
                sendOk++;
            }
        }
        logger.debug(`broadcast done, delivered: ${sendOk}`);
    }
}
module.exports = BroadcastService;