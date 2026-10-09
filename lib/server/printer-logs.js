'use strict';
/**
 * PRINTER-LOGS.JS — Сбор и выгрузка логов и диагностики с оборудования фермы.
 *
 * Поддерживает:
 *  • Bambu Lab (FTPS :990 — файлы с SD карты (/log, /logger), HMS ошибки, телеметрия)
 *  • Klipper / Moonraker (HTTP :7125 — klippy.log, moonraker.log, system info)
 *  • FlashForge (TCP :8899 — команды ~M115, ~M119, ~M105, ~M27, телеметрия)
 *  • OctoPrint (HTTP :80 — /api/logs, octoprint.log)
 *  • Elegoo / Phrozen / Generic / Offline (телеметрия, конфигурация, ошибки)
 *
 * Упаковка в чистый ZIP архив (без внешних зависимостей, на zlib + CRC32).
 */

const net = require('net');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const { Readable, PassThrough } = require('stream');

const path = require('path');
const fs = require('fs');

let ftp = null;
try { ftp = require('basic-ftp'); } catch {}

let bambuErrors = null;
try { bambuErrors = require('./bambu-errors'); } catch {}
if (!bambuErrors) {
  try { bambuErrors = require(path.join(__dirname, 'bambu-errors.js')); } catch {}
}

// ─── CRC32 & ZIP ARCHIVE BUILDER (Zero-dependency) ──────────────────────────
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[i] = c >>> 0;
}

function calcCrc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function toDosDateTime(d = new Date()) {
  const year = Math.max(1980, d.getFullYear());
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);
  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

/**
 * files: Array of { path: string, data: Buffer | string, date?: Date }
 * Returns Buffer containing standard valid ZIP archive
 */
function createZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  const now = toDosDateTime(new Date());

  for (const f of files) {
    let rawBuf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data || '', 'utf8');
    const pathNorm = String(f.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const nameBuf = Buffer.from(pathNorm, 'utf8');
    const crc = calcCrc32(rawBuf);
    const uncompressedSize = rawBuf.length;

    // Deflate
    let compBuf = rawBuf;
    let method = 0; // STORE
    if (uncompressedSize > 16) {
      try {
        const def = zlib.deflateRawSync(rawBuf);
        if (def.length < uncompressedSize) {
          compBuf = def;
          method = 8; // DEFLATE
        }
      } catch {}
    }
    const compressedSize = compBuf.length;

    const dt = f.date ? toDosDateTime(f.date) : now;

    // Local file header (30 bytes + nameBuf.length)
    const locHdr = Buffer.alloc(30);
    locHdr.writeUInt32LE(0x04034b50, 0); // signature
    locHdr.writeUInt16LE(20, 4);         // version needed (2.0)
    locHdr.writeUInt16LE(0x0800, 6);     // flags: UTF-8 filename
    locHdr.writeUInt16LE(method, 8);     // compression method
    locHdr.writeUInt16LE(dt.dosTime, 10);
    locHdr.writeUInt16LE(dt.dosDate, 12);
    locHdr.writeUInt32LE(crc, 14);
    locHdr.writeUInt32LE(compressedSize, 18);
    locHdr.writeUInt32LE(uncompressedSize, 22);
    locHdr.writeUInt16LE(nameBuf.length, 26);
    locHdr.writeUInt16LE(0, 28);         // extra field len

    localChunks.push(locHdr, nameBuf, compBuf);

    // Central directory header (46 bytes + nameBuf.length)
    const cdHdr = Buffer.alloc(46);
    cdHdr.writeUInt32LE(0x02014b50, 0); // signature
    cdHdr.writeUInt16LE(20, 4);         // version made by
    cdHdr.writeUInt16LE(20, 6);         // version needed
    cdHdr.writeUInt16LE(0x0800, 8);     // flags: UTF-8
    cdHdr.writeUInt16LE(method, 10);
    cdHdr.writeUInt16LE(dt.dosTime, 12);
    cdHdr.writeUInt16LE(dt.dosDate, 14);
    cdHdr.writeUInt32LE(crc, 16);
    cdHdr.writeUInt32LE(compressedSize, 20);
    cdHdr.writeUInt32LE(uncompressedSize, 24);
    cdHdr.writeUInt16LE(nameBuf.length, 28);
    cdHdr.writeUInt16LE(0, 30);         // extra len
    cdHdr.writeUInt16LE(0, 32);         // comment len
    cdHdr.writeUInt16LE(0, 34);         // disk number start
    cdHdr.writeUInt16LE(0, 36);         // internal attrs
    cdHdr.writeUInt32LE(0, 38);         // external attrs
    cdHdr.writeUInt32LE(offset, 42);    // relative offset of local header

    centralChunks.push(cdHdr, nameBuf);

    offset += locHdr.length + nameBuf.length + compBuf.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const c of centralChunks) centralSize += c.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // signature
  eocd.writeUInt16LE(0, 4);                // disk number
  eocd.writeUInt16LE(0, 6);                // disk with central dir
  eocd.writeUInt16LE(files.length, 8);     // entries on this disk
  eocd.writeUInt16LE(files.length, 10);    // total entries
  eocd.writeUInt32LE(centralSize, 12);     // size of central dir
  eocd.writeUInt32LE(centralOffset, 16);   // offset of central dir
  eocd.writeUInt16LE(0, 20);               // comment len

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

