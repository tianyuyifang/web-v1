// In-memory SSE connection manager, scoped by playlist ID
const clients = new Map(); // playlistId → Set<res>

function addClient(playlistId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering
  });
  res.write(':ok\n\n');

  if (!clients.has(playlistId)) {
    clients.set(playlistId, new Set());
  }
  clients.get(playlistId).add(res);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 30000);

  res.on('close', () => {
    clearInterval(heartbeat);
    const set = clients.get(playlistId);
    if (set) {
      set.delete(res);
      if (set.size === 0) clients.delete(playlistId);
    }
  });
}

function broadcast(playlistId, event, data) {
  const set = clients.get(playlistId);
  if (!set) return;
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try {
      res.write(message);
    } catch {
      set.delete(res);
    }
  }
}

module.exports = { addClient, broadcast };
