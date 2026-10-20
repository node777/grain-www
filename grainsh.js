// grainsh in the page: the structured shell of tools/envoy.py, over Envoy's
// JSON-lines protocol on the system's second console. Same commands, same
// output.
'use strict';

export class EnvoyError extends Error {
  constructor(response) {
    super(`${response.error}: ${response.detail || ''}`);
    this.response = response;
  }
}

/// A connection to Envoy: requests go out as JSON lines; answers come back
/// in order, matched by id.
export class Envoy {
  constructor(send) {
    this.send = send;
    this.buf = '';
    this.nextId = 1;
    this.waiting = new Map();
  }

  /// Text from the console.
  receive(text) {
    this.buf += text;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = this.waiting.get(msg.id);
      if (w) { this.waiting.delete(msg.id); w(msg); }
    }
  }

  request(verb, fields = {}) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.send(JSON.stringify(Object.assign({ id, verb }, fields)) + '\n');
    });
  }

  async ok(verb, fields) {
    const r = await this.request(verb, fields);
    if (!r.ok) throw new EnvoyError(r);
    return r.result;
  }
}

/// Split like a POSIX shell: quotes group words.
export function split(line) {
  const words = [];
  let cur = '';
  let quote = null;
  let any = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) { words.push(cur); cur = ''; any = false; }
    } else {
      cur += ch;
    }
  }
  if (quote) throw new Error('unclosed quote');
  if (cur || any) words.push(cur);
  return words;
}

function value(text) {
  if (text === 'true' || text === 'false') return text === 'true';
  if (/^-?(0x[0-9a-f]+|0o[0-7]+|0b[01]+|\d+)$/i.test(text)) {
    const neg = text.startsWith('-');
    const n = Number(neg ? text.slice(1) : text);
    if (Number.isFinite(n)) return neg ? -n : n;
  }
  return text;
}

function parseCall(words) {
  let [cap, method = ''] = words[0].split(/\.(.*)/s);
  let rest = words.slice(1);
  if (!method && rest.length && !rest[0].includes('=')) { method = rest[0]; rest = rest.slice(1); }
  const args = {};
  for (const w of rest) {
    const i = w.indexOf('=');
    args[i < 0 ? w : w.slice(0, i)] = value(i < 0 ? '' : w.slice(i + 1));
  }
  return { cap, method, args };
}

function table(rows, cols) {
  const cell = (r, c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]));
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r, c).length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(cols), ...rows.map((r) => line(cols.map((c) => cell(r, c))))].join('\n');
}

function limit(lease, key) {
  if (!lease) return '';
  return lease[key] === null || lease[key] === undefined ? '-' : lease[key];
}

export const HELP = `commands:
  hello                          system, closure hash, verbs
  caps                           what you hold (discover)
  describe <cap>                 methods, parameters, effects, docs
  call <cap>.<method> k=v ...    one call (or: call <cap> <method> k=v ...)
  plan <step> ; <step> ...       dry run (step = cap.method k=v ...)
  apply <step> ; <step> ...      all-or-nothing
  undo <action>                  reverse an action
  ask <cap>                      request an askable capability
  log                            audit log (hash chain checked)
  bye                            end the session`;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/// Recompute Envoy's audit hashes (BLAKE3 of the previous hash and the
/// entry), as tools/envoy.py does. Returns the index of the first bad
/// entry, or -1.
function verifyChain(actions, blake3) {
  let prev = new Uint8Array(32);
  const enc = new TextEncoder();
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const text = enc.encode(`${a.seq}|${a.verb}|${a.cap}|${a.method}|${a.outcome}|${a.undo_of || 0}`);
    const data = new Uint8Array(32 + text.length);
    data.set(prev);
    data.set(text, 32);
    const h = blake3(data);
    if (hex(h) !== a.hash) return i;
    prev = h;
  }
  return -1;
}

/// Run one command line; `print` takes output text. Returns false after `bye`.
export async function run(envoy, line, print, blake3) {
  let words;
  try { words = split(line.trim()); } catch (e) { print(`usage error: ${e.message}`); return true; }
  if (!words.length) return true;
  const [cmd] = words;
  try {
    if (cmd === 'help') {
      print(HELP);
    } else if (cmd === 'hello') {
      print(JSON.stringify(await envoy.ok('hello'), null, 2));
    } else if (cmd === 'caps') {
      const caps = (await envoy.ok('discover')).capabilities;
      print(table(caps.map((c) => ({
        name: c.name, protocol: c.protocol, granted: c.granted ? 'True' : 'False', askable: c.askable ? 'True' : 'False',
        uses_left: limit(c.lease, 'uses_left'), expires_in_ms: limit(c.lease, 'expires_in_ms'),
      })), ['name', 'protocol', 'granted', 'askable', 'uses_left', 'expires_in_ms']));
    } else if (cmd === 'describe') {
      if (!words[1]) throw new Error('describe <cap>');
      const d = (await envoy.ok('describe', { cap: words[1] })).descriptor;
      const lines = [`${d.protocol}: ${d.doc}`];
      for (const m of d.methods) {
        const ps = m.params.map((p) => `${p.name}: ${p.type}`).join(', ');
        const rs = m.results.map((p) => `${p.name}: ${p.type}`).join(', ');
        lines.push(`  ${m.name}(${ps}) -> (${rs})  [${m.effect}${m.undo ? `, undo=${m.undo}` : ''}]  ${m.doc}`);
      }
      print(lines.join('\n'));
    } else if (cmd === 'call') {
      if (!words[1]) throw new Error('call <cap>.<method> k=v ...');
      const step = parseCall(words.slice(1));
      print(JSON.stringify(await envoy.ok('call', { cap: step.cap, method: step.method, args: step.args })));
    } else if (cmd === 'plan' || cmd === 'apply') {
      const steps = words.slice(1).join(' ').split(';').map((part) => parseCall(split(part)));
      const fields = cmd === 'apply' ? { steps, allow_partial: false } : { steps };
      print(JSON.stringify(await envoy.ok(cmd, fields), null, 2));
    } else if (cmd === 'undo') {
      print(JSON.stringify(await envoy.ok('undo', { action: Number(words[1]) })));
    } else if (cmd === 'ask') {
      if (!words[1]) throw new Error('ask <cap> [reason]');
      const fields = { cap: words[1], reason: words.slice(2).join(' ') };
      let r = await envoy.ok('ask', fields);
      if (r.pending) print("(waiting for the owner to answer at the system's console)");
      const deadline = performance.now() + 300000;
      while (r.pending && performance.now() < deadline) {
        await new Promise((res) => setTimeout(res, 250));
        r = await envoy.ok('ask', fields);
      }
      print(JSON.stringify(r));
    } else if (cmd === 'log') {
      const obs = await envoy.ok('observe', { since: 0 });
      print(table(obs.actions, ['seq', 'verb', 'cap', 'method', 'outcome', 'undo_of', 'undone']));
      const bad = blake3 ? verifyChain(obs.actions, blake3) : -2;
      const head = (obs.head || '').slice(0, 16);
      print(bad === -1 ? `hash chain: verified  head ${head}...` : bad === -2 ? `hash chain: not checked  head ${head}...` : `hash chain: BROKEN at entry ${bad}  head ${head}...`);
    } else if (cmd === 'bye') {
      print(JSON.stringify(await envoy.ok('bye')));
      return false;
    } else {
      print(`unknown command '${cmd}'; try 'help'`);
    }
  } catch (e) {
    if (e instanceof EnvoyError) print(`refused: ${e.message}`);
    else print(`usage error: ${e.message}`);
  }
  return true;
}
