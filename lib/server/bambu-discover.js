'use strict';
/**
 * BAMBU-DISCOVER.JS — обнаружение serial Bambu Lab принтеров.
 *
 * Два метода:
 *
 *  1. MQTT-based (основной) — подключается к принтеру по MQTT с
 *     access_code, подписывается на `device/+/report` с wildcard,
 *     ждёт сообщение и извлекает serial из топика. Работает
 *     всегда когда принтер доступен и access_code правильный.
 *     НЕ требует привилегированного UDP порта.
 *
 *  2. UDP broadcast (резервный) — слушает UDP 2021. На Windows
 *     часто заблокирован Hyper-V reserved range, поэтому как
 *     запасной вариант. Не требует access_code.
 *
 * Функции:
 *  • discoverByMqtt(ip, access_code, timeoutMs) — рекомендуемый способ.
 *  • discoverByIp(ip, timeoutMs) — UDP fallback.
 *  • listenAll(timeoutMs) — UDP scan всей сети.
 */

const dgram = require('dgram');
const mqtt  = require('mqtt');

const BAMBU_PORT = 2021;
const MULTICAST_ADDR = '239.255.255.250';

// ─── Разбор пакета ─────────────────────────────────────────────────────────
// Payload обычно выглядит так (HTTP-like headers):
//   NOTIFY * HTTP/1.1
//   HOST: 239.255.255.250:2021
//   Location: http://...
//   NT: urn:bambulab-com:device:3dprinter:1
//   USN: <serial>
//   DevName.bambu.com: Bambu X1C
//   DevSignal.bambu.com: -45
//   DevConnect.bambu.com: lan
//   DevBind.bambu.com: free
// Но у разных прошивок поля немного отличаются — парсим гибко.
function parseNotify(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([\w\-.]+)\s*:\s*(.+?)\s*$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  // serial: приоритет USN, потом DevSer, потом любой длинный идентификатор
  let serial = headers['usn'] || headers['dev-id'] || headers['devser.bambu.com'] || null;
  if (!serial) {
    // Пытаемся найти в теле серийник Bambu (обычно 15 символов, начинается с 0 или 1, А-Z0-9)
    const m = text.match(/\b(0[0-9A-Z]{14,})\b/);
    if (m) serial = m[1];
  }
  // Чистим uuid: часть (если в USN был urn:uuid:xxx::urn:bambulab...)
  if (serial) {
    const m = serial.match(/([0-9A-Z]{12,})/i);
    if (m) serial = m[1];
  }

  const name = headers['devname.bambu.com'] ||
               headers['devname'] ||
               headers['friendlyname'] ||
               null;

  const model = headers['devmodel.bambu.com'] || headers['devmodel'] || null;

  return { serial, name, model, headers };
}

// ─── Слушатель (singleton, чтобы не захватывать порт дважды) ───────────────
// На Windows порт 2021 часто входит в excluded range (Hyper-V / Docker),
// тогда bind даёт EACCES. В этом случае возвращаем ошибку с подсказкой —
// UI позволит пользователю ввести serial вручную.
let activeListener = null;   // { sock, listeners: Set<fn> } | { error: '...' }

function ensureListener() {
  if (activeListener) return activeListener;

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const listeners = new Set();

  sock.on('error', err => {
    // Рассылаем ошибку всем слушателям и закрываем
    const msg = translateError(err);
    for (const fn of listeners) {
      try { fn({ error: msg }); } catch {}
    }
    listeners.clear();
    try { sock.close(); } catch {}
    activeListener = null;
  });

  sock.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8');
    // Интересуют только NOTIFY пакеты от Bambu
    if (!/bambu/i.test(text) && !/3dprinter/i.test(text)) return;
    const info = parseNotify(text);
    if (!info.serial) return;
    const event = { ip: rinfo.address, ...info };
    for (const fn of listeners) {
      try { fn(event); } catch {}
    }
  });

  let bound = false;
  try {
    sock.bind(BAMBU_PORT, '0.0.0.0', () => {
      bound = true;
      try {
        sock.setBroadcast(true);
        sock.addMembership(MULTICAST_ADDR);
      } catch {}
    });
  } catch (e) {
    // Синхронная ошибка при bind — исключительная ситуация
    const msg = translateError(e);
    activeListener = { error: msg };
    return activeListener;
  }

  activeListener = { sock, listeners };
  return activeListener;
}

function translateError(err) {
  const code = err.code || '';
  if (code === 'EACCES' || code === 'EPERM') {
    return `UDP порт ${BAMBU_PORT} заблокирован системой. На Windows это обычно Hyper-V/Docker резервирует диапазон портов. Введите Serial Number вручную (можно посмотреть на экране принтера: Settings → Device Info).`;
  }
  if (code === 'EADDRINUSE') {
    return `UDP порт ${BAMBU_PORT} уже занят другим приложением. Введите Serial Number вручную.`;
  }
  return err.message || String(err);
}

function addListener(fn) {
  const l = ensureListener();
  if (l.error) {
    // Сразу сообщаем ошибку и не добавляем слушатель
    setImmediate(() => fn({ error: l.error }));
    return () => {};
  }
  l.listeners.add(fn);
  return () => l.listeners.delete(fn);
}

