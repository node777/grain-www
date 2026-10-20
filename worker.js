// The machine, in a worker: runs grain-emu (WebAssembly) a slice at a time so
// the page stays responsive, and keeps the disk in IndexedDB.
//
// Messages in:  {type: 'start', config, harts, canvas?}  {type: 'input', port, text}
//               {type: 'key', code, down}  {type: 'pointer', x, y}  {type: 'button', code, down}
//               {type: 'stop'}
// Messages out: {type: 'output', stream: 'log'|'console'|'envoy', text}
//               {type: 'status', state, instructions, mips}
//               {type: 'exit', code}  {type: 'error', message}
'use strict';

const enc = new TextEncoder();
const dec = new TextDecoder();
const BLOCK = 4096;

let x = null; // the module's exports
let timer = null;
let stopped = false;
let config = null;
let db = null;
let flushed = false;
const out = { log: '', console: '', envoy: '' };
const pending = [[], []]; // input not yet taken by the guest, per console
let busy = 0; // ms spent running the machine
let lastStatus = 0;
let canvas = null; // the desktop: an OffscreenCanvas from the page, when the setup has a screen
let dirty = null; // the part of the screen the guest flushed since the last draw

const view = (ptr, len) => new Uint8Array(x.memory.buffer, ptr, len);

const imports = {
  env: {
    host_console: (p, n) => { out.log += dec.decode(view(p, n)); },
    host_port: (port, p, n) => {
      const text = dec.decode(view(p, n));
      if (port === 0) out.console += text; else out.envoy += text;
    },
    host_entropy: (p, n) => {
      for (let off = 0; off < n; off += 65536) crypto.getRandomValues(view(p + off, Math.min(65536, n - off)));
    },
    host_now_ms: () => performance.now(),
    host_disk_flushed: () => { flushed = true; },
    host_display: (x0, y0, w, h) => {
      const r = { x0, y0, x1: x0 + w, y1: y0 + h };
      dirty = dirty ? { x0: Math.min(dirty.x0, r.x0), y0: Math.min(dirty.y0, r.y0), x1: Math.max(dirty.x1, r.x1), y1: Math.max(dirty.y1, r.y1) } : r;
    },
  },
};

// --- The disk, in IndexedDB: one record per 4 KiB block that was ever written.

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('grain', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('blocks');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const range = (disk) => IDBKeyRange.bound([disk, 0], [disk, Infinity]);

function loadDisk(name, ptr) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blocks', 'readonly');
    const req = tx.objectStore('blocks').openCursor(range(name));
    let n = 0;
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(n);
      view(ptr + c.key[1] * BLOCK, BLOCK).set(new Uint8Array(c.value));
      n++;
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

function saveDirty() {
  flushed = false;
  const ptr = x.grain_disk_ptr();
  const tx = db.transaction('blocks', 'readwrite');
  const store = tx.objectStore('blocks');
  for (let b = x.grain_dirty_next(0); b >= 0; b = x.grain_dirty_next(b + 1)) {
    store.put(view(ptr + b * BLOCK, BLOCK).slice().buffer, [config.disk.name, b]);
  }
}

// --- Running

function post(type, fields) { postMessage(Object.assign({ type }, fields)); }

function flushOutput() {
  for (const stream of ['log', 'console', 'envoy']) {
    if (out[stream]) { post('output', { stream, text: out[stream] }); out[stream] = ''; }
  }
}

// Copy what the guest flushed to the canvas (the screen is RGBA in the module's memory).
function draw() {
  if (!dirty || !canvas) return;
  const w = x.grain_screen_width();
  const h = x.grain_screen_height();
  const ptr = x.grain_screen();
  if (!ptr || w === 0) return;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = { x0: 0, y0: 0, x1: w, y1: h }; }
  const img = new ImageData(new Uint8ClampedArray(x.memory.buffer, ptr, w * h * 4), w, h);
  const r = dirty;
  dirty = null;
  canvas.getContext('2d').putImageData(img, 0, 0, r.x0, r.y0, Math.min(r.x1, w) - r.x0, Math.min(r.y1, h) - r.y0);
}

