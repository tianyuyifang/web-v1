/**
 * Waits for a QQ Music app QR to be scanned, over MQTT.
 *
 * The scan result is not pollable. GetQRCodeStatus exists but belongs to the
 * scanning app, not to whoever displays the code — asking as the display side
 * answers 104610, "can NOT scan the qrCode with this APP". QQ Music's own login
 * page loads an MQTT client for exactly this reason; there is no HTTP path.
 *
 * Every parameter here is taken from that page's own code
 * (y.qq.com/m/client/qr_code_login/index.*.js) rather than guessed, including
 * the two reason codes that mean "reconnect elsewhere" and the redirect shape.
 *
 * The connection lives in this process, so a deploy ends any scan in progress.
 * That is accepted rather than solved: a scan takes tens of seconds, the QR is
 * valid for fifteen minutes, and recovering from it costs the user one tap on
 * "regenerate". Persisting the wait across restarts would mean moving this
 * state out of process, which is a large change for a rare and cheap failure.
 */
const mqtt = require('mqtt');

const WS_URL = 'wss://mu.y.qq.com/ws/handshake';

/**
 * Connection options, copied from the official page.
 *
 * resubscribe matters most: on a reconnect the client restores its topics by
 * itself, so a network blip mid-scan recovers without any bookkeeping here.
 */
const OPTIONS = {
  protocolVersion: 5,
  keepalive: 45,
  reconnectPeriod: 1000,
  connectTimeout: 30000,
  clean: true,
  resubscribe: true,
};

/**
 * Broker answers that mean "not here, go to the node I name".
 *
 * Both are handled because the official client handles both — 157 is the one
 * seen in practice, but 156 appears in the same table and a load balancer may
 * use either. Treating only 157 would fail intermittently and look like a flaky
 * network.
 */
const REDIRECT_CODES = new Set([156, 157]);

/** How many times to follow a redirect before giving up on the broker. */
const MAX_REDIRECTS = 3;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

function wsOptions() {
  return {
    headers: {
      Origin: 'https://y.qq.com',
      Referer: 'https://y.qq.com/',
      'User-Agent': UA,
    },
  };
}

/**
 * Connect and subscribe, following redirects.
 *
 * Resolves with a live client already subscribed to this login's topic. The
 * caller owns the client and must end it.
 */
function connectAndSubscribe(qrcodeID, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let url = WS_URL;
    let hops = 0;
    let settled = false;

    const finish = (fn) => (v) => { if (!settled) { settled = true; fn(v); } };
    const ok = finish(resolve);
    const bad = finish(reject);

    const attempt = () => {
      const client = mqtt.connect(url, {
        ...OPTIONS,
        clientId: qrcodeID,
        properties: {
          authenticationMethod: 'pass',
          // Identifies which login this connection is for. hashTag and userID
          // both carry the qrcodeID; the broker routes on them.
          userProperties: {
            tmeAppID: 'qqmusic',
            business: 'management',
            hashTag: qrcodeID,
            clientTag: 'management.user',
            userID: qrcodeID,
          },
        },
        wsOptions: wsOptions(),
        // Redirects are followed by hand below, so the library must not race
        // us by reconnecting to the same node that just refused.
        reconnectPeriod: 0,
      });

      let redirectTo = null;

      client.on('packetreceive', (packet) => {
        if (packet.cmd !== 'connack') return;
        const code = packet.reasonCode ?? 0;
        if (REDIRECT_CODES.has(code)) {
          redirectTo = packet.properties?.serverReference || null;
        }
      });

      client.on('connect', () => {
        const topic = `management.qrcode_login/${qrcodeID}`;
        client.subscribe(topic, {
          properties: { userProperties: { authorization: 'tmelogin', pubsub: 'unicast' } },
        }, (err) => {
          if (err) {
            client.end(true);
            bad(Object.assign(new Error('订阅扫码通知失败'), { code: 'QR_MQTT_FAILED' }));
            return;
          }
          ok(client);
        });
      });

      client.on('error', () => {
        client.end(true);

        if (redirectTo && hops < MAX_REDIRECTS) {
          hops += 1;
          /**
           * The node address is appended to the path, not dialled directly.
           * It is an internal address and unroutable from here; the public
           * host stays the same and routes on the suffix. Connecting to it
           * as a host is what made this look impossible at first.
           */
          const parts = url.replace(/\/$/, '').split('/');
          if (parts.length && parts[parts.length - 1].includes(':')
              && !parts[parts.length - 1].startsWith('wss:')) {
            parts[parts.length - 1] = redirectTo;
          } else {
            parts.push(redirectTo);
          }
          url = parts.join('/');
          redirectTo = null;
          attempt();
          return;
        }

        // No reference to follow, or out of hops: the broker is unreachable.
        bad(Object.assign(new Error('无法连接扫码通知服务'), { code: 'QR_MQTT_FAILED' }));
      });

      if (signal) {
        signal.addEventListener('abort', () => {
          client.end(true);
          bad(Object.assign(new Error('已取消'), { code: 'QR_ABORTED' }));
        }, { once: true });
      }
    };

    attempt();
  });
}

/**
 * Message types the broker publishes, from the reference client.
 *
 * `cookies` is the one that matters — it carries the credential. The rest are
 * progress, and are surfaced so the page can say "scanned, confirm on your
 * phone" instead of sitting silent.
 */
function readEvent(type, payload) {
  if (type === 'scanned') return { status: 'scanned' };
  if (type === 'canceled') return { status: 'refused' };
  if (type === 'timeout') return { status: 'expired' };
  if (type === 'loginFailed') return { status: 'refused' };
  if (type !== 'cookies') return null;

  const cookies = payload?.cookies || {};
  const uin = cookies.qqmusic_uin?.value;
  const key = cookies.qqmusic_key?.value;
  if (!uin || !key) return null;
  return { status: 'done', musicId: String(uin), token: String(key) };
}

module.exports = { connectAndSubscribe, readEvent, REDIRECT_CODES, OPTIONS };
