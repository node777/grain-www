// The page: picks a setup, starts the machine in a worker, and connects the
// desktop, the console, grainsh, the agent and the system log to it.
import * as grainsh from './grainsh.js';
import { Agent, MODELS } from './agent.js';

const $ = (id) => document.getElementById(id);
const configs = await (await fetch('configs.json')).json();
const params = new URLSearchParams(location.search);

let worker = null;
let envoy = null;
let shellOpen = false;
let current = null;
let agent = null;
let running = false;

// --- Page settings, kept in this browser (each read and write may fail).

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage may be off */ } },
};
const SIZES = ['1024x768', '1280x800', '1440x900', '1920x1080'];
const settings = Object.assign({ size: '1024x768', scale: 'fit', theme: 'system' }, (() => {
  try { return JSON.parse(store.get('grain.settings') || '{}'); } catch { return {}; }
})());
if (params.get('size') && SIZES.includes(params.get('size'))) settings.size = params.get('size');
if (params.get('scale')) settings.scale = params.get('scale') === 'actual' ? 'actual' : 'fit';
const saveSettings = () => store.set('grain.settings', JSON.stringify(settings));
const screenSize = () => settings.size.split('x').map(Number);

function applySettings() {
  if (settings.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  $('screen-box').classList.toggle('actual', settings.scale === 'actual');
  $('stage').classList.toggle('actual', settings.scale === 'actual');
}

// --- The drawer's tabs

function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
  if (name === 'console') $('tab-console').querySelector('.dot').hidden = true;
  store.set('grain.tab', name);
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
const tabShown = (name) => !$(`${name}-panel`).hidden;

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

// Characters to (key code, shift), from the same table the guest reads keys
// with (grain/lib/virtio_input.zig), so what is typed is what arrives.
const CHARS = new Map();
{
  const plain = '\x00\x1b1234567890-=\x08\tqwertyuiop[]\n\x00asdfghjkl;\'`\x00\\zxcvbnm,./\x00*\x00 ';
  const shifted = '\x00\x1b!@#$%^&*()_+\x08\tQWERTYUIOP{}\n\x00ASDFGHJKL:"~\x00|ZXCVBNM<>?\x00*\x00 ';
  for (let code = plain.length - 1; code > 0; code--) {
    if (plain[code] !== '\x00') CHARS.set(plain[code], [code, false]);
    if (shifted[code] !== '\x00' && !CHARS.has(shifted[code])) CHARS.set(shifted[code], [code, true]);
  }
}

/// Type text into the desktop as key presses (what has no key is skipped).
function typeText(text) {
  if (!worker || !hasScreen(current)) return;
  const keys = [];
  for (const ch of text.replace(/\r\n?/g, '\n')) { const k = CHARS.get(ch); if (k) keys.push(k); }
  if (keys.length) worker.postMessage({ type: 'type', keys });
}

const hasScreen = (c) => (c.devices || []).includes('screen');

// A canvas can hand its drawing to one worker only: each boot gets a new one.
function freshCanvas() {
  const old = $('screen');
  const canvas = old.cloneNode(false);
  old.replaceWith(canvas);
  const send = (m) => { if (worker) worker.postMessage(m); };
  const at = (e) => {
    // The picture is letterboxed inside the element when it is fitted.
    const r = canvas.getBoundingClientRect();
    const [w, h] = screenSize();
    const k = Math.min(r.width / w, r.height / h);
    const ox = (r.width - w * k) / 2, oy = (r.height - h * k) / 2;
    const scale = (v, n) => Math.max(0, Math.min(32767, Math.round((v / n) * 32767)));
    return { type: 'pointer', x: scale(e.clientX - r.left - ox, w * k), y: scale(e.clientY - r.top - oy, h * k) };
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
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') return; // the browser pastes: see below
    const code = KEYS[e.code];
    if (code === undefined) return;
    send({ type: 'key', code, down });
    e.preventDefault();
  };
  canvas.addEventListener('keydown', key(true));
  canvas.addEventListener('keyup', key(false));
  canvas.addEventListener('paste', (e) => { typeText(e.clipboardData.getData('text')); e.preventDefault(); });
  const [w, h] = screenSize();
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

// --- The agent

function chatAdd(cls, text, tag = 'div') {
  const out = $('agent-out');
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  out.appendChild(el);
  if (atBottom) out.scrollTop = out.scrollHeight;
  return el;
}

const short = (text, n = 600) => (text.length > n ? `${text.slice(0, n)}…` : text);

function agentUi() {
  let reply = null; // the agent's text, as it streams
  const scroll = () => { const out = $('agent-out'); if (out.scrollHeight - out.scrollTop - out.clientHeight < 120) out.scrollTop = out.scrollHeight; };
  return {
    text(delta) { if (!reply) reply = chatAdd('msg claude', ''); reply.textContent += delta; scroll(); },
    thinking(text) {
      const d = chatAdd('', undefined, 'details');
      const s = document.createElement('summary');
      s.textContent = 'thinking';
      d.append(s, text);
      reply = null;
    },
    toolCall(name, input) { chatAdd('tool call', `→ ${name} ${JSON.stringify(input)}`); reply = null; },
    toolResult(name, text, error) { chatAdd(`tool result${error ? ' bad' : ''}`, `← ${short(text)}`); },
    turnEnd() { reply = null; agentIdle(); },
    error(message) { reply = null; chatAdd('msg error', message); agentIdle(); },
  };
}

function agentIdle() {
  $('agent-send').textContent = 'Send';
  $('agent-in').disabled = false;
}

function fillAgent() {
  for (const m of MODELS) $('agent-model').add(new Option(m.name, m.id));
  const key = store.get('grain.agent.key');
  if (key) { $('agent-key').value = key; $('agent-remember').checked = true; }
  $('agent-model').value = store.get('grain.agent.model') || MODELS[0].id;
}

$('agent-remember').addEventListener('change', (e) => store.set('grain.agent.key', e.target.checked && $('agent-key').value ? $('agent-key').value : null));
$('agent-key').addEventListener('change', () => { if ($('agent-remember').checked) store.set('grain.agent.key', $('agent-key').value || null); });
$('agent-model').addEventListener('change', (e) => store.set('grain.agent.model', e.target.value));
$('agent-settings').addEventListener('submit', (e) => e.preventDefault());
$('agent-clear').addEventListener('click', () => {
  if (agent) agent.reset();
  $('agent-out').textContent = '';
});
$('agent-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (agent && agent.busy) { agent.stop(); return; }
  const text = $('agent-in').value.trim();
  if (!text) return;
  if (!agent || !shellOpen) { chatAdd('msg error', 'Boot a setup with Envoy first (the dev system).'); return; }
  const key = $('agent-key').value.trim();
  if (!key) { chatAdd('msg error', 'Enter an Anthropic API key first.'); $('agent-key').focus(); return; }
  $('agent-in').value = '';
  chatAdd('msg owner', text);
  $('agent-send').textContent = 'Stop';
  $('agent-in').disabled = true;
  agent.send(text, { key, model: $('agent-model').value });
});
$('agent-in').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('agent-form').requestSubmit(); }
});

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
  const screen = devices.includes('screen');
  $('screen-box').hidden = !screen;
  $('no-screen').hidden = screen;
  $('fullscreen').hidden = !screen;
  $('type-text').hidden = !screen;
  $('tab-console').hidden = !devices.includes('console');
  $('tab-shell').hidden = !devices.includes('envoy');
  $('tab-agent').hidden = !devices.includes('envoy');
  const tab = store.get('grain.tab');
  showTab(tab && !$(`tab-${tab}`).hidden ? tab : devices.includes('console') ? 'console' : 'log');
  $('disk-about').textContent = c.disk ? `“${c.name}” keeps a ${c.disk.mib} MiB disk in this browser.` : 'This setup has no disk.';
  for (const id of ['disk-export', 'disk-import', 'forget']) $(id).disabled = !c.disk;
  $('manifest').textContent = c.manifest ? await (await fetch(c.manifest)).text() : '(this setup has no manifest: it is the kernel and its test program)';
}

