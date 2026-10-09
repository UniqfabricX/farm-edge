'use strict';

/**
 * Decode Bambu print_error / HMS codes to human-readable RU/EN text.
 * Sources: wiki error-code table (bundled JSON) + optional BambuStudio HMS locale files.
 */

const fs = require('fs');
const path = require('path');

const PHANTOM_PRINT_ERRORS = new Set([0, 83935249]); // 83935249 = 0x0500C011

const PRINT_ERRORS_PATH = path.join(__dirname, 'data', 'bambu-print-errors.json');

let printErrorTable = null;
let hmsLookup = null;

function loadPrintErrorTable() {
  if (printErrorTable) return printErrorTable;
  try {
    printErrorTable = JSON.parse(fs.readFileSync(PRINT_ERRORS_PATH, 'utf8'));
  } catch {
    printErrorTable = {};
  }
  return printErrorTable;
}

function hmsDirs() {
  const list = [];
  if (process.env.BAMBU_HMS_DIR) list.push(process.env.BAMBU_HMS_DIR);
  const appdata = process.env.APPDATA || '';
  if (appdata) list.push(path.join(appdata, 'BambuStudio', 'hms'));
  // Farm PC / SaaS host common paths
  list.push('C:\\Users\\User\\AppData\\Roaming\\BambuStudio\\hms');
  list.push('C:\\Users\\user\\AppData\\Roaming\\BambuStudio\\hms');
  list.push(path.join(__dirname, 'data', 'hms'));
  return list;
}

function loadHmsLookup() {
  if (hmsLookup) return hmsLookup;
  hmsLookup = new Map();
  for (const dir of hmsDirs()) {
    if (!fs.existsSync(dir)) continue;
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^hms_(ru|en)_/i.test(f) && f.endsWith('.json'));
    } catch {
      continue;
    }
    // Prefer RU first, then EN
    files.sort((a, b) => {
      const ar = /^hms_ru_/i.test(a) ? 0 : 1;
      const br = /^hms_ru_/i.test(b) ? 0 : 1;
      return ar - br;
    });
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        const sections = raw?.data ? Object.values(raw.data) : [];
        for (const section of sections) {
          const list = section?.ru || section?.en || section;
          if (!Array.isArray(list)) continue;
          for (const item of list) {
            const ecode = String(item.ecode || '').replace(/[_-]/g, '').toUpperCase();
            const intro = item.intro || item.title || item.msg;
            if (!ecode || !intro) continue;
            if (!hmsLookup.has(ecode)) hmsLookup.set(ecode, intro);
          }
        }
      } catch {
        // ignore broken locale
      }
    }
    if (hmsLookup.size) break;
  }
  return hmsLookup;
}

function isPhantomPrintError(raw) {
  if (raw === undefined || raw === null || raw === '') return true;
  const n = Number(raw);
  if (Number.isFinite(n) && PHANTOM_PRINT_ERRORS.has(n)) return true;
  if (String(raw).trim() === '0') return true;
  const hex = normalizeHex8(raw);
  return hex === '0500C011' || hex === '00000000';
}

function normalizeHex8(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && n >= 0) return n.toString(16).toUpperCase().padStart(8, '0').slice(-8);
  }
  return s.replace(/[_-\s]/g, '').toUpperCase();
}

function formatCode(hex8) {
  const h = String(hex8 || '').toUpperCase().padStart(8, '0').slice(-8);
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
}

function lookupPrintError(hex8) {
  const table = loadPrintErrorTable();
  const entry = table[hex8];
  if (!entry) return null;
  return {
    code: entry.code || formatCode(hex8),
    text: entry.ru || entry.en || null,
    en: entry.en || null,
  };
}

function lookupHmsText(ecode) {
  const key = String(ecode || '').replace(/[_-]/g, '').toUpperCase();
  if (!key) return null;
  const map = loadHmsLookup();
  if (map.has(key)) return map.get(key);
  if (key.length > 8) {
    const tail = key.slice(-8);
    if (map.has(tail)) return map.get(tail);
  }
  return null;
}

/**
 * @returns {{ code: string, text: string, hex: string } | null}
 */
function decodePrintError(raw) {
  if (isPhantomPrintError(raw)) return null;
  const hex = normalizeHex8(raw);
  if (!hex || hex === '00000000') return null;
  const code = formatCode(hex);
  const fromTable = lookupPrintError(hex);
  if (fromTable?.text) {
    return { code: fromTable.code, text: fromTable.text, hex };
  }
  const fromHms = lookupHmsText(hex) || lookupHmsText(code);
  if (fromHms) return { code, text: fromHms, hex };
  return { code, text: `код печати ${code}`, hex };
}

function hmsParts(attr, code) {
  const a = Number(attr) || 0;
  const c = Number(code) || 0;
  if (!a && !c) return null;
  return {
    p1: Math.floor(a / 0x10000).toString(16).padStart(4, '0').toUpperCase(),
    p2: (a & 0xffff).toString(16).padStart(4, '0').toUpperCase(),
    p3: Math.floor(c / 0x10000).toString(16).padStart(4, '0').toUpperCase(),
    p4: (c & 0xffff).toString(16).padStart(4, '0').toUpperCase(),
  };
}

function decodeHmsEntry(attr, code) {
  const p = hmsParts(attr, code);
  if (!p) return null;
  const dashed = `${p.p1}-${p.p2}-${p.p3}-${p.p4}`;
  const compact = `${p.p1}${p.p2}${p.p3}${p.p4}`;
  const text = lookupHmsText(compact) || lookupHmsText(dashed) || null;
  return {
    code: dashed,
    text: text || `HMS ${dashed}`,
    severity: Number(code) >> 16,
  };
}

function decodeHmsList(hmsList) {
  if (!Array.isArray(hmsList)) return [];
  const out = [];
  for (const h of hmsList) {
    if (!h || h.code == null) continue;
    const d = decodeHmsEntry(h.attr, h.code);
    if (d) out.push(d);
  }
  return out;
}

/** Build error_msg for dashboard from MQTT print blob. */
function formatBambuErrorMsg(printError, gcodeState, prevMsg, hmsList) {
  const parts = [];
  const decoded = decodePrintError(printError);
  if (decoded) parts.push(`${decoded.code}: ${decoded.text}`);
  for (const h of decodeHmsList(hmsList)) {
    if (h.text) parts.push(h.text.startsWith('HMS ') ? h.text : `${h.code}: ${h.text}`);
  }
  if (parts.length) return [...new Set(parts)].join(' · ');
  if (gcodeState !== undefined) return null;
  return prevMsg || null;
}

module.exports = {
  PHANTOM_PRINT_ERRORS,
  isPhantomPrintError,
  decodePrintError,
  decodeHmsEntry,
  decodeHmsList,
  formatBambuErrorMsg,
  normalizeHex8,
  formatCode,
};