function feedInput() {
  for (const port of [0, 1]) {
    const q = pending[port];
    while (q.length > 0) {
      const bytes = q[0];
      const p = x.grain_alloc(bytes.length);
      view(p, bytes.length).set(bytes);
      const took = x.grain_input(port, p, bytes.length);
      x.grain_free(p, bytes.length);
      if (took === bytes.length) q.shift();
      else { q[0] = bytes.slice(took); break; }
    }
  }
}

function status(state) {
  const n = x.grain_instructions();
  post('status', { state, instructions: n, mips: busy > 0 ? n / busy / 1000 : 0 });
}

function schedule(ms) {
  if (stopped) return;
  timer = setTimeout(loop, ms);
}

function loop() {
  timer = null;
  const t0 = performance.now();
  let r;
  // About 30 ms of work per turn, then let messages (input) in.
  do { r = x.grain_run(2000000); } while (r === 3 && performance.now() - t0 < 30);
  busy += performance.now() - t0;
  flushOutput();
  draw();
  feedInput();
  if (flushed && config.disk) saveDirty();
  if (r === 0) {
    if (config.disk) saveDirty();
    status('off');
    post('exit', { code: x.grain_exit_code() });
    stopped = true;
    return;
  }
  if (performance.now() - lastStatus > 500) { status('running'); lastStatus = performance.now(); }
  if (r === 2) schedule(Math.min(Math.max(x.grain_wake_ms(), 0), 50));
  else if (r === 1) schedule(50);
  else schedule(0);
}

function kick() {
  if (timer !== null && !stopped) { clearTimeout(timer); schedule(0); }
}

async function start(msg) {
  config = msg.config;
  const [wasm, image] = await Promise.all([
    fetch('grain-emu.wasm').then((r) => r.arrayBuffer()),
    fetch(config.image).then((r) => { if (!r.ok) throw new Error(`${config.image}: ${r.status}`); return r.arrayBuffer(); }),
  ]);
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  x = instance.exports;
  const devices = config.devices || [];
  let mask = 0;
  if (devices.includes('rng')) mask |= 1;
  if (devices.includes('disk')) mask |= 2;
  if (devices.includes('console')) mask |= 4;
  if (devices.includes('envoy')) mask |= 8;
  if (devices.includes('screen')) mask |= 16;
  if (devices.includes('keyboard')) mask |= 32;
  if (devices.includes('tablet')) mask |= 64;
  canvas = msg.canvas || null;
  if (config.disk) {
    db = db || await openDb();
    const ptr = x.grain_disk(config.disk.mib * 1024 * 1024);
    if (!ptr) throw new Error('no memory for the disk');
    const blocks = await loadDisk(config.disk.name, ptr);
    post('output', { stream: 'log', text: `[page] disk "${config.disk.name}": ${blocks ? `${blocks} blocks from this browser's storage` : 'new and empty'}\n` });
  }
  const bytes = new Uint8Array(image);
  const p = x.grain_alloc(bytes.length);
  view(p, bytes.length).set(bytes);
  const rc = x.grain_start(p, bytes.length, msg.harts || config.harts, config.ram_mib, mask, true);
  if (rc !== 0) throw new Error(`the machine did not start (${rc})`);
  status('running');
  schedule(0);
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') {
    start(m).catch((err) => post('error', { message: String(err.message || err) }));
  } else if (m.type === 'input' && x) {
    pending[m.port].push(enc.encode(m.text));
    feedInput();
    kick();
  } else if (m.type === 'key' && x) {
    x.grain_key(m.code, m.down);
    kick();
  } else if (m.type === 'pointer' && x) {
    x.grain_pointer(m.x, m.y);
    kick();
  } else if (m.type === 'button' && x) {
    x.grain_button(m.code, m.down);
    kick();
  } else if (m.type === 'stop') {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    if (x) { flushOutput(); if (config.disk) saveDirty(); status('stopped'); }
  }
};
