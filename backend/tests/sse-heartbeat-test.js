/**
 * The heartbeat has to be something the client can actually hear.
 *
 * 唱卡's page runs a watchdog: silence longer than its timeout means the link
 * is dead, so it tears the stream down and rebuilds it. The heartbeat exists
 * to stop that from firing on a healthy connection.
 *
 * It did not. A heartbeat written as an SSE comment (`:heartbeat`) keeps the
 * TCP connection warm — which is all it was ever asked to do when it was added
 * for playlist likes — but EventSource dispatches no event for a comment line.
 * So the watchdog heard nothing, decided the connection had died, and cut a
 * perfectly healthy stream every ~20s. Measured in production: 8763 reconnects
 * in one day, median lifetime 20s, 58% landing inside the watchdog's window.
 * Cards broadcast during the gap were lost outright, because `broadcast` drops
 * a message when the channel has no client.
 *
 * These tests pin the two halves of the contract:
 *   1. the heartbeat reaches a listener (so the watchdog can be reset), and
 *   2. it stays invisible to the playlist consumers, which listen only for
 *      their own named events and have no watchdog at all.
 *
 * Run: node tests/sse-heartbeat-test.js
 */
const assert = require('assert');
const http = require('http');
const { EventSource } = require('eventsource');
const { addClient, broadcast, countClients } = require('../src/services/sseManager');

const CHANNEL = 'test:heartbeat';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withServer(fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => addClient(CHANNEL, res, 'test:key'));
    srv.listen(0, async () => {
      const url = `http://127.0.0.1:${srv.address().port}/`;
      try {
        await fn(url);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        srv.close();
      }
    });
  });
}

(async () => {
  // 1. A heartbeat must be audible to a listener. This is the regression: with
  //    a comment heartbeat nothing fires here, the watchdog times out, and the
  //    page cuts a healthy connection.
  await withServer(async (url) => {
    const es = new EventSource(url);
    let beats = 0;
    es.addEventListener('heartbeat', () => { beats += 1; });
    // Long enough to cover the manager's own cadence with room to spare.
    await sleep(12500);
    es.close();
    assert.ok(
      beats > 0,
      'heartbeat must dispatch an event the watchdog can hear — a comment line does not',
    );
  });
  console.log('  ✓ heartbeat reaches a listener');

  // 2. The playlist page listens only for its own named events and runs no
  //    watchdog. The heartbeat must stay entirely out of its way — this is the
  //    guard against repeating the regression where a 唱卡 change broke 歌P.
  await withServer(async (url) => {
    const es = new EventSource(url);
    const seen = { 'like-update': 0, 'capture-event': 0, 'capture-resolved': 0, message: 0 };
    Object.keys(seen).forEach((name) =>
      es.addEventListener(name, () => { seen[name] += 1; }));
    es.onmessage = () => { seen.message += 1; };

    await sleep(300);
    broadcast(CHANNEL, 'like-update', { clipId: 'c1', liked: true });
    await sleep(12000);
    es.close();

    assert.strictEqual(seen['like-update'], 1, 'a real event still arrives exactly once');
    assert.strictEqual(seen.message, 0, 'heartbeat must not surface as an unnamed message');
    assert.strictEqual(seen['capture-event'], 0, 'heartbeat must not look like a capture event');
    assert.strictEqual(seen['capture-resolved'], 0, 'heartbeat must not look like a resolution');
  });
  console.log('  ✓ heartbeat is invisible to the playlist consumers');

  // 3. Nothing about the change may leak connections: a closed stream must
  //    still be reaped, or its heartbeat timer outlives it forever.
  await withServer(async (url) => {
    const es = new EventSource(url);
    await sleep(400);
    assert.strictEqual(countClients(CHANNEL), 1, 'stream registers');
    es.close();
    await sleep(600);
    assert.strictEqual(countClients(CHANNEL), 0, 'stream is reaped on close');
  });
  console.log('  ✓ connections are still reaped on close');

  console.log('\nAll heartbeat tests passed.');
  process.exit(0);
})().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
