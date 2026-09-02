/**
 * In-memory SSE connection manager, scoped by channel (a playlist id, or a
 * per-user 唱卡 channel).
 *
 * Two things this has to get right, both learned from 唱卡 losing cards:
 *
 * 1. A connection can die without the server hearing about it. A phone
 *    freezing a background tab, a network switching from wifi to mobile, or
 *    iOS 18's own bug (the page's EventSource stays readyState OPEN while the
 *    socket is gone) all leave a socket that `write` still accepts — the bytes
 *    land in a kernel buffer that nobody drains — so `broadcast` reports
 *    success while the reader sees nothing. Cards were being written into
 *    those. The client now notices the silence and reconnects; this side has
 *    to make sure the corpse it left behind actually goes away.
 *
 * 2. `res.on('close')` is not reliable enough to be the only cleanup. Behind a
 *    proxy it can simply never fire, so refreshing a page accumulates
 *    connections that keep their heartbeat timers running forever. Listening
 *    on the socket as well catches the cases the response object misses, and
 *    replacing by key means a stale one can never outlive its replacement.
 */

const clients = new Map(); // channel → Map<connectionKey, res>

/** Heartbeat cadence. The client treats silence longer than its own timeout as
 *  a dead connection, so this is the resolution at which a dead link is found:
 *  every 10s here, with a 15s client timeout, bounds the discovery to ~15s. */
const HEARTBEAT_MS = 10000;

/**
 * Register a stream.
 *
 * `key` identifies the logical subscriber — the same browser tab reconnecting
 * uses the same key, so its previous connection is closed rather than left to
 * accumulate. Callers that have nothing to key on get a unique one, which
 * preserves the old behaviour of allowing several readers per channel.
 */
function addClient(channel, res, key) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering
  });
  res.write(':ok\n\n');

  const connectionKey = key || `anon:${Math.random().toString(36).slice(2)}`;

  if (!clients.has(channel)) clients.set(channel, new Map());
  const channelClients = clients.get(channel);

  // One live stream per key. A reconnect from the same tab retires the old one
  // here rather than waiting for a close event that may never arrive —
  // without this, every reconnect (and every page refresh) left a heartbeat
  // timer running against a socket nobody reads.
  //
  // The new entry goes in FIRST, and only then is the old one closed. Ending it
  // first runs its cleanup synchronously, which finds its own response still
  // under the key, deletes it, and — when that empties the map — drops the
  // channel from `clients` entirely. The line below would then register the new
  // stream into an orphaned map that no broadcast can reach: the reconnect
  // would appear to succeed and receive nothing at all. Claiming the key first
  // makes that cleanup a no-op, because the key no longer holds it.
  const previous = channelClients.get(connectionKey);
  channelClients.set(connectionKey, res);
  if (previous && previous !== res) {
    try { previous.end(); } catch { /* already gone */ }
  }

  const heartbeat = setInterval(() => {
    try {
      // A named event, not a bare `:heartbeat` comment. Both keep the socket
      // warm, but EventSource dispatches nothing at all for a comment line —
      // so 唱卡's watchdog, which treats silence as a dead link, never heard
      // these and cut a healthy stream roughly every 20s. Measured before the
      // change: 8763 reconnects in a day, and every card broadcast during a
      // reconnect was lost, because `broadcast` drops messages for a channel
      // with no client.
      //
      // The comment is still sent first. It is what has kept proxies and
      // browsers from reaping idle streams since this was written for playlist
      // likes, and that job is unrelated to the watchdog's.
      //
      // Named rather than an unnamed `data:` frame so it stays invisible to
      // the playlist consumers: they listen for their own events only, and an
      // unnamed frame would reach their `onmessage`.
      res.write(':heartbeat\n\n');
      res.write('event: heartbeat\ndata: {}\n\n');
    } catch {
      // The socket is gone and nothing told us. Stop the timer and drop the
      // entry, or this interval outlives the connection for good.
      cleanup();
    }
  }, HEARTBEAT_MS);

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    const set = clients.get(channel);
    if (!set) return;
    // Only remove the entry if it is still this response: a newer connection
    // may have taken the key already, and a late close from the old one must
    // not evict the live stream that replaced it.
    if (set.get(connectionKey) === res) set.delete(connectionKey);
    if (set.size === 0) clients.delete(channel);
  }

  res.on('close', cleanup);
  // The response object does not always hear about a disconnect — behind a
  // proxy `close` can fail to fire at all — but the socket underneath does.
  if (res.socket) {
    res.socket.on('close', cleanup);
    res.socket.on('error', cleanup);
  }
}

function broadcast(channel, event, data) {
  const set = clients.get(channel);
  if (!set) return;
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [key, res] of set) {
    try {
      res.write(message);
    } catch {
      set.delete(key);
    }
  }
  if (set.size === 0) clients.delete(channel);
}

/** How many live streams a channel has. Used by tests and diagnostics. */
function countClients(channel) {
  const set = clients.get(channel);
  return set ? set.size : 0;
}

module.exports = { addClient, broadcast, countClients };