function setStatus(text, warn) {
  $('status').textContent = text;
  $('status').className = 'status' + (warn ? ' warn' : '');
}

function setRunning(on) {
  running = on;
  $('stop').disabled = !on;
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
  if (agent) agent.stop();
  agent = new Agent(envoy, agentUi());
  $('agent-out').textContent = '';
  agentIdle();
  shellOpen = (current.devices || []).includes('envoy');
  if (shellOpen) shellPrint("grainsh: talking to Envoy. 'help' lists commands.");
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'output') {
      if (m.stream === 'log') appendLog(m.text);
      else if (m.stream === 'console') {
        append($('console-out'), m.text);
        if (!tabShown('console')) $('tab-console').querySelector('.dot').hidden = false;
      }
      else envoy.receive(m.text);
    } else if (m.type === 'status') {
      const n = m.instructions;
      const count = n >= 1e9 ? `${(n / 1e9).toFixed(2)} billion` : `${(n / 1e6).toFixed(1)} million`;
      setStatus(`${m.state === 'running' ? 'Running' : m.state === 'off' ? 'Powered off' : 'Stopped'} · ${current.name} · ${$('harts').value} harts · ${count} instructions · ${m.mips.toFixed(0)} MIPS`);
      if (m.state !== 'running') setRunning(false);
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
  const [width, height] = screenSize();
  const start = { type: 'start', config: current, harts: Number($('harts').value), width, height };
  if (hasScreen(current)) {
    start.canvas = freshCanvas().transferControlToOffscreen();
    worker.postMessage(start, [start.canvas]);
  } else {
    worker.postMessage(start);
  }
  setRunning(true);
  setStatus(`Booting ${current.name}…`);
  if (!$('tab-console').hidden) { showTab('console'); $('console-in').focus(); }
}

