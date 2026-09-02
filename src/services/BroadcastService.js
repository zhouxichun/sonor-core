class BroadcastService {
  constructor() {
    this.clients = new Set();
  }
  addClient(conn) { this.clients.add(conn); }
  removeClient(conn) { this.clients.delete(conn); }
  broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const c of this.clients) {
      try { c.send(msg); } catch {}
    }
  }
}
module.exports = BroadcastService;