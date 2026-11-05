// The agent panel: Claude, with the owner's API key, acting on the system
// through Envoy and nothing else. The tools are what tools/envoy.py's MCP
// bridge offers: every method of every capability the agent holds, named
// <cap>__<method>, and the Envoy verbs as grain_* tools. The agent has the
// authority the manifest leases it, no more: the owner's keyboard, console
// and screen stay the owner's, and an ask is answered at the console.
import Anthropic from './vendor/anthropic-sdk.mjs';
import { EnvoyError } from './grainsh.js';

export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', fallbacks: true },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', fallbacks: true },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', fallbacks: false },
];

const MAX_ROUNDS = 40; // tool rounds for one message from the owner
const ASK_WAIT_MS = 120_000;

function jsonSchema(type) {
  if (type === 'bool') return { type: 'boolean' };
  let m;
  if ((m = /^enum\((.*)\)$/.exec(type))) return { type: 'string', enum: m[1].split('|') };
  if ((m = /^text\((\d+)\)$/.exec(type))) return { type: 'string', maxLength: Number(m[1]) };
  if ((m = /^bytes\((\d+)\)$/.exec(type))) {
    return { type: 'string', pattern: '^([0-9a-f]{2})*$', maxLength: 2 * Number(m[1]), description: `up to ${m[1]} bytes, as hex` };
  }
  if ((m = /^u(\d+)$/.exec(type))) return { type: 'integer', minimum: 0, maximum: 2 ** Number(m[1]) - 1 };
  if ((m = /^i(\d+)$/.exec(type))) return { type: 'integer', minimum: -(2 ** (Number(m[1]) - 1)), maximum: 2 ** (Number(m[1]) - 1) - 1 };
  return {};
}

const STEPS = {
  type: 'array',
  description: 'Steps, each {cap, method, args}.',
  items: { type: 'object', properties: { cap: { type: 'string' }, method: { type: 'string' }, args: { type: 'object' } }, required: ['cap', 'method'] },
};

const VERBS = [
  { name: 'grain_discover', description: 'List the capabilities you hold and the ones you may ask for, with lease limits.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'grain_ask',
    description: "Ask the owner for an askable capability. The owner answers at the system's console; this waits up to two minutes. If the answer is still pending, tell the owner and ask again later.",
    input_schema: { type: 'object', properties: { cap: { type: 'string' }, reason: { type: 'string', description: 'Why you need it, shown to the owner.' } }, required: ['cap'] },
  },
  { name: 'grain_plan', description: 'Dry-run a list of steps; changes nothing. Shows what each would do and whether it can be undone.', input_schema: { type: 'object', properties: { steps: STEPS }, required: ['steps'] } },
  {
    name: 'grain_apply',
    description: 'Run steps all-or-nothing (undoable steps only, unless allow_partial).',
    input_schema: { type: 'object', properties: { steps: STEPS, allow_partial: { type: 'boolean' } }, required: ['steps'] },
  },
  { name: 'grain_undo', description: 'Undo an earlier action by its number.', input_schema: { type: 'object', properties: { action: { type: 'integer', minimum: 1 } }, required: ['action'] } },
  { name: 'grain_observe', description: 'The audit log of your actions, hash-chained.', input_schema: { type: 'object', properties: { since: { type: 'integer', minimum: 0 } } } },
];

/// The tools for the capabilities the agent holds now (they change when the
/// owner grants an ask, or a lease runs out).
export async function tools(envoy) {
  const out = [];
  for (const cap of (await envoy.ok('discover')).capabilities) {
    if (!cap.granted) continue;
    const desc = (await envoy.ok('describe', { cap: cap.name })).descriptor;
    for (const m of desc.methods) {
      const properties = {};
      for (const p of m.params) properties[p.name] = { ...jsonSchema(p.type), description: p.doc };
      const limits = [];
      if (cap.lease && cap.lease.uses_left != null) limits.push(`${cap.lease.uses_left} uses left`);
      if (cap.lease && cap.lease.expires_in_ms != null) limits.push(`expires in ${cap.lease.expires_in_ms} ms`);
      out.push({
        name: `${cap.name}__${m.name}`,
        description: `${m.doc} [${desc.protocol}, effect: ${m.effect}${m.undo ? `, undo: ${m.undo}` : ''}${limits.length ? `, lease: ${limits.join(', ')}` : ''}]`,
        input_schema: { type: 'object', properties, required: m.params.map((p) => p.name) },
      });
    }
  }
  return [...out, ...VERBS].map((t) => ({ ...t, eager_input_streaming: true }));
}

