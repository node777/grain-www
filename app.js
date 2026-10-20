// The page: picks a setup, starts the machine in a worker, and connects the
// console, grainsh and the system log to it.
import * as grainsh from './grainsh.js';

const $ = (id) => document.getElementById(id);
const configs = await (await fetch('configs.json')).json();
const params = new URLSearchParams(location.search);

let worker = null;
let envoy = null;
let shellOpen = false;
let current = null;

// --- BLAKE3, for checking Envoy's audit chain: the same module, its own instance.

let blake3 = null;
WebAssembly.instantiateStreaming(fetch('grain-emu.wasm'), {
  env: { host_console() {}, host_port() {}, host_entropy() {}, host_now_ms: () => 0, host_disk_flushed() {}, host_display() {} },
}).then(({ instance }) => {
  const x = instance.exports;
  blake3 = (data) => {
    const p = x.grain_alloc(data.length + 32);
    new Uint8Array(x.memory.buffer, p, data.length).set(data);
    x.grain_blake3(p, data.length, p + data.length);
    const h = new Uint8Array(x.memory.buffer, p + data.length, 32).slice();
    x.grain_free(p, data.length + 32);
    return h;
  };
});

// --- Output

const MAX_LINES = 4000;

function append(pre, text, cls) {
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  pre.appendChild(span);
  while (pre.childNodes.length > MAX_LINES) pre.removeChild(pre.firstChild);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

let logRest = '';
function appendLog(text) {
  const pre = $('log-out');
  const lines = (logRest + text).split('\n');
  logRest = lines.pop();
  const frag = document.createDocumentFragment();
  const recordsOnly = $('log-records').checked;
  for (const line of lines) {
    const m = /^(@caravan|@grain|@aurora) (\S+)(.*)$/.exec(line);
    if (!m && recordsOnly) continue;
    const div = document.createElement('div');
    if (m) {
      const src = document.createElement('span');
      src.className = 'rec';
      src.textContent = m[1] + ' ';
      const ev = document.createElement('span');
      ev.className = 'ev';
      ev.textContent = m[2];
      div.append(src, ev, m[3]);
    } else {
      div.textContent = line;
      if (line.startsWith('[page]')) div.className = 'typed';
    }
    frag.appendChild(div);
  }
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.appendChild(frag);
  while (pre.childNodes.length > MAX_LINES) pre.removeChild(pre.firstChild);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

const shellPrint = (text) => append($('shell-out'), text + '\n');

// --- The desktop: the canvas is drawn by the worker; keys and the pointer go to it.

// KeyboardEvent.code to Linux input key codes (what virtio-input carries).
const KEYS = { Escape: 1, Minus: 12, Equal: 13, Backspace: 14, Tab: 15, BracketLeft: 26, BracketRight: 27, Enter: 28,
  ControlLeft: 29, Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43, Comma: 51, Period: 52, Slash: 53,
  ShiftRight: 54, AltLeft: 56, Space: 57, CapsLock: 58, F11: 87, F12: 88, NumpadEnter: 96, ControlRight: 97, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109,
  Insert: 110, Delete: 111, MetaLeft: 125, MetaRight: 126 };
'1234567890'.split('').forEach((d, i) => { KEYS[`Digit${d}`] = 2 + i; });
for (const [row, first] of [['QWERTYUIOP', 16], ['ASDFGHJKL', 30], ['ZXCVBNM', 44]]) row.split('').forEach((k, i) => { KEYS[`Key${k}`] = first + i; });
for (let i = 1; i <= 10; i++) KEYS[`F${i}`] = 58 + i;
const BUTTONS = [0x110, 0x112, 0x111]; // left, middle, right

const hasScreen = (c) => (c.devices || []).includes('screen');

// A canvas can hand its drawing to one worker only: each boot gets a new one.
function freshCanvas() {
  const old = $('screen');
  const canvas = old.cloneNode(false);
  old.replaceWith(canvas);
  const send = (m) => { if (worker) worker.postMessage(m); };
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    const scale = (v, n) => Math.max(0, Math.min(32767, Math.round((v / n) * 32767)));
    return { type: 'pointer', x: scale(e.clientX - r.left, r.width), y: scale(e.clientY - r.top, r.height) };
  };
  // At most one move per frame reaches the machine.
  let moved = null;
  canvas.addEventListener('pointermove', (e) => {
    if (!moved) requestAnimationFrame(() => { if (moved) send(moved); moved = null; });
    moved = at(e);
  });
  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    moved = null;
    send(at(e)); // where the press is, before the press
    if (BUTTONS[e.button] !== undefined) send({ type: 'button', code: BUTTONS[e.button], down: true });
    e.preventDefault();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (BUTTONS[e.button] !== undefined) send({ type: 'button', code: BUTTONS[e.button], down: false });
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  const key = (down) => (e) => {
    const code = KEYS[e.code];
    if (code === undefined) return;
    send({ type: 'key', code, down });
    e.preventDefault();
  };
  canvas.addEventListener('keydown', key(true));
  canvas.addEventListener('keyup', key(false));
  return canvas;
}

// --- Setup

function fillConfigs() {
  const sel = $('config');
  for (const c of configs) sel.add(new Option(c.name, c.id));
  sel.value = params.get('config') || configs[0].id;
  if (params.get('harts')) $('harts').value = params.get('harts');
  showConfig();
}

function selected() {
  return configs.find((c) => c.id === $('config').value);
}

async function showConfig() {
  const c = selected();
  $('about').textContent = c.about;
  $('harts').value = String(params.get('harts') || c.harts);
  const devices = c.devices || [];
  $('desktop-panel').hidden = !devices.includes('screen');
  $('console-panel').hidden = !devices.includes('console');
  $('shell-panel').hidden = !devices.includes('envoy');
  $('forget').hidden = !c.disk;
  $('manifest').textContent = c.manifest ? await (await fetch(c.manifest)).text() : '(this setup has no manifest: it is the kernel and its test program)';
}

function setStatus(text, warn) {
  $('status').textContent = text;
  $('status').className = 'status' + (warn ? ' warn' : '');
}

function setRunning(on) {
  $('stop').disabled = !on;
  $('forget').disabled = on;
  $('config').disabled = on;
  $('harts').disabled = on;
  $('boot').textContent = on ? 'Reboot' : 'Boot';
}

function boot() {
  if (worker) worker.terminate();
  current = selected();
  for (const id of ['console-out', 'shell-out', 'log-out']) $(id).textContent = '';
  logRest = '';
  worker = new Worker('worker.js');
  envoy = new grainsh.Envoy((text) => worker.postMessage({ type: 'input', port: 1, text }));
  shellOpen = (current.devices || []).includes('envoy');
  if (shellOpen) shellPrint("grainsh: talking to Envoy. 'help' lists commands.");
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'output') {
      if (m.stream === 'log') appendLog(m.text);
      else if (m.stream === 'console') append($('console-out'), m.text);
      else envoy.receive(m.text);
    } else if (m.type === 'status') {
      const n = m.instructions;
      const count = n >= 1e9 ? `${(n / 1e9).toFixed(2)} billion` : `${(n / 1e6).toFixed(1)} million`;
      setStatus(`${m.state === 'running' ? 'Running' : m.state === 'off' ? 'Powered off' : 'Stopped'} · ${current.name} · ${$('harts').value} harts · ${count} instructions · ${m.mips.toFixed(0)} MIPS`);
    } else if (m.type === 'exit') {
      appendLog(`\n[page] the machine powered off (exit code ${m.code})\n`);
      setRunning(false);
      document.body.dataset.exit = String(m.code);
    } else if (m.type === 'error') {
      setStatus(`Could not boot: ${m.message}`, true);
      setRunning(false);
    }
  };
  document.body.dataset.exit = '';
  const start = { type: 'start', config: current, harts: Number($('harts').value) };
  if (hasScreen(current)) {
    start.canvas = freshCanvas().transferControlToOffscreen();
    worker.postMessage(start, [start.canvas]);
  } else {
    worker.postMessage(start);
  }
  setRunning(true);
  setStatus(`Booting ${current.name}…`);
  ($('console-panel').hidden ? $('shell-in') : $('console-in')).focus();
}

