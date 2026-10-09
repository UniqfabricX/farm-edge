'use strict';
/**
 * ELEGOO SDCP v3.0.0 — Smart Device Control Protocol
 *
 * Поддерживается Centauri Carbon и другими FDM-принтерами Elegoo.
 *
 * Discovery: UDP unicast "M99999" → порт 3000 → JSON { Data: { Name, MainboardID, ... } }
 * Control:   WebSocket ws://{ip}:3030/websocket с payload вида
 *            { Id, Data: { Cmd, Data, RequestID, MainboardID, TimeStamp, From }, Topic }
 *
 * Принимаемые топики: sdcp/status/{id}, sdcp/attributes/{id}, sdcp/response/{id}, sdcp/notice/{id}, sdcp/error/{id}
 */

const dgram  = require('dgram');
const crypto = require('crypto');

const UDP_PORT = 3000;
const WS_PORT  = 3030;

function reqId() { return crypto.randomBytes(16).toString('hex'); }

// UDP unicast discover: пошлём "M99999" на ip:3000 и ждём JSON-ответ.
function discover(ip, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch {}
      err ? reject(err) : resolve(val);
    };
    sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== ip) return;
      try {
        const j = JSON.parse(msg.toString());
        // SDCP может отдать { Data: {...} } или сразу flat — нормализуем
        const data = j.Data || j;
        finish(null, {
          raw: j,
          name:          data.Name || data.MachineName,
          machine_name:  data.MachineName,
          brand:         data.BrandName,
          ip:            data.MainboardIP || ip,
          mainboard_id:  data.MainboardID,
          protocol:      data.ProtocolVersion || j.ProtocolVersion,
          firmware:      data.FirmwareVersion,
        });
      } catch (e) {
        finish(new Error('Bad SDCP discovery response: ' + e.message));
      }
    });
    sock.on('error', e => finish(e));
    sock.bind(0, () => {
      sock.send('M99999', UDP_PORT, ip, err => { if (err) finish(err); });
    });
    setTimeout(() => finish(new Error(`Нет ответа от ${ip}:${UDP_PORT}`)), timeoutMs);
  });
}

// Формирует SDCP-команду для WebSocket.
function buildCommand(mainboardId, cmd, data = {}) {
  return JSON.stringify({
    Id: '',
    Data: {
      Cmd: cmd,
      Data: data,
      RequestID:   reqId(),
      MainboardID: mainboardId,
      TimeStamp:   Math.floor(Date.now() / 1000),
      From:        0,
    },
    Topic: `sdcp/request/${mainboardId}`,
  });
}

const CMD = {
  STATUS:     0,   // Полный статус (Status block)
  ATTRIBUTES: 1,   // Атрибуты/capabilities (Attributes block)
  START:      128, // Start print
  PAUSE:      129, // Pause
  STOP:       130, // Stop
  CONTINUE:   131, // Resume
};

module.exports = { discover, buildCommand, CMD, WS_PORT };