/// Check a tool input against its schema (inputs stream unvalidated).
/// Returns an error string, or null.
export function invalid(schema, value, where = 'input') {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${where}: expected an object`;
    for (const k of schema.required || []) if (!(k in value)) return `${where}: missing ${k}`;
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && schema.properties[k]) {
        const e = invalid(schema.properties[k], v, `${where}.${k}`);
        if (e) return e;
      }
    }
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${where}: expected an array`;
    for (let i = 0; i < value.length; i++) {
      const e = schema.items && invalid(schema.items, value[i], `${where}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  if (schema.type === 'integer' && !Number.isInteger(value)) return `${where}: expected an integer`;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return `${where}: expected true or false`;
  if (schema.type === 'string' && typeof value !== 'string') return `${where}: expected a string`;
  if (schema.enum && !schema.enum.includes(value)) return `${where}: one of ${schema.enum.join(', ')}`;
  if (schema.minimum != null && value < schema.minimum) return `${where}: at least ${schema.minimum}`;
  if (schema.maximum != null && value > schema.maximum) return `${where}: at most ${schema.maximum}`;
  if (schema.maxLength != null && value.length > schema.maxLength) return `${where}: at most ${schema.maxLength} characters`;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${where}: does not match ${schema.pattern}`;
  return null;
}

/// Run one tool against Envoy. Returns {text, error}.
async function runTool(envoy, name, input, signal) {
  const text = (v) => JSON.stringify(v);
  try {
    if (name === 'grain_ask') {
      const fields = { cap: input.cap, reason: input.reason || '' };
      let r = await envoy.ok('ask', fields);
      const deadline = performance.now() + ASK_WAIT_MS;
      while (r.pending && performance.now() < deadline && !signal.aborted) {
        await new Promise((res) => setTimeout(res, 250));
        r = await envoy.ok('ask', fields);
      }
      return { text: text(r), error: false };
    }
    const verbs = { grain_discover: 'discover', grain_plan: 'plan', grain_apply: 'apply', grain_undo: 'undo', grain_observe: 'observe' };
    const r = verbs[name]
      ? await envoy.request(verbs[name], name === 'grain_observe' ? { since: input.since || 0 } : input)
      : await envoy.request('call', { cap: name.split('__')[0], method: name.split('__').slice(1).join('__'), args: input });
    return { text: text(r.ok ? r.result : r), error: !r.ok };
  } catch (e) {
    return { text: text(e instanceof EnvoyError ? e.response : { error: String(e.message || e) }), error: true };
  }
}

function systemPrompt(hello) {
  return `You are an agent acting on a Grain OS instance for its owner, who is talking to you in a web page. Grain runs in the page on an emulated RISC-V machine; you reach it only through Envoy, its agent gateway, with the tools you are given.

The instance: system ${hello.system}, closure ${hello.closure}${hello.identity ? `, identity ${hello.identity}` : ''}.

How this system works:
- Your tools are the capabilities the system's manifest leases to you: each method of each capability is a tool named <capability>__<method>. A lease may limit uses or time; when it runs out, the tool fails.
- Some capabilities are askable: grain_discover lists them, and grain_ask puts your request to the owner, who answers at the system's console in this page (not in this chat). Say what you are asking for and why before you ask.
- grain_plan dry-runs steps; grain_apply runs them all-or-nothing; grain_undo reverses an undoable action; grain_observe is your audit log. Every action you take is recorded in that log and in the system's Ledger.
- The desktop's contents can be read as data through the scene capability, if you hold it.

Be direct and brief. Prefer reading before changing. When something fails, report the error Envoy gave rather than guessing.`;
}

/// A conversation with the agent. `ui` receives what to show:
///   ui.text(delta), ui.thinking(text), ui.toolCall(name, input),
///   ui.toolResult(name, text, error), ui.turnEnd(), ui.error(message)
export class Agent {
  constructor(envoy, ui) {
    this.envoy = envoy;
    this.ui = ui;
    this.messages = [];
    this.client = null;
    this.key = '';
    this.controller = null;
    this.hello = null;
  }

  get busy() { return this.controller !== null; }

  stop() { if (this.controller) this.controller.abort(); }

  /// A new conversation (a reply still running is stopped and forgotten).
  reset() { this.stop(); this.messages = []; }

  async send(text, { key, model }) {
    if (this.busy) throw new Error('the agent is busy');
    if (!this.client || this.key !== key) {
      this.key = key;
      this.client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
    }
    const spec = MODELS.find((m) => m.id === model) || MODELS[0];
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const history = this.messages; // a reset while this runs starts a new one
    const start = history.length;
    history.push({ role: 'user', content: text });
    try {
      this.hello = this.hello || await this.envoy.ok('hello');
      const toolList = await tools(this.envoy);
      const schemas = new Map(toolList.map((t) => [t.name, t.input_schema]));
      let jsonRetries = 0;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const params = {
          model: spec.id,
          max_tokens: 32000,
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'medium' },
          system: [{ type: 'text', text: systemPrompt(this.hello), cache_control: { type: 'ephemeral' } }],
          tools: toolList,
          messages: history,
        };
        if (spec.fallbacks) Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
        const stream = this.client.beta.messages.stream(params, { signal });
        stream.on('text', (delta) => this.ui.text(delta));
        stream.on('contentBlock', (block) => { if (block.type === 'thinking' && block.thinking) this.ui.thinking(block.thinking); });
        let message;
        try {
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          // A tool input that could not be parsed at all: re-issue the turn.
          if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw err;
          continue;
        }
        if (message.stop_reason === 'refusal') {
          history.length = start; // the turn did not happen
          this.ui.error('Claude declined this request.');
          return;
        }
        const uses = message.content.filter((b) => b.type === 'tool_use');
        if (message.stop_reason === 'max_tokens' && uses.length) throw new Error('the answer was cut off (max_tokens)');
        history.push({ role: 'assistant', content: message.content });
        if (message.stop_reason === 'pause_turn') continue;
        if (uses.length === 0) { this.ui.turnEnd(); return; }
        const results = [];
        for (const use of uses) {
          this.ui.toolCall(use.name, use.input);
          const schema = schemas.get(use.name);
          const bad = !schema ? `unknown tool ${use.name}` : invalid(schema, use.input);
          let r;
          if (signal.aborted) r = { text: 'stopped by the owner', error: true };
          else if (bad) r = { text: JSON.stringify({ INVALID_JSON: JSON.stringify(use.input), detail: bad }), error: true };
          else r = await runTool(this.envoy, use.name, use.input, signal);
          this.ui.toolResult(use.name, r.text, r.error);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: r.text, ...(r.error ? { is_error: true } : {}) });
        }
        history.push({ role: 'user', content: results });
        if (signal.aborted) throw new Anthropic.APIUserAbortError();
      }
      this.ui.error(`Stopped after ${MAX_ROUNDS} rounds of tool calls.`);
    } catch (err) {
      // An exchange that did not finish is dropped whole, so the history
      // stays one the API accepts. What its tools did is in the audit log.
      history.length = start;
      this.ui.error(describe(err));
    } finally {
      this.controller = null;
    }
  }
}

function describe(err) {
  if (err instanceof Anthropic.APIUserAbortError) return 'Stopped.';
  if (err instanceof Anthropic.AuthenticationError) return 'The API key was not accepted.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key may not use that model.';
  if (err instanceof Anthropic.NotFoundError) return 'The model was not found for this key.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the API; try again shortly.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach api.anthropic.com.';
  if (err instanceof Anthropic.APIError) return `The API said: ${err.message}`;
  return String(err.message || err);
}