$('setup').addEventListener('submit', (e) => { e.preventDefault(); boot(); });
$('config').addEventListener('change', showConfig);
$('stop').addEventListener('click', () => {
  if (!worker) return;
  worker.postMessage({ type: 'stop' });
  setRunning(false);
});
$('forget').addEventListener('click', () => {
  const c = selected();
  if (!c.disk || !confirm(`Delete the disk of "${c.name}" from this browser? Its identity, passphrase and everything stored go with it.`)) return;
  const req = indexedDB.open('grain', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('blocks');
  req.onsuccess = () => {
    const tx = req.result.transaction('blocks', 'readwrite');
    tx.objectStore('blocks').delete(IDBKeyRange.bound([c.disk.name, 0], [c.disk.name, Infinity]));
    tx.oncomplete = () => setStatus(`The disk of ${c.name} is gone: the next boot starts afresh.`);
  };
});

// The console: hidden typing by default (the passphrase is typed here).
$('console-show').addEventListener('change', (e) => { $('console-in').type = e.target.checked ? 'text' : 'password'; });
$('console-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!worker) return;
  const text = $('console-in').value;
  worker.postMessage({ type: 'input', port: 0, text: text + '\n' });
  append($('console-out'), $('console-in').type === 'password' ? '(typed, not shown)\n' : `${text}\n`, 'typed');
  $('console-in').value = '';
});

// grainsh: one command at a time, with history.
const history = [];
let historyAt = 0;
$('shell-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('shell-in');
  const line = input.value;
  if (!line.trim() || !worker || !shellOpen) return;
  history.push(line);
  historyAt = history.length;
  input.value = '';
  shellPrint(`grain> ${line}`);
  input.disabled = true;
  try {
    shellOpen = await grainsh.run(envoy, line, shellPrint, blake3);
  } finally {
    input.disabled = false;
    input.focus();
  }
});
$('shell-in').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && historyAt > 0) { historyAt--; e.target.value = history[historyAt]; e.preventDefault(); }
  if (e.key === 'ArrowDown' && historyAt < history.length) { historyAt++; e.target.value = history[historyAt] || ''; e.preventDefault(); }
});

fillConfigs();
if (params.get('autostart') === '1') boot();
