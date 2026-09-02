/**
 * Two 唱卡 pages, one singer.
 *
 * The live stream de-duplicates by key so that a page reconnecting retires its
 * own dead connection instead of leaving a heartbeat running against a socket
 * nobody reads. The key was the session id — but a singer with the page open on
 * a laptop and a phone, or in two tabs, shares one session, so both pages
 * presented the same key and each new connection evicted the other's. Every
 * eviction makes that page's EventSource reconnect, which evicts the first
 * right back: a loop, measured in production at one reconnect every ~6s, with
 * every card broadcast during a gap lost.
 *
 * This is the same failure that took out 歌P's 自动打标 in July, when keying was
 * first applied to the playlist stream. There the fix was to stop keying. Here
 * keying has to stay — a 唱卡 page really does replace itself on reconnect —
 * so the key gains a per-page component instead.
 *
 * Run: node tests/sse-multitab-test.js
 */
const assert = require('assert');
const http = require('http');
const { EventSource } = require('eventsource');
const { addClient, broadcast, countClients } = require('../src/services/sseManager');

const CHANNEL = 'live:user1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve(keyFor) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      addClient(CHANNEL, res, keyFor(url));
    });
    srv.listen(0, () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

function openTab(url, clientId, sink) {
  const es = new EventSource(`${url}?clientId=${clientId}`);
  es.addEventListener('live-card', (e) => sink.push(JSON.parse(e.data).n));
  return es;
}

(async () => {
  // Two pages, each with its own client id, on one session.
  const { srv, url } = await serve((u) => `live:session1:${u.searchParams.get('clientId')}`);
  const a = [], b = [];
  const tabA = openTab(url, 'tab-a', a);
  await sleep(600);
  const tabB = openTab(url, 'tab-b', b);
  await sleep(1500);

  assert.strictEqual(
    countClients(CHANNEL), 2,
    'two pages of one session must hold two streams — sharing a key makes them evict each other',
  );

  broadcast(CHANNEL, 'live-card', { n: 1 });
  await sleep(600);
  assert.deepStrictEqual(a, [1], 'first page receives the card');
  assert.deepStrictEqual(b, [1], 'second page receives the same card');
  console.log('  ✓ two pages of one session coexist and both receive cards');

  // The point of keying at all: one page reconnecting must still retire its own
  // previous stream rather than accumulate connections.
  const again = openTab(url, 'tab-a', a);
  await sleep(1200);
  assert.strictEqual(
    countClients(CHANNEL), 2,
    'a page reconnecting replaces its own stream, leaving the other page alone',
  );
  console.log('  ✓ a reconnecting page still retires only its own stream');

  tabA.close(); tabB.close(); again.close(); srv.close();
  await sleep(400);

  // And the regression this replaces: a shared key evicts, which is what the
  // production loop was.
  const shared = await serve(() => 'live:session1');
  const c = [], d = [];
  const t1 = openTab(shared.url, 'x', c);
  await sleep(600);
  const t2 = openTab(shared.url, 'y', d);
  await sleep(1500);
  const held = countClients(CHANNEL);
  t1.close(); t2.close(); shared.srv.close();
  assert.strictEqual(held, 1, 'sanity: a shared key really does collapse two pages into one');
  console.log('  ✓ confirmed the shared-key behaviour this guards against');

  console.log('\nAll multi-tab tests passed.');
  process.exit(0);
})().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
