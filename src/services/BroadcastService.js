class BroadcastService {
    /** @type {Set<import('@fastify/websocket').WebSocket>} */
    static #clients = new Set();

    /**
     * @param {import('@fastify/websocket').WebSocket} connection
     */
    static addClient(connection) {
        this.#clients.add(connection);
    }

    /**
     * @param {import('@fastify/websocket').WebSocket} connection
     */
    static removeClient(connection) {
        this.#clients.delete(connection);
    }

    /**
     * 广播JSON消息给全部客户端
     * @param {object} msg
     */
    static broadcast(msg) {
        const payload = JSON.stringify(msg);
        for (const ws of this.#clients) {
            if (ws.readyState === ws.OPEN) {
                ws.send(payload);
            }
        }
    }
}

module.exports = BroadcastService;
