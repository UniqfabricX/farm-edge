'use strict';

/**
 * Проверка работоспособности Farm Edge без облака и без живого farm-bff.
 * npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-edge-test-'));
process.env.FARM_EDGE_DATA = dataDir;
process.env.FARM_BFF_URL = 'http://127.0.0.1:3001';

const {
  handleRpc,
  isAllowedPath,
  isPrivateIpv4,
  assertLocalBff,
  requestIdFromMsg,
  mapBoardToPrinters,
  mapPlateToStatus,
  bffTimeoutFor,
  moonrakerIpFor,
  lanHint,
} = require('../rpc-handler');
const {
  VERSION,
  cloudHttpBase,
  farmBffUrl,
  saveCredentials,
  loadCredentials,
  defaultDataDir,
} = require('../config');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('config: каталог данных берётся из FARM_EDGE_DATA', () => {
  assert.equal(defaultDataDir(), dataDir);
  assert.equal(farmBffUrl(), 'http://127.0.0.1:3001');
  assert.equal(cloudHttpBase('https://farm.5dsap.ru/'), 'https://farm.5dsap.ru');
  assert.equal(cloudHttpBase(), 'https://farm.5dsap.ru');
  assert.match(String(VERSION), /^\d+\.\d+\.\d+/);
});

test('config: credentials сохраняются и читаются обратно', () => {
  const creds = {
    agentId: 'ea_test',
    agentSecret: 'secret',
    cloudWsUrl: 'wss://farm.5dsap.ru/ws/edge',
  };
  saveCredentials(dataDir, creds);
  assert.deepEqual(loadCredentials(dataDir), creds);
  assert.equal(loadCredentials(path.join(dataDir, 'missing')), null);
});

test('CLI status без привязки отвечает paired:false', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-edge-status-'));
  const result = spawnSync(process.execPath, ['index.js', 'status', '--data', empty], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  fs.rmSync(empty, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.paired, false);
  assert.equal(body.dataDir, empty);
});

test('CLI неизвестная команда завершается кодом 2', () => {
  const result = spawnSync(process.execPath, ['index.js', 'no-such-command'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /pair \| run \| status/);
});

test('allowlist: рабочие пути открыты, управление сервером закрыто', () => {
  for (const p of [
    '/api/printers',
    '/api/printers/a1/files',
    '/api/board',
    '/api/warehouse/parts',
    '/api/scan',
    '/api/scan/probe',
    '/api/upload/printers/x/start',
    '/api/maintenance/logs',
  ]) {
    assert.equal(isAllowedPath(p), true, p);
  }
  for (const p of [
    '',
    '/api/server/restart',
    '/api/server/env',
    '/api/logs',
    '/api/logs/tail',
    '/api/../etc/passwd',
    '/api/printers/../server/restart',
    'https://evil.example/api/printers',
  ]) {
    assert.equal(isAllowedPath(p), false, p);
  }
});

test('SSRF: BFF только localhost или частная сеть', () => {
  assert.doesNotThrow(() => assertLocalBff('http://127.0.0.1:3001'));
  assert.doesNotThrow(() => assertLocalBff('http://localhost:3001'));
  assert.doesNotThrow(() => assertLocalBff('http://192.168.31.118:8080'));
  assert.doesNotThrow(() => assertLocalBff('http://10.0.0.4:3001'));
  assert.throws(() => assertLocalBff('https://example.com'), (err) => err.code === 'BFF_SSRF' && err.status === 403);
  assert.throws(() => assertLocalBff('http://8.8.8.8'), (err) => err.code === 'BFF_SSRF');
  assert.throws(() => assertLocalBff('file:///etc/passwd'), (err) => err.code === 'BFF_SSRF');
  assert.throws(() => assertLocalBff('not-a-url'), (err) => err.code === 'BFF_URL');
});

test('RPC на запрещённый путь отвечает 403 EDGE_DENY', async () => {
  const denied = await handleRpc({ method: 'POST', path: '/api/server/restart' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'EDGE_DENY');
});

test('частные IPv4 и адрес Moonraker из id принтера', () => {
  assert.equal(isPrivateIpv4('192.168.31.220'), true);
  assert.equal(isPrivateIpv4('10.1.2.3'), true);
  assert.equal(isPrivateIpv4('172.16.0.1'), true);
  assert.equal(isPrivateIpv4('8.8.8.8'), false);
  assert.equal(isPrivateIpv4('172.32.0.1'), false);
  assert.equal(isPrivateIpv4('999.1.1.1'), false);
  assert.equal(isPrivateIpv4('not-an-ip'), false);
  assert.equal(moonrakerIpFor('klipper-192.168.31.10'), '192.168.31.10');
  assert.equal(moonrakerIpFor('klipper-192-168-31-10'), '192.168.31.10');
  assert.equal(moonrakerIpFor('d16-8.8.8.8'), null);
  assert.equal(moonrakerIpFor('d16-220'), null);
});

test('сканер не зондирует публичный IP', async () => {
  const r = await handleRpc({
    method: 'POST',
    path: '/api/scan/probe',
    body: { ip: '8.8.8.8' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'BAD_IP');
});

test('статусы платы: 100% и пауза не становятся ошибкой', () => {
  assert.equal(mapPlateToStatus({ plate: 'printing' }), 'printing');
  assert.equal(mapPlateToStatus({ plate: 'paused' }), 'paused');
  assert.equal(mapPlateToStatus({ progress: 100, plate: 'error' }), 'completed');
  assert.equal(mapPlateToStatus({ state: 'prepare' }), 'printing');
  assert.equal(mapPlateToStatus({ online: false }), 'offline');

  const rows = mapBoardToPrinters({
    printers: [
      {
        printerId: 'a1',
        printerName: 'A1',
        progress: 100,
        plate: 'error',
        errorMessage: 'что-то было',
        cameraUrl: 'rtsps://bblp:code@192.168.31.20/streaming/live',
        hasCameraHint: true,
      },
      {
        printerId: 'p1',
        plate: 'paused',
        errorMessage: 'Печать на паузе',
        cameraUrl: 'http://192.168.31.21:8080/video',
        cameraPort: 8080,
      },
    ],
  });
  assert.equal(rows[0].status, 'completed');
  assert.equal(rows[0].error_message, null);
  assert.equal(rows[0].plate, 'print_complete');
  assert.equal(rows[0].cameraUrl, null);
  assert.equal(rows[0].has_camera, true);
  assert.equal(rows[1].status, 'paused');
  assert.equal(rows[1].error_message, null);
  assert.equal(rows[1].cameraUrl, 'http://192.168.31.21:8080/video');
});

test('таймауты BFF и сквозной request-id', () => {
  assert.equal(bffTimeoutFor('/api/maintenance/logs', 'POST'), 300_000);
  assert.equal(bffTimeoutFor('/api/upload/x', 'POST'), 180_000);
  assert.equal(bffTimeoutFor('/api/otm/plan', 'GET'), 90_000);
  assert.equal(bffTimeoutFor('/api/board', 'GET'), 60_000);
  assert.equal(bffTimeoutFor('/api/printers', 'GET'), 120_000);
  assert.equal(bffTimeoutFor('/api/printers/x', 'GET'), 45_000);
  assert.equal(requestIdFromMsg({ requestId: 'req-abc_1' }), 'req-abc_1');
  assert.equal(requestIdFromMsg({ headers: { 'X-Request-Id': 'hdr-id-99' } }), 'hdr-id-99');
  assert.equal(requestIdFromMsg({ requestId: 'bad id' }), '');
});

test('печать без имени файла не уходит на принтер', async () => {
  const r = await handleRpc({ method: 'POST', path: '/api/printers/a1/print-file', body: {} });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'NO_FILENAME');
});

test('автономное добавление принтера пишет printers.json', async () => {
  process.env.FARM_BFF_URL = 'http://127.0.0.1:1';
  const r = await handleRpc({
    method: 'POST',
    path: '/api/scan/add',
    body: {
      device: { ip: '192.168.31.55', type: 'klipper', name: 'Turtle' },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.printer.ip, '192.168.31.55');
  assert.equal(r.body.printer.source, 'edge-local');
  assert.equal(moonrakerIpFor(r.body.printer.id), '192.168.31.55');

  const list = await handleRpc({ method: 'GET', path: '/api/printers' });
  process.env.FARM_BFF_URL = 'http://127.0.0.1:3001';
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.ok(list.body.some((p) => p.ip === '192.168.31.55'));
});

test('RPC /api/printers проецирует живую плату BFF', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/board') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        printers: [
          {
            printerId: 'bambu-a1',
            printerName: 'A1-01',
            printerType: 'Bambu A1',
            ip: '192.168.31.40',
            state: 'printing',
            plate: 'printing',
            progress: 42,
            nozzleTemp: 220,
            bedTemp: 60,
            filename: 'holder.gcode',
          },
        ],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.FARM_BFF_URL = `http://127.0.0.1:${port}`;
  try {
    const r = await handleRpc({ method: 'GET', path: '/api/printers' });
    assert.equal(r.status, 200);
    assert.equal(r.body[0].id, 'bambu-a1');
    assert.equal(r.body[0].status, 'printing');
    assert.equal(r.body[0].progress, 42);
    assert.equal(r.body[0].job_name, 'holder.gcode');
    assert.equal(r.body[0].source, 'edge-bff');
    assert.equal(r.body[0].nozzle_temp, 220);
  } finally {
    process.env.FARM_BFF_URL = 'http://127.0.0.1:3001';
    await new Promise((resolve) => server.close(resolve));
  }
});

test('lanHint возвращает только внешние IPv4', () => {
  const hint = lanHint();
  assert.ok(Array.isArray(hint));
  for (const row of hint) {
    assert.ok(row.name);
    assert.ok(isPrivateIpv4(row.address) || /^\d{1,3}(\.\d{1,3}){3}$/.test(row.address));
    assert.notEqual(row.address, '127.0.0.1');
  }
});