// ─── Публичные функции ────────────────────────────────────────────────────
function listenAll(timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let found = new Map();   // ip → info
    try {
      const unsub = addListener(ev => {
        if (ev.error) { unsub(); reject(new Error(ev.error)); return; }
        if (!found.has(ev.ip)) found.set(ev.ip, ev);
      });
      setTimeout(() => {
        unsub();
        resolve([...found.values()]);
      }, timeoutMs);
    } catch (e) {
      reject(e);
    }
  });
}

function discoverByIp(ip, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let unsub = null;
    const timer = setTimeout(() => {
      if (unsub) unsub();
      resolve({
        ok: false,
        message: `Не получили broadcast от ${ip} за ${timeoutMs/1000}с. Проверьте что принтер включён, в LAN Only Mode, и компьютер в той же сети.`,
      });
    }, timeoutMs);
    try {
      unsub = addListener(ev => {
        if (ev.error) {
          clearTimeout(timer);
          if (unsub) unsub();
          resolve({ ok: false, message: ev.error });
          return;
        }
        if (ev.ip === ip) {
          clearTimeout(timer);
          if (unsub) unsub();
          resolve({ ok: true, serial: ev.serial, name: ev.name, model: ev.model });
        }
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, message: e.message });
    }
  });
}

function shutdown() {
  if (!activeListener) return;
  try { activeListener.sock && activeListener.sock.close(); } catch {}
  activeListener = null;
}

// ─── MQTT-BASED discovery (основной метод) ────────────────────────────────
// Подключаемся к принтеру с access_code, подписываемся на wildcard
// device/+/report. Принтер публикует статус каждые 1–3 секунды, в топике
// содержится его серийный номер.
//
// Также вытягиваем модель из payload (например "X1C", "P1S", "A1").
function discoverByMqtt(ip, accessCode, timeoutMs = 10000) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { client.end(true); } catch {}
      resolve(result);
    };

    // Пробуем TLS (8883) первым, при ошибке — open (1883)
    let useTls = true;
    let client;

    function tryConnect(tls) {
      useTls = tls;
      const url = tls ? `mqtts://${ip}:8883` : `mqtt://${ip}:1883`;
      client = mqtt.connect(url, {
        username: 'bblp',
        password: accessCode,
        clientId: `farm_discover_${Date.now()}`,
        connectTimeout: Math.min(timeoutMs, 4000),
        reconnectPeriod: 0,
        rejectUnauthorized: false,
      });

      client.on('error', e => {
        if (tls && /ECONNREFUSED/.test(e.message)) {
          try { client.end(true); } catch {}
          tryConnect(false);  // fallback to 1883
          return;
        }
        finish({ ok: false, message: `MQTT ${tls ? 'TLS' : 'open'}: ${e.message}` });
      });
      client.on('connect', onConnect);
      client.on('message', onMessage);
      setTimeout(() => {
        if (tls && !settled) {
          try { client.end(true); } catch {}
          tryConnect(false);
        } else {
          finish({ ok: false, message: `MQTT timeout (${tls ? '8883+1883' : '1883'})` });
        }
      }, tls ? Math.floor(timeoutMs / 2) : timeoutMs);
    }

    function onConnect() {
      // Подписываемся на wildcard — это главный трюк: не нужно знать serial
      // заранее, чтобы его получить.
      client.subscribe('device/+/report', { qos: 0 }, err => {
        if (err) finish({ ok: false, message: 'subscribe error: ' + err.message });
      });
      // Triggering request — просим принтер сразу опубликовать статус.
      // Отправляем pushall на broadcast-топик, принтер ответит.
      client.publish('device/+/request', JSON.stringify({
        pushing: { sequence_id: '0', command: 'pushall' },
      }), { qos: 0 });
    }

    function onMessage(topic, payload) {
      const m = topic.match(/^device\/([^/]+)\/report$/);
      if (!m) return;
      const serial = m[1];

      let name = null, model = null;
      try {
        const data = JSON.parse(payload.toString());
        const info = data.info || data.print || {};
        model = info.dev_model || info.model || info.hw_ver || null;
        name = info.dev_name || null;
        if (!model && serial) {
          const prefix = serial.slice(0, 3);
          const MODEL_CODES = {
            '00M': 'X1',      '00W': 'X1 Carbon',
            '030': 'P1P',     '039': 'P1S',
            '094': 'A1',      '097': 'A1 Mini',
            '00K': 'X1 Carbon','00C': 'X1',
          };
          model = MODEL_CODES[prefix] || `Bambu (${prefix})`;
        }
      } catch {}

      finish({
        ok: true,
        method: 'mqtt',
        port: useTls ? 8883 : 1883,
        serial,
        name: name || `Bambu ${model || ''} (${ip})`.trim(),
        model,
      });
    }

    tryConnect(true);  // start with TLS
  });
}

module.exports = { listenAll, discoverByIp, discoverByMqtt, shutdown, parseNotify };