// ─── HELPERS ────────────────────────────────────────────────────────────────
function sanitizeFolderName(name) {
  return String(name || 'printer')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60);
}

function fetchHttpBuffer(urlStr, options = {}, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(u, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 8000,
      rejectUnauthorized: false,
    }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`));
      }
      const chunks = [];
      let total = 0;
      res.on('data', chunk => {
        total += chunk.length;
        if (total <= maxBytes) {
          chunks.push(chunk);
        } else {
          // Truncate to maxBytes
          const remain = maxBytes - (total - chunk.length);
          if (remain > 0) chunks.push(chunk.slice(0, remain));
          res.destroy();
          resolve({ buffer: Buffer.concat(chunks), truncated: true, totalBytes: total });
        }
      });
      res.on('end', () => {
        resolve({ buffer: Buffer.concat(chunks), truncated: false, totalBytes: total });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout ${options.timeout || 8000}ms`)); });
    req.on('error', reject);
    req.end();
  });
}

// ─── BAMBU LAB LOGS (FTPS :990 + HMS/Telemetery) ────────────────────────────
async function collectBambuLogs(printer, liveState, timeoutMs = 90000, mode = 'dump') {
  const files = [];
  const errors = [];

  // Fallback for access code if missing
  if (!printer.access_code) {
    try {
      const candidates = [
        process.env.FARM_BFF_DIR && path.join(process.env.FARM_BFF_DIR, 'data', 'bambu-access-codes.json'),
        path.join(__dirname, '..', '..', 'farm-bff', 'data', 'bambu-access-codes.json'),
        path.join(__dirname, 'data', 'bambu-access-codes.json'),
      ].filter(Boolean);
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          const codes = JSON.parse(fs.readFileSync(cand, 'utf8'));
          printer.access_code = (printer.serial && codes[printer.serial]) || (printer.id && codes[printer.id]) || null;
          if (printer.access_code) break;
        }
      }
    } catch {}
  }

  // 1. Diagnostics & HMS
  const diag = {
    printer_id: printer.id,
    name: printer.name,
    type: printer.type,
    ip: printer.ip,
    serial: printer.serial,
    collected_at: new Date().toISOString(),
    live_state: liveState || null,
    hms_decoded: [],
  };

  if (liveState && bambuErrors) {
    if (liveState.print_error) {
      diag.print_error_decoded = bambuErrors.decodePrintError(liveState.print_error);
    }
    if (Array.isArray(liveState.hms)) {
      diag.hms_decoded = bambuErrors.decodeHmsList(liveState.hms);
    }
  }

  files.push({
    name: 'diagnostics.json',
    data: JSON.stringify(diag, null, 2),
  });

  // 2. FTPS download
  if (!ftp) {
    errors.push('Пакет basic-ftp не установлен на сервере.');
  } else if (!printer.ip || !printer.access_code) {
    errors.push('Для Bambu Lab не указан IP или access_code.');
  } else {
    async function createBambuClient() {
      const c = new ftp.Client(timeoutMs);
      c.ftp.verbose = false;
      await c.access({
        host: printer.ip,
        port: 990,
        user: 'bblp',
        password: printer.access_code,
        secure: 'implicit',
        secureOptions: {
          rejectUnauthorized: false,
          minVersion: 'TLSv1.2',
          checkServerIdentity: () => undefined,
        },
      });
      return c;
    }

    try {
      // 2.1 First connection: list directories and find completed files
      const listClient = await createBambuClient();
      const candidateDirs = (mode === 'full') ? ['/recorder', '/logger'] : ['/recorder'];
      const foundLogFiles = [];

      try {
        for (const d of candidateDirs) {
          try {
            const list = await listClient.list(d);
            const logItems = list.filter(i => {
              const isF = (i.type === 1 || i.isFile || !i.isDirectory);
              return isF && /\.(log|tar|gz|dump|txt|crash|bin)$/i.test(i.name) && i.size > 0;
            });
            if (logItems.length > 0) {
              logItems.sort((a, b) => a.name.localeCompare(b.name));
              // Filter out the active file to avoid printer closing connection
              const completed = logItems.filter(i => {
                if (d === '/recorder') return i.size >= 4000000;
                if (d === '/logger') return i.size >= 25000000;
                return true;
              });
              const pickFrom = completed.length > 0 ? completed : logItems;
              // Take second to last if available, else last
              const target = pickFrom.length >= 2 ? pickFrom[pickFrom.length - 2] : pickFrom[pickFrom.length - 1];
              if (target) {
                foundLogFiles.push({ dir: d, name: target.name, size: target.size });
              }
            }
          } catch {}
        }

        // Fallback: if in 'dump' mode and recorder was empty, check logger
        if (foundLogFiles.length === 0 && mode !== 'full') {
          try {
            const list = await listClient.list('/logger');
            const logItems = list.filter(i => (i.type === 1 || i.isFile || !i.isDirectory) && /\.log$/i.test(i.name) && i.size > 0);
            if (logItems.length > 0) {
              logItems.sort((a, b) => a.name.localeCompare(b.name));
              const target = logItems.length >= 2 ? logItems[logItems.length - 2] : logItems[logItems.length - 1];
              foundLogFiles.push({ dir: '/logger', name: target.name, size: target.size });
            }
          } catch {}
        }
      } finally {
        listClient.close();
      }

      // 2.2 Download each file in a dedicated fresh connection (Bambu drops multi-file sessions)
      if (mode === 'metadata' || mode === 'check') {
        for (const item of foundLogFiles) {
          const folderPrefix = item.dir.replace(/^\//, '') || 'logs';
          files.push({
            name: `${folderPrefix}/${item.name}`,
            data: Buffer.from(`BAMBU_DUMP_META: ${item.name} (${(item.size/(1024*1024)).toFixed(2)} MB)`, 'utf8'),
          });
        }
      } else {
        for (const item of foundLogFiles) {
          await new Promise(r => setTimeout(r, 1000));
          let dlClient = null;
          try {
            dlClient = await createBambuClient();
            const remotePath = `${item.dir.replace(/\/$/, '')}/${item.name}`;
            const chunks = [];
            const pass = new PassThrough();
            pass.on('data', c => chunks.push(c));
            await dlClient.downloadTo(pass, remotePath);
            const buf = Buffer.concat(chunks);
            const folderPrefix = item.dir.replace(/^\//, '') || 'logs';
            files.push({
              name: `${folderPrefix}/${item.name}`,
              data: buf,
            });
          } catch (dlErr) {
            errors.push(`Не удалось скачать ${item.name}: ${dlErr.message}`);
          } finally {
            if (dlClient) dlClient.close();
          }
        }
      }

      if (foundLogFiles.length === 0) {
        files.push({
          name: 'logs_note.txt',
          data: 'На SD-карте принтера не обнаружено файлов .log/.bin/.tar.gz в стандартных каталогах (/recorder, /logger). Доступ к FTPS работает штатно.',
        });
      }
    } catch (ftpErr) {
      errors.push(`FTPS ошибка (${printer.ip}:990): ${ftpErr.message}`);
    }
  }

  // Summary file
  let summary = `ПРИНТЕР: ${printer.name} (${printer.id})\n`;
  summary += `ТИП: ${printer.type} · IP: ${printer.ip || '—'} · Serial: ${printer.serial || '—'}\n`;
  summary += `СТАТУС: ${liveState?.status || 'неизвестен'}\n`;
  summary += `ВРЕМЯ СБОРА: ${new Date().toLocaleString('ru-RU')}\n`;
  if (diag.hms_decoded.length > 0) {
    summary += `\nАКТУАЛЬНЫЕ HMS ОШИБКИ:\n`;
    for (const h of diag.hms_decoded) {
      summary += ` - [${h.code}] ${h.text}\n`;
    }
  }
  if (errors.length > 0) {
    summary += `\nПРЕДУПРЕЖДЕНИЯ ПРИ СБОРЕ ЛОГОВ:\n`;
    for (const e of errors) summary += ` - ${e}\n`;
  }
  files.push({ name: 'summary.txt', data: summary });

  return { ok: errors.length === 0, errors, files };
}

// ─── KLIPPER / MOONRAKER LOGS ───────────────────────────────────────────────
async function collectKlipperLogs(printer, liveState, timeoutMs = 10000) {
  const files = [];
  const errors = [];
  const port = printer.port || 7125;
  const base = `http://${printer.ip}:${port}`;
  const headers = printer.apiKey ? { 'X-Api-Key': printer.apiKey } : {};

  // Diagnostics
  const diag = {
    printer_id: printer.id,
    name: printer.name,
    type: printer.type,
    ip: printer.ip,
    port: port,
    collected_at: new Date().toISOString(),
    live_state: liveState || null,
  };

  // 1. klippy.log
  try {
    const res = await fetchHttpBuffer(`${base}/server/files/klippy.log`, { headers, timeout: timeoutMs }, 4 * 1024 * 1024);
    files.push({
      name: 'klippy.log',
      data: res.buffer,
    });
  } catch (e) {
    errors.push(`klippy.log: ${e.message}`);
  }

  // 2. moonraker.log
  try {
    const res = await fetchHttpBuffer(`${base}/server/files/moonraker.log`, { headers, timeout: timeoutMs }, 2 * 1024 * 1024);
    files.push({
      name: 'moonraker.log',
      data: res.buffer,
    });
  } catch (e) {
    errors.push(`moonraker.log: ${e.message}`);
  }

  // 3. Moonraker server info
  try {
    const res = await fetchHttpBuffer(`${base}/server/info`, { headers, timeout: 4000 }, 256 * 1024);
    try { diag.server_info = JSON.parse(res.buffer.toString('utf8')); } catch {}
  } catch {}

  files.push({
    name: 'diagnostics.json',
    data: JSON.stringify(diag, null, 2),
  });

  let summary = `ПРИНТЕР: ${printer.name} (${printer.id})\n`;
  summary += `ТИП: ${printer.type} · Moonraker: ${base}\n`;
  summary += `СТАТУС: ${liveState?.status || 'неизвестен'}\n`;
  summary += `ВРЕМЯ СБОРА: ${new Date().toLocaleString('ru-RU')}\n`;
  if (errors.length > 0) {
    summary += `\nПРЕДУПРЕЖДЕНИЯ:\n`;
    for (const e of errors) summary += ` - ${e}\n`;
  }
  files.push({ name: 'summary.txt', data: summary });

  return { ok: errors.length === 0, errors, files };
}

// ─── FLASHFORGE LOGS (TCP :8899) ───────────────────────────────────────────
async function collectFlashForgeLogs(printer, liveState, timeoutMs = 8000) {
  const files = [];
  const errors = [];

  const diag = {
    printer_id: printer.id,
    name: printer.name,
    type: printer.type,
    ip: printer.ip,
    collected_at: new Date().toISOString(),
    live_state: liveState || null,
  };

  // TCP query
  let tcpTranscript = '';
  try {
    tcpTranscript = await new Promise((resolve, reject) => {
      let out = '';
      const s = net.createConnection({ host: printer.ip, port: printer.port || 8899, timeout: timeoutMs });
      const timer = setTimeout(() => {
        try { s.destroy(); } catch {}
        resolve(out || 'Timeout waiting for Flashforge TCP response');
      }, timeoutMs);

      s.on('connect', () => {
        out += '=== CONNECTED TO ' + printer.ip + ':' + (printer.port || 8899) + ' ===\n';
        s.write('~M601 S1\r\n');
        setTimeout(() => s.write('~M115\r\n'), 300);
        setTimeout(() => s.write('~M119\r\n'), 600);
        setTimeout(() => s.write('~M105\r\n'), 900);
        setTimeout(() => s.write('~M27\r\n'), 1200);
        setTimeout(() => {
          clearTimeout(timer);
          try { s.end(); } catch {}
          resolve(out);
        }, 2200);
      });

      s.on('data', chunk => {
        out += chunk.toString('utf8');
      });

      s.on('timeout', () => {
        clearTimeout(timer);
        try { s.destroy(); } catch {}
        reject(new Error('TCP timeout'));
      });

      s.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } catch (e) {
    errors.push(`FlashForge TCP: ${e.message}`);
    tcpTranscript = `Ошибка соединения с ${printer.ip}: ${e.message}`;
  }

  files.push({
    name: 'mightyboard_diag.txt',
    data: tcpTranscript,
  });

  files.push({
    name: 'diagnostics.json',
    data: JSON.stringify(diag, null, 2),
  });

  let summary = `ПРИНТЕР: ${printer.name} (${printer.id})\n`;
  summary += `ТИП: ${printer.type} · IP: ${printer.ip || '—'}\n`;
  summary += `СТАТУС: ${liveState?.status || 'неизвестен'}\n`;
  summary += `ВРЕМЯ СБОРА: ${new Date().toLocaleString('ru-RU')}\n`;
  if (errors.length > 0) {
    summary += `\nПРЕДУПРЕЖДЕНИЯ:\n`;
    for (const e of errors) summary += ` - ${e}\n`;
  }
  files.push({ name: 'summary.txt', data: summary });

  return { ok: errors.length === 0, errors, files };
}

// ─── OCTOPRINT LOGS ────────────────────────────────────────────────────────
async function collectOctoPrintLogs(printer, liveState, timeoutMs = 10000) {
  const files = [];
  const errors = [];
  const port = printer.port || 80;
  const base = `http://${printer.ip}:${port}`;
  const headers = printer.apiKey ? { 'X-Api-Key': printer.apiKey } : {};

  const diag = {
    printer_id: printer.id,
    name: printer.name,
    type: printer.type,
    ip: printer.ip,
    collected_at: new Date().toISOString(),
    live_state: liveState || null,
  };

  try {
    const listRes = await fetchHttpBuffer(`${base}/api/logs`, { headers, timeout: 6000 });
    const listJson = JSON.parse(listRes.buffer.toString('utf8'));
    diag.logs_catalog = listJson;

    // Download octoprint.log
    try {
      const logRes = await fetchHttpBuffer(`${base}/api/logs/octoprint.log`, { headers, timeout: timeoutMs }, 3 * 1024 * 1024);
      files.push({ name: 'octoprint.log', data: logRes.buffer });
    } catch (dlErr) {
      errors.push(`octoprint.log: ${dlErr.message}`);
    }
  } catch (e) {
    errors.push(`OctoPrint API: ${e.message}`);
  }

  files.push({ name: 'diagnostics.json', data: JSON.stringify(diag, null, 2) });

  let summary = `ПРИНТЕР: ${printer.name} (${printer.id})\n`;
  summary += `ТИП: ${printer.type} · OctoPrint: ${base}\n`;
  summary += `СТАТУС: ${liveState?.status || 'неизвестен'}\n`;
  summary += `ВРЕМЯ СБОРА: ${new Date().toLocaleString('ru-RU')}\n`;
  if (errors.length > 0) {
    summary += `\nПРЕДУПРЕЖДЕНИЯ:\n`;
    for (const e of errors) summary += ` - ${e}\n`;
  }
  files.push({ name: 'summary.txt', data: summary });

  return { ok: errors.length === 0, errors, files };
}

// ─── GENERIC / OFFLINE LOGS ────────────────────────────────────────────────
async function collectGenericLogs(printer, liveState) {
  const files = [];
  const diag = {
    printer_id: printer.id,
    name: printer.name,
    type: printer.type,
    ip: printer.ip || null,
    model: printer.model || printer.name,
    collected_at: new Date().toISOString(),
    live_state: liveState || null,
  };

  files.push({
    name: 'diagnostics.json',
    data: JSON.stringify(diag, null, 2),
  });

  let summary = `ПРИНТЕР: ${printer.name} (${printer.id})\n`;
  summary += `ТИП: ${printer.type} · IP: ${printer.ip || 'offline'}\n`;
  summary += `СТАТУС: ${liveState?.status || 'offline'}\n`;
  summary += `ВРЕМЯ СБОРА: ${new Date().toLocaleString('ru-RU')}\n`;
  files.push({ name: 'summary.txt', data: summary });

  return { ok: true, errors: [], files };
}

// ─── DISPATCH PER PRINTER ──────────────────────────────────────────────────
async function collectLogsForPrinter(printer, liveState, mode = 'dump') {
  const type = String(printer.type || '').toLowerCase();
  try {
    if (type === 'bambu') {
      return await collectBambuLogs(printer, liveState, 90000, mode);
    } else if (type === 'klipper') {
      return await collectKlipperLogs(printer, liveState);
    } else if (type === 'flashforge') {
      return await collectFlashForgeLogs(printer, liveState);
    } else if (type === 'octoprint') {
      return await collectOctoPrintLogs(printer, liveState);
    } else {
      return await collectGenericLogs(printer, liveState);
    }
  } catch (err) {
    return {
      ok: false,
      errors: [err.message || String(err)],
      files: [
        {
          name: 'error.txt',
          data: `Ошибка сбора логов для ${printer.name}: ${err.message}\n${err.stack || ''}`,
        },
      ],
    };
  }
}

/**
 * Concurrency runner for processing multiple printers safely
 */
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── MAIN COLLECT & BUILD ARCHIVE ──────────────────────────────────────────
/**
 * target: 'single' | 'multiple' | 'group'
 * printerId?: string
 * printerIds?: string[]
 * group?: 'all' | 'bambu' | 'klipper' | 'flashforge' | 'elegoo' | 'active'
 * mode?: 'dump' | 'full'
 */
async function collectAndBuildArchive({ printers, printerStates, target, printerId, printerIds, group, mode = 'dump' }) {
  let selected = [];

  if (target === 'multiple' || (Array.isArray(printerIds) && printerIds.length > 0)) {
    const idSet = new Set(Array.isArray(printerIds) ? printerIds : [printerIds]);
    selected = printers.filter(p => idSet.has(p.id));
    if (selected.length === 0) {
      throw new Error('Выбранные принтеры не найдены в пуле оборудования.');
    }
  } else if (target === 'single' && printerId) {
    const found = printers.find(p => p.id === printerId);
    if (!found) throw new Error(`Принтер с id "${printerId}" не найден.`);
    selected = [found];
  } else {
    // Group selection
    const g = String(group || 'all').toLowerCase();
    if (g === 'all') {
      selected = [...printers];
    } else if (g === 'bambu') {
      selected = printers.filter(p => p.type === 'bambu');
    } else if (g === 'klipper') {
      selected = printers.filter(p => p.type === 'klipper');
    } else if (g === 'flashforge') {
      selected = printers.filter(p => p.type === 'flashforge');
    } else if (g === 'elegoo') {
      selected = printers.filter(p => p.type === 'elegoo');
    } else if (g === 'active' || g === 'printing') {
      selected = printers.filter(p => {
        const st = printerStates[p.id];
        return st && st.status && st.status !== 'offline';
      });
    } else {
      selected = [...printers];
    }
  }

  if (selected.length === 0) {
    throw new Error('Не выбрано ни одного принтера для сбора логов.');
  }

  // Run collection with concurrency = 3
  const concurrency = mode === 'full' ? 2 : 4;
  const results = await mapConcurrent(selected, concurrency, async printer => {
    const st = printerStates[printer.id] || null;
    const res = await collectLogsForPrinter(printer, st, mode);
    return {
      printer,
      result: res,
    };
  });

  // Build file list for ZIP
  const allZipFiles = [];
  const manifestPrinters = [];
  let totalFiles = 0;

  for (const { printer, result } of results) {
    const folder = `${sanitizeFolderName(printer.name)}_${printer.type}_${(printer.ip || printer.id).replace(/[^a-zA-Z0-9_\-]/g, '_')}`;
    let pFilesCount = 0;

    for (const f of result.files) {
      allZipFiles.push({
        path: `${folder}/${f.name}`,
        data: f.data,
      });
      pFilesCount++;
      totalFiles++;
    }

    manifestPrinters.push({
      id: printer.id,
      name: printer.name,
      type: printer.type,
      ip: printer.ip || null,
      status: (printerStates[printer.id] && printerStates[printer.id].status) || 'unknown',
      ok: result.ok,
      files_count: pFilesCount,
      errors: result.errors,
    });
  }

  const manifest = {
    version: '1.0',
    title: '3D ZIPPER — Выгрузка логов и диагностики фермы',
    collected_at: new Date().toISOString(),
    filter: { target, printerId: printerId || null, printerIds: printerIds || null, group: group || null },
    total_printers: selected.length,
    successful_printers: manifestPrinters.filter(p => p.ok).length,
    error_printers: manifestPrinters.filter(p => !p.ok).length,
    total_files: totalFiles,
    printers: manifestPrinters,
  };

  allZipFiles.unshift({
    path: 'manifest.json',
    data: JSON.stringify(manifest, null, 2),
  });

  allZipFiles.unshift({
    path: 'README.txt',
    data: `3D ZIPPER — АРХИВ ЛОГОВ ОБОРУДОВАНИЯ\n` +
          `Дата выгрузки: ${new Date().toLocaleString('ru-RU')}\n` +
          `Принтеров в архиве: ${selected.length}\n` +
          `Файлов в архиве: ${totalFiles}\n\n` +
          `Каждый принтер расположен в отдельной подпапке со своими логами и diagnostics.json.\n` +
          `Подробный отчет см. в manifest.json.\n`,
  });

  const zipBuffer = createZip(allZipFiles);

  return {
    manifest,
    zipBuffer,
  };
}

module.exports = {
  createZip,
  calcCrc32,
  collectLogsForPrinter,
  collectAndBuildArchive,
};