$('setup').addEventListener('submit', (e) => { e.preventDefault(); boot(); });
$('config').addEventListener('change', showConfig);
$('stop').addEventListener('click', () => {
  if (!worker) return;
  worker.postMessage({ type: 'stop' });
  setRunning(false);
});
// --- Disks, in IndexedDB: one record per 4 KiB block written (web/worker.js).

const BLOCK = 4096;
function blocksDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('grain', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('blocks');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const diskRange = (name) => IDBKeyRange.bound([name, 0], [name, Infinity]);
const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });

function needStopped() {
  if (!running) return true;
  alert('Power the machine off first: its disk is in use.');
  return false;
}

$('forget').addEventListener('click', async () => {
  const c = selected();
  if (!c.disk || !needStopped() || !confirm(`Delete the disk of "${c.name}" from this browser? Its identity, passphrase and everything stored go with it.`)) return;
  const db = await blocksDb();
  const tx = db.transaction('blocks', 'readwrite');
  tx.objectStore('blocks').delete(diskRange(c.disk.name));
  await done(tx);
  setStatus(`The disk of ${c.name} is gone: the next boot starts afresh.`);
});

$('disk-export').addEventListener('click', async () => {
  const c = selected();
  if (!c.disk || !needStopped()) return;
  const image = new Uint8Array(c.disk.mib * 1024 * 1024);
  const db = await blocksDb();
  const tx = db.transaction('blocks', 'readonly');
  let n = 0;
  await new Promise((resolve, reject) => {
    const req = tx.objectStore('blocks').openCursor(diskRange(c.disk.name));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      image.set(new Uint8Array(cur.value), cur.key[1] * BLOCK);
      n++;
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([image], { type: 'application/octet-stream' }));
  a.download = `grain-${c.disk.name}.img`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  setStatus(`Exported the disk of ${c.name}: ${n} blocks in use, ${c.disk.mib} MiB in all.`);
});

$('disk-import').addEventListener('click', () => { if (selected().disk && needStopped()) $('disk-file').click(); });
$('disk-file').addEventListener('change', async (e) => {
  const c = selected();
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !c.disk) return;
  const bytes = c.disk.mib * 1024 * 1024;
  if (file.size > bytes || file.size % BLOCK !== 0) { alert(`That image is ${file.size} bytes; this setup's disk is ${bytes} bytes (in 4 KiB blocks).`); return; }
  if (!confirm(`Replace the disk of "${c.name}" with ${file.name}? What is on it now is lost.`)) return;
  const data = new Uint8Array(await file.arrayBuffer());
  const db = await blocksDb();
  const tx = db.transaction('blocks', 'readwrite');
  const st = tx.objectStore('blocks');
  st.delete(diskRange(c.disk.name));
  let n = 0;
  for (let b = 0; b * BLOCK < data.length; b++) {
    const block = data.subarray(b * BLOCK, (b + 1) * BLOCK);
    if (block.some((v) => v !== 0)) { st.put(block.slice().buffer, [c.disk.name, b]); n++; }
  }
  await done(tx);
  setStatus(`Imported ${file.name} as the disk of ${c.name}: ${n} blocks in use.`);
});

// --- Settings, full screen, typing

$('open-settings').addEventListener('click', () => {
  $('set-size').value = settings.size;
  $('set-scale').value = settings.scale;
  $('set-theme').value = settings.theme;
  $('settings').showModal();
});
for (const [id, key] of [['set-size', 'size'], ['set-scale', 'scale'], ['set-theme', 'theme']]) {
  $(id).addEventListener('change', (e) => { settings[key] = e.target.value; saveSettings(); applySettings(); });
}
$('fullscreen').addEventListener('click', async () => {
  try { await $('stage').requestFullscreen(); } catch { return; }
  $('screen').focus();
});
$('type-text').addEventListener('click', () => {
  const text = prompt('Text to type into the desktop (as keystrokes, to the window that has the keyboard):');
  if (text) { typeText(text); $('screen').focus(); }
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

applySettings();
fillAgent();
fillConfigs();
if (params.get('autostart') === '1') boot();
