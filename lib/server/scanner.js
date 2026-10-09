'use strict';

/**
 * SCANNER.JS — Сканер сети для автоматического обнаружения 3D-принтеров
 *
 * Как работает:
 *  1. Определяет подсеть компьютера (например 192.168.1.x)
 *  2. Параллельно проверяет все 254 адреса на известных портах принтеров
 *  3. При успешном соединении делает fingerprint — определяет тип принтера
 *  4. Возвращает список найденных принтеров с типом и рекомендуемой конфигурацией
 *
 * Порты по протоколам:
 *   1883  — Bambu Lab MQTT
 *   7125  — Klipper / Moonraker
 *   80    — OctoPrint, Phrozen HTTP
 *   8899  — FlashForge TCP
 *   3000  — Elegoo UDP (проверяется отдельно)
 *   4998  — Creality Box / Nebula
 */

const net    = require('net');
const http   = require('http');
const dgram  = require('dgram');
const os     = require('os');

// Состояние текущего сканирования
let scanState = {
  running:   false,
  progress:  0,       // 0-100
  total:     0,
  checked:   0,
  found:     [],      // [{ip, type, name, port, confidence, config}]
  startedAt: null,
  finishedAt:null,
  error:     null,
};
let abortScan = false;  // флаг для остановки текущего сканирования
let poolIPs = new Set(); // IP принтеров, уже добавленных в пул — для фильтрации результатов

// ─── Получение подсетей компьютера ─────────────────────────────────────────
// Помечает виртуальные интерфейсы (Docker/WSL/Hyper-V/VMware/VirtualBox) флагом
// `virtual: true`. UI по умолчанию отключает их из сканирования — на таких
// подсетях никогда не бывает реальных принтеров, зато часто висит локальный
// MQTT-брокер (Home Assistant, Mosquitto в Docker), который ложно
// определяется как Bambu Lab.
const VIRTUAL_IFACE_RE = /(vEthernet|WSL|Hyper-?V|Docker|docker0|br-[0-9a-f]{12}|veth|VirtualBox|VMware|vmnet|VPN|TAP|TUN|Loopback|Pseudo|Tailscale|ZeroTier|Radmin|Nebula|WireGuard|Hamachi)/i;

function isLikelyVirtualIface(name, myIp) {
  if (VIRTUAL_IFACE_RE.test(name)) return true;
  // Link-local 169.254.x.x — автоконфиг без DHCP, принтеры туда не попадают
  if (/^169\.254\./.test(myIp)) return true;
  // Docker Desktop default bridge 172.17-31.x.x (RFC1918, но почти всегда контейнеры)
  // Строго говоря, пользователь может легально использовать 172.16/12 в LAN,
  // поэтому НЕ помечаем как виртуальный по IP — только по имени интерфейса.
  return false;
}

function getLocalSubnets() {
  const interfaces = os.networkInterfaces();
  const subnets = [];
  for (const [ifaceName, iface] of Object.entries(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const parts = addr.address.split('.');
        if (parts.length === 4) {
          // Skip Docker/WSL/Hyper-V/etc. — never show or scan virtual NICs
          if (isLikelyVirtualIface(ifaceName, addr.address)) continue;
          subnets.push({
            prefix:  parts.slice(0, 3).join('.'),
            myIp:    addr.address,
            iface:   ifaceName,
            virtual: false,
          });
        }
      }
    }
  }
  const map = new Map();
  for (const s of subnets) {
    if (!map.has(s.prefix)) map.set(s.prefix, s);
  }
  return [...map.values()];
}

/** IP этого ПК (агент / локальный сервер) — в скан не входят. */
function getHostIps(subnets = getLocalSubnets()) {
  return [...new Set(subnets.map((s) => s.myIp).filter(Boolean))];
}

/**
 * Подсети домашней LAN с точки зрения ПК, где крутится сканер (Farm Edge).
 * У разных аккаунтов разные Edge → разные подсети; облако само LAN не видит.
 */
function getNetworkInfo() {
  const subnets = getLocalSubnets();
  const skippedIps = getHostIps(subnets);
  return {
    subnets,
    skippedIps,
    via: 'local',
    hint: skippedIps.length
      ? `Сканируется домашняя LAN этого ПК. IP агента/сервера (${skippedIps.join(', ')}) не сканируется.`
      : 'Сканируется домашняя LAN компьютера с Farm Edge. Чтобы увидеть свою сеть — установите и привяжите агент на Farm PC.',
  };
}

// ─── TCP probe — проверяет открыт ли порт за timeout мс ───────────────────
function tcpProbe(ip, port, timeoutMs = 700) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error',   () => finish(false));
    sock.connect(port, ip);
  });
}

// ─── HTTP GET с таймаутом ───────────────────────────────────────────────────
function httpGet(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    // Hard timeout — гарантирует что промис завершится даже если сервер держит соединение
    const hardTimer = setTimeout(() => { try { req.destroy(); } catch {} reject(new Error('hard timeout')); }, timeoutMs + 1000);
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      let size = 0;
      res.on('data', d => { size += d.length; if (size > 64 * 1024) { req.destroy(); return; } body += d; });
      res.on('end', () => { clearTimeout(hardTimer); resolve({ status: res.statusCode, body }); });
      res.on('error', e => { clearTimeout(hardTimer); reject(e); });
    });
    req.on('error',   e => { clearTimeout(hardTimer); reject(e); });
    req.on('timeout', () => { clearTimeout(hardTimer); req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Fingerprint по IP + открытому порту ───────────────────────────────────
async function fingerprint(ip, openPorts) {
  console.log(`[Scanner] fingerprint ${ip} ports: ${openPorts.join(',')}`);
  const results = [];

  // ── Bambu Lab ────────────────────────────────────────────────────────────
  // Bambu принтеры определяются по комбинации портов:
  //   1883 (MQTT open) или 8883 (MQTT TLS) — управление
  //   990  (FTPS implicit) — загрузка файлов
  //   322  (RTSPS) — камера
  //   3000 (HTTP) — веб-интерфейс
  //   2222 (SSH) — иногда (X1 серия)
  // Многие Bambu используют ТОЛЬКО 8883 (TLS), без 1883!
  {
    const hasMqtt    = openPorts.includes(1883);
    const hasMqttTls = openPorts.includes(8883);
    const hasFtps    = openPorts.includes(990);
    const hasRtsps   = openPorts.includes(322);
    const hasHttp3k  = openPorts.includes(3000);
    const hasSsh     = openPorts.includes(2222);

    // Сигнатуры: комбинация Bambu-специфичных портов
    const bambuSignals = [hasMqtt || hasMqttTls, hasFtps, hasRtsps, hasHttp3k, hasSsh].filter(Boolean).length;
    // Минимум MQTT(любой) + ещё один Bambu-порт, или FTPS+RTSPS (без MQTT вообще)
    const isBambu = ((hasMqtt || hasMqttTls) && bambuSignals >= 2)
                 || (hasFtps && hasRtsps);  // 990+322 = точно Bambu даже без MQTT

    if (hasMqtt && bambuSignals < 2) {
      console.log(`[Scanner] ${ip}:1883 — MQTT без Bambu-сигнатур, пропуск`);
    }

    if (isBambu) {
      const confidence = bambuSignals >= 3 ? 'high' : 'medium';
      const sigList = [
        hasMqtt    && '1883/mqtt',
        hasMqttTls && '8883/mqtts',
        hasFtps    && '990/ftps',
        hasRtsps   && '322/rtsps',
        hasHttp3k  && '3000/http',
        hasSsh     && '2222/ssh',
      ].filter(Boolean).join(', ');
      const mqttPort = hasMqttTls ? 8883 : 1883;
      results.push({
        ip, type: 'bambu', port: mqttPort,
        name: `Bambu Lab (${ip})`,
        confidence,
        protocol: hasMqttTls ? 'mqtts' : 'mqtt',
        group: 'bambu',
        needs_credentials: true,
        notes: `Сигнатуры: ${sigList} · нужен Access Code + Serial`,
        config: {
          id:          `bambu-${ip.replace(/\./g, '-')}`,
          name:        `Bambu Lab ${ip}`,
          ip,
          serial:      'ЗАМЕНИТЕ_СЕРИЙНЫЙ_НОМЕР',
          access_code: 'ЗАМЕНИТЕ_ACCESS_CODE',
          material:    'PLA',
        },
        setup_steps: [
          '1. Settings → Network → LAN Only Mode → включить',
          '2. Скопировать Access Code (8 символов)',
          '3. Settings → Device Info → Serial Number',
          '4. Ввести оба поля в жёлтом блоке на карточке и нажать «Добавить»',
        ],
      });
    }
  }

  // ── Klipper / Moonraker: порт 7125 ───────────────────────────────────────
  // Многие принтеры (Creality K1/K2, Anycubic Kobra, QIDI) работают на Klipper.
  // Пробуем определить бренд/модель через Moonraker API.
  if (openPorts.includes(7125)) {
    let serverInfo = null;
    let printerName = `Klipper (${ip})`;
    let brand = null;
    let model = null;
    let confidence = 'medium';
    try {
      const res = await httpGet(`http://${ip}:7125/server/info`, 2000);
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (data?.result?.klippy_state !== undefined) {
          confidence = 'high';
          serverInfo = data.result;

          // Определяем бренд/модель через printer.info и hostname
          const [infoRes, sysRes] = await Promise.all([
            httpGet(`http://${ip}:7125/printer/info`, 1500).catch(() => null),
            httpGet(`http://${ip}:7125/machine/system_info`, 1500).catch(() => null),
          ]);

          let hostname = '';
          let softVer = '';
          if (sysRes) {
            try {
              const sysInfo = JSON.parse(sysRes.body || '{}');
              hostname = sysInfo?.result?.system_info?.cpu_info?.hostname
                || sysInfo?.result?.system_info?.hostname
                || '';
            } catch {}
          }
          if (infoRes) {
            try {
              const info = JSON.parse(infoRes.body || '{}');
              softVer = info?.result?.software_version || info?.result?.software_version || '';
              const sw = softVer + ' ' + hostname;
              // Creality прошивки / hostname
              if (/creality|CR-|K1|K2|Ender|Nebula|Sonic\s*Pad/i.test(sw)) brand = 'Creality';
              else if (/qidi/i.test(sw)) brand = 'QIDI';
              else if (/anycubic|kobra/i.test(sw)) brand = 'Anycubic';
              else if (/voron|ratrig|rapido/i.test(sw + hostname)) brand = brand; // leave null → generic Klipper
            } catch {}
          }

          // Hostname часто содержит модель: "creality-k2plus", "K1-Max", etc.
          if (hostname) {
            const hn = hostname.toLowerCase();
            if (/k2.*plus/i.test(hn))       { brand = 'Creality'; model = 'K2 Plus'; }
            else if (/k2.*combo/i.test(hn)) { brand = 'Creality'; model = 'K2 Combo'; }
            else if (/k1.*max/i.test(hn))   { brand = 'Creality'; model = 'K1 Max'; }
            else if (/k1.*se/i.test(hn))    { brand = 'Creality'; model = 'K1 SE'; }
            else if (/k1[^a-z]/i.test(hn) || hn === 'k1') { brand = 'Creality'; model = 'K1'; }
            else if (/ender/i.test(hn))     { brand = 'Creality'; model = hostname; }
            else if (/creality/i.test(hn))  { brand = 'Creality'; model = model || hostname; }
            if (!brand && !model) printerName = `Klipper: ${hostname} (${ip})`;
          }

          // Доп. эвристика: Creality часто открывает 4409/8000 рядом с Moonraker
          if (!brand && (openPorts.includes(4409) || openPorts.includes(8000))) {
            brand = 'Creality';
          }

          if (brand) printerName = `${brand} ${model || ''} (${ip})`.replace(/\s+/g, ' ');
        }
      }
    } catch {}

    // Проверяем: если тот же IP определён как Bambu, Klipper-запись лишняя
    // (у Bambu иногда 7125 тоже открыт от побочных процессов)
    const alreadyBambu = results.some(r => r.ip === ip && r.type === 'bambu');

    if (!alreadyBambu) {
      const isCreality = brand === 'Creality';
      results.push({
        ip,
        // type остаётся klipper для коннектора пула; UI группирует по brand/group
        type: 'klipper',
        group: isCreality ? 'creality' : 'klipper',
        port: 7125,
        name: printerName,
        confidence,
        protocol: 'moonraker-ws',
        brand: brand || null,
        model: model || null,
        notes: serverInfo
          ? `Klippy: ${serverInfo.klippy_state}${brand ? ' · ' + brand + (model ? ' ' + model : '') : ''}`
          : 'Moonraker API обнаружен',
        config: {
          id:       `klipper-${ip.replace(/\./g, '-')}`,
          name:     printerName,
          ip,
          port:     7125,
          material: 'PLA',
          brand: brand || undefined,
          model: model || undefined,
        },
        setup_steps: isCreality
          ? [
              'Creality на Klipper/Moonraker — можно добавить сразу без кода доступа',
              'Откройте Fluidd/Mainsail в браузере по IP при необходимости',
            ]
          : brand
          ? [`${brand} ${model || ''} работает на Klipper — можно добавить сразу`.trim(),
             'Если нужен API-ключ: Mainsail → Settings → API Keys']
          : ['Klipper/Moonraker — обычно добавляется без кода',
             'Если нужен API-ключ: Mainsail → Settings → API Keys'],
      });
    }
  }

  // ── OctoPrint: порт 80 или 5000 ──────────────────────────────────────────
  for (const port of [80, 5000, 8080]) {
    if (!openPorts.includes(port)) continue;
    let isOctoPrint = false;
    let octoVersion = null;
    try {
      const res = await httpGet(`http://${ip}:${port}/api/version`, 2000);
      if (res.status === 200 || res.status === 403) {
        const data = JSON.parse(res.body || '{}');
        if (data?.api || data?.server || res.status === 403) {
          isOctoPrint = true;
          octoVersion = data?.server;
        }
      }
    } catch {}

    // Проверяем Phrozen (похожий HTTP на порту 80)
    let isPhrozen = false;
    if (port === 80 && !isOctoPrint) {
      try {
        const res = await httpGet(`http://${ip}/api/v1/machine/status`, 1000);
        if (res.status === 200) {
          const data = JSON.parse(res.body || '{}');
          if (data?.currentStatus !== undefined) isPhrozen = true;
        }
      } catch {}
    }

    if (isPhrozen) {
      results.push({
        ip, type: 'phrozen', port,
        name: `Phrozen (${ip})`,
        confidence: 'high',
        protocol: 'http',
        notes: 'Phrozen HTTP API обнаружен',
        config: {
          id: `phrozen-${ip.replace(/\./g, '-')}`,
          name: `Phrozen ${ip}`,
          ip, port,
          material: 'Resin',
        },
        setup_steps: ['Конфигурация не требует ключей — можно сразу добавить'],
      });
    } else if (isOctoPrint) {
      results.push({
        ip, type: 'octoprint', port,
        name: `OctoPrint${octoVersion ? ' v'+octoVersion : ''} (${ip})`,
        confidence: 'high',
        protocol: 'octoprint-rest',
        notes: `OctoPrint на порту ${port}${octoVersion ? ', версия '+octoVersion : ''}`,
        config: {
          id:     `octoprint-${ip.replace(/\./g, '-')}`,
          name:   `OctoPrint ${ip}`,
          ip,
          port,
          apiKey: 'ЗАМЕНИТЕ_API_KEY',
          material: 'PLA',
        },
        setup_steps: [
          'OctoPrint → Settings → Application API Key',
          'Скопировать ключ и вставить в config.js → раздел octoprint',
        ],
      });
    }
  }

  // ── FlashForge: порт 8899 (TCP raw protocol) ─────────────────────────────
  if (openPorts.includes(8899)) {
    let ffName = `FlashForge (${ip})`;
    let confidence = 'medium';
    try {
      const response = await new Promise((resolve) => {
        const sock = new net.Socket();
        let buf = '';
        let done = false;
        const finish = (v) => { if (done) return; done = true; sock.destroy(); resolve(v); };
        // Hard timeout 3s — не зависаем
        const timer = setTimeout(() => finish(null), 3000);
        sock.setTimeout(2000);
        sock.on('connect', () => sock.write('~M601 S1\r\n'));
        sock.on('data', d => {
          buf += d.toString();
          if (buf.includes('Control Success') && !buf.includes('~M115')) {
            sock.write('~M115\r\n');
          }
          if (buf.includes('Machine Type:')) {
            const m = buf.match(/Machine Type:\s*([^\r\n]+)/);
            clearTimeout(timer);
            finish(m ? m[1].trim() : null);
          }
        });
        sock.on('timeout', () => { clearTimeout(timer); finish(null); });
        sock.on('error',   () => { clearTimeout(timer); finish(null); });
        sock.connect(8899, ip);
      });
      if (response) { ffName = `${response} (${ip})`; confidence = 'high'; }
    } catch {}
    results.push({
      ip, type: 'flashforge', port: 8899,
      name: ffName,
      confidence,
      protocol: 'tcp-raw',
      group: 'flashforge',
      needs_credentials: true,
      notes: 'Нужны Serial + Check Code (LAN Mode) — введите на карточке ниже',
      config: {
        id:   `flashforge-${ip.replace(/\./g, '-')}`,
        name: ffName,
        ip,
        port: 8899,
        material: 'PLA',
        flashforgeSerial: 'ЗАМЕНИТЕ_SERIAL',
        flashforgeCheckCode: 'ЗАМЕНИТЕ_CHECKCODE',
      },
      setup_steps: [
        '1. Settings → Network → LAN Mode → включить',
        '2. Скопировать Check Code с экрана',
        '3. Serial — на корпусе / About (SN…)',
        '4. Ввести оба поля в жёлтом блоке на карточке и нажать «Добавить»',
      ],
    });
  }

  // ── Elegoo / Creality Box: попробуем HTTP на 4998 ────────────────────────
  if (openPorts.includes(4998)) {
    results.push({
      ip, type: 'creality-box', port: 4998,
      name: `Creality Box (${ip})`,
      confidence: 'medium',
      protocol: 'http',
      group: 'creality',
      brand: 'Creality',
      notes: 'Возможно Creality Nebula / Box',
      config: {
        id:   `creality-${ip.replace(/\./g, '-')}`,
        name: `Creality ${ip}`,
        ip,
        port: 4998,
        material: 'PLA',
        brand: 'Creality',
      },
      setup_steps: ['Creality Box — добавьте в пул; протокол приведётся к Klipper при необходимости'],
    });
  }

  return results;
}

// ─── UDP сканирование Elegoo / ChiTuBox ───────────────────────────────────
// Разные поколения принтеров используют разные форматы:
// - Elegoo Saturn/Mars (v1): JSON с Cmd:0, Attributes:'ALL', порт 3000
// - Elegoo Saturn 4K/Ultra (v2): простой текст "M99999", порт 3000
// - ChiTuBox v4+: JSON с "cmd":"discover", порт 3000 или 18188
// Отправляем все варианты — принтер ответит на тот, который знает.
function scanElegooUDP(subnet, timeoutMs = 3000) {
  return new Promise(resolve => {
    const found = new Map(); // ip → device (чтобы не дублировать)
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.bind(() => {
      sock.setBroadcast(true);
      const broadcastAddr = subnet + '.255';

      // Формат 1: Elegoo v1 (Saturn, Mars Pro)
      const ping1 = Buffer.from(JSON.stringify({
        Id: '1',
        Data: { Cmd: 0, Data: { Attributes: 'ALL' }, From: 0, MainboardID: '0', RequestID: '1', TimeStamp: Date.now() }
      }));
      sock.send(ping1, 3000, broadcastAddr, () => {});

      // Формат 2: M99999 (ChiTuBox v3 — Saturn 4K, Mars 4 Ultra и т.д.)
      const ping2 = Buffer.from('M99999\r\n');
      sock.send(ping2, 3000, broadcastAddr, () => {});

      // Формат 3: JSON discover (ChiTuBox v4+)
      const ping3 = Buffer.from(JSON.stringify({ cmd: 'discover' }));
      sock.send(ping3, 3000, broadcastAddr, () => {});

      // Формат 4: пробуем порт 18188 (некоторые Elegoo/Anycubic)
      sock.send(ping1, 18188, broadcastAddr, () => {});
      sock.send(ping2, 18188, broadcastAddr, () => {});

      // Повторяем через 500мс (UDP может потеряться)
      setTimeout(() => {
        try {
          sock.send(ping1, 3000, broadcastAddr, () => {});
          sock.send(ping2, 3000, broadcastAddr, () => {});
        } catch {}
      }, 500);
    });
    sock.on('message', (msg, rinfo) => {
      if (found.has(rinfo.address)) return; // уже нашли этот IP
      try {
        const text = msg.toString('utf8').trim();
        let machineName = null;
        let machineType = null;

        // Пробуем JSON-парсинг
        if (text.startsWith('{')) {
          const data = JSON.parse(text);
          // Формат v1: data.Data.Attributes
          if (data?.Data?.Attributes) {
            machineName = data.Data.Attributes?.MachineName || data.Data.Name;
            machineType = data.Data.Attributes?.MachineType;
          }
          // Формат v4: data.name / data.machine
          if (data?.name) machineName = data.name;
          if (data?.machine) machineType = data.machine;
          if (data?.model) machineType = data.model;
        }
        // Текстовый ответ (M99999 → "ok NAME:...\nTYPE:...")
        else if (text.includes('ok') || text.includes('NAME:') || text.includes('Machine')) {
          const nameMatch = text.match(/NAME:\s*(.+)/i) || text.match(/Machine(?:Name)?:\s*(.+)/i);
          if (nameMatch) machineName = nameMatch[1].trim();
          const typeMatch = text.match(/TYPE:\s*(.+)/i) || text.match(/Machine(?:Type)?:\s*(.+)/i);
          if (typeMatch) machineType = typeMatch[1].trim();
        }
        // Любой ответ на наш broadcast — это Elegoo/ChiTuBox принтер
        else if (text.length > 2) {
          // Минимальный ответ — считаем за принтер
        } else {
          return; // пустой или слишком короткий ответ — пропуск
        }

        const displayName = machineName || machineType || `Elegoo (${rinfo.address})`;
        found.set(rinfo.address, {
          ip: rinfo.address,
          type: 'elegoo',
          port: rinfo.port,
          name: displayName,
          confidence: machineName ? 'high' : 'medium',
          protocol: 'udp',
          notes: `${machineType || 'ChiTuBox'} — UDP обнаружен` + (machineName ? ` (${machineName})` : ''),
          config: {
            id:       `elegoo-${rinfo.address.replace(/\./g, '-')}`,
            name:     displayName,
            ip:       rinfo.address,
            material: 'Resin',
          },
          setup_steps: ['Конфигурация не требует ключей — можно сразу добавить'],
        });
        console.log(`[Scanner] Elegoo найден: ${displayName} (${rinfo.address}:${rinfo.port})`);
      } catch {}
    });
    sock.on('error', (e) => {
      console.log(`[Scanner] Elegoo UDP ошибка: ${e.message}`);
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve([...found.values()]); }, timeoutMs);
  });
}

// ─── Главная функция сканирования ──────────────────────────────────────────
const SCAN_PORTS = [1883, 8883, 7125, 80, 5000, 8080, 8899, 4998, 990, 322, 3000];
const CONCURRENT = 25;  // параллельных IP (не соединений!)
const PORT_BATCH  = 4;  // портов одновременно на 1 IP (итого макс 25×4=100 TCP)

async function startScan(options = {}) {
  if (scanState.running) return { error: 'Сканирование уже выполняется' };

  let subnets = getLocalSubnets();
  if (!subnets.length) {
    return {
      error: 'Не удалось определить локальную сеть. Установите Farm Edge на ПК в домашней LAN с принтерами и привяжите агент.',
      code: 'NO_LAN',
    };
  }

  // Фильтр подсетей: options.prefixes = ['192.168.31', ...]
  if (Array.isArray(options.prefixes) && options.prefixes.length) {
    const want = new Set(options.prefixes.map(p => String(p).trim()).filter(Boolean));
    subnets = subnets.filter(s => want.has(s.prefix));
    if (!subnets.length) {
      return { error: 'Ни одна из выбранных подсетей не совпала с локальными интерфейсами: ' + [...want].join(', ') };
    }
  }

  const skippedIps = getHostIps(subnets);

  abortScan = false;
  scanState = {
    running:    true,
    progress:   0,
    total:      0,
    checked:    0,
    found:      [],
    startedAt:  new Date().toISOString(),
    finishedAt: null,
    error:      null,
    subnets:    subnets.map(s => s.prefix + '.0/24'),
    skippedIps,
  };

  // Запускаем асинхронно, не блокируем HTTP-ответ
  runScan(subnets).catch(e => {
    scanState.error   = e.message;
    scanState.running = false;
  });

  return {
    ok: true,
    message: 'Сканирование запущено',
    subnets: scanState.subnets,
    skippedIps,
    hint: skippedIps.length
      ? `IP агента/сервера не сканируется: ${skippedIps.join(', ')}`
      : undefined,
  };
}

async function runScan(subnets) {
  const skipHosts = new Set(getHostIps(subnets));
  const allIPs = [];
  for (const { prefix } of subnets) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${prefix}.${i}`;
      // Сам сервер / Farm Edge не сканируем — это не принтер.
      if (skipHosts.has(ip)) continue;
      allIPs.push(ip);
    }
  }
  scanState.total = allIPs.length;
  scanState.skippedIps = [...skipHosts];

  // Шаг 1: быстрый TCP-порт-чек (порт 80 — самый широкий)
  // Используем семафор для CONCURRENT параллельных соединений
  const semaphore = new Semaphore(CONCURRENT);
  const openHosts = []; // { ip, ports[] }

  const checks = allIPs.map(ip =>
    semaphore.use(async () => {
      if (abortScan) return;
      // Проверяем порты батчами по PORT_BATCH, чтобы не перегружать сеть
      const allResults = [];
      for (let i = 0; i < SCAN_PORTS.length; i += PORT_BATCH) {
        if (abortScan) return;
        const batch = SCAN_PORTS.slice(i, i + PORT_BATCH);
        const batchResults = await Promise.all(
          batch.map(port => tcpProbe(ip, port, 800).then(open => ({ port, open })))
        );
        allResults.push(...batchResults);
      }
      if (abortScan) return;
      const openPorts = allResults.filter(p => p.open).map(p => p.port);
      scanState.checked++;
      scanState.progress = Math.round(scanState.checked / scanState.total * 85);
      if (openPorts.length > 0) {
        // Фильтр "all-ports-open": если устройство отвечает на 6+ из наших портов,
        // это сетевое оборудование (свитч/роутер/VPN), а не принтер. Пропускаем.
        if (openPorts.length >= 6) {
          console.log(`[Scanner] ${ip} — ${openPorts.length}/${SCAN_PORTS.length} портов открыты, пропуск (сетевое оборудование)`);
        } else {
          openHosts.push({ ip, openPorts });
        }
      }
    })
  );
  await Promise.all(checks);

  if (abortScan) { finishScan('Остановлено пользователем'); return; }

  // Шаг 2: fingerprint найденных хостов (с таймаутом 10с на каждый IP)
  scanState.progress = 87;
  for (const { ip, openPorts } of openHosts) {
    if (abortScan) break;
    try {
      const devices = await Promise.race([
        fingerprint(ip, openPorts),
        new Promise((_, rej) => setTimeout(() => rej(new Error('fingerprint timeout')), 10000)),
      ]);
      scanState.found.push(...devices);
    } catch (e) {
      console.log(`[Scanner] ${ip} fingerprint пропущен: ${e.message}`);
    }
  }

  if (abortScan) { finishScan('Остановлено пользователем'); return; }

  // Шаг 3: UDP сканирование Elegoo (broadcast)
  scanState.progress = 92;
  for (const { prefix } of subnets) {
    if (abortScan) break;
    const elegooDevices = await scanElegooUDP(prefix, 2500);
    for (const dev of elegooDevices) {
      if (!scanState.found.find(f => f.ip === dev.ip)) {
        scanState.found.push(dev);
      }
    }
  }

  finishScan();
}

function finishScan(message) {
  scanState.progress   = message ? scanState.progress : 100;
  scanState.running    = false;
  scanState.finishedAt = new Date().toISOString();
  if (message) scanState.error = message;

  // Помечаем уже добавленные (по IP), но НЕ скрываем — UI показывает «✓ Уже в пуле».
  // Раньше filter() оставлял только «новых» (часто только Bambu), и Flashforge/Elegoo
  // пропадали из результатов после массового добавления.
  let alreadyInPool = 0;
  if (poolIPs.size > 0) {
    for (const dev of scanState.found) {
      if (poolIPs.has(dev.ip)) {
        dev.in_pool = true;
        alreadyInPool++;
      }
    }
  }

  console.log(`[Scanner] ${message || 'Завершено'}: найдено ${scanState.found.length} устройств` +
    (alreadyInPool ? ` (${alreadyInPool} уже в пуле)` : '') +
    ` за ${((new Date(scanState.finishedAt) - new Date(scanState.startedAt)) / 1000).toFixed(1)}с`);
}

// Обновляет список IP-адресов уже добавленных принтеров (вызывается из server.js)
function setPoolIPs(ips) {
  poolIPs = new Set(ips.filter(Boolean));
}

// ─── Простой семафор ────────────────────────────────────────────────────────
class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }
  use(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.count++;
        try { resolve(await fn()); }
        catch (e) { reject(e); }
        finally {
          this.count--;
          if (this.queue.length) this.queue.shift()();
        }
      };
      if (this.count < this.max) run();
      else this.queue.push(run);
    });
  }
}

// ─── Генерация фрагмента config.js для добавления принтера ─────────────────
function generateConfigSnippet(device) {
  const { type, config } = device;
  if (!config) return null;

  const sections = {
    bambu:       'bambu',
    klipper:     'klipper',
    octoprint:   'octoprint',
    flashforge:  'flashforge',
    elegoo:      'elegoo',
    phrozen:     'phrozen',
    'creality-box': 'klipper',
  };

  const section = sections[type] || 'klipper';
  const lines = Object.entries(config)
    .map(([k, v]) => `      ${k}: ${typeof v === 'string' ? `'${v}'` : v},`)
    .join('\n');

  return `// Добавить в config.js → раздел ${section}:\n{\n${lines}\n}`;
}

function stopScan() {
  if (!scanState.running) return { ok: false, message: 'Сканирование не запущено' };
  abortScan = true;
  return { ok: true, message: 'Остановка...' };
}

function clearScan() {
  if (scanState.running) return { ok: false, message: 'Дождитесь остановки сканирования' };
  scanState = {
    running: false, progress: 0, total: 0, checked: 0,
    found: [], startedAt: null, finishedAt: null, error: null,
    subnets: [], skippedIps: [],
  };
  return { ok: true, message: 'Результаты очищены' };
}

/**
 * Быстрый fingerprint одного IP (для онбординга / ручного ввода).
 * @param {string} ip
 * @returns {Promise<{ok:boolean, found:Array, openPorts:number[], message?:string}>}
 */
async function probeIp(ip) {
  const raw = String(ip || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
    return { ok: false, found: [], openPorts: [], message: 'Укажите IPv4, например 192.168.1.50' };
  }
  if (raw.split('.').map(Number).some((n) => n > 255)) {
    return { ok: false, found: [], openPorts: [], message: 'Некорректный IP' };
  }
  const results = await Promise.all(
    SCAN_PORTS.map((port) => tcpProbe(raw, port, 900).then((open) => ({ port, open })))
  );
  const openPorts = results.filter((p) => p.open).map((p) => p.port);
  if (!openPorts.length) {
    return {
      ok: false,
      found: [],
      openPorts: [],
      message: 'По этому IP порты принтеров закрыты. Проверьте сеть и что принтер включён.',
    };
  }
  if (openPorts.length >= 6) {
    return { ok: false, found: [], openPorts, message: 'Похоже на роутер или свитч, не на принтер.' };
  }
  let devices = [];
  try {
    devices = await Promise.race([
      fingerprint(raw, openPorts),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
    ]);
  } catch (e) {
    return {
      ok: false,
      found: [],
      openPorts,
      message: 'Устройство отвечает, но тип не распознан: ' + (e.message || 'timeout'),
    };
  }
  if (!devices.length) {
    return { ok: false, found: [], openPorts, message: 'Хост найден, но это не похоже на известный 3D-принтер.' };
  }
  return { ok: true, found: devices, openPorts, message: 'Найден' };
}

module.exports = {
  startScan,
  stopScan,
  clearScan,
  probeIp,
  getScanState: () => ({ ...scanState }),
  getLocalSubnets,
  getHostIps,
  getNetworkInfo,
  generateConfigSnippet,
  setPoolIPs,
};
