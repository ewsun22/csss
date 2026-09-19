// Shadowrocket adapter. Default: preserve native state and replay only within a turn.
// Cross-turn probing is explicitly experimental. No credentials or bodies are persisted.
const STORE_KEY = "codex-turn-state-shadowrocket-v2";
const PROBE_HEADER = "x-codex-state-probe";
const MAX_BODY = 2 * 1024 * 1024;
let completed = false;
function done(value) {
  if (completed) return;
  completed = true;
  $done(value || {});
}
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function isShadowrocketRuntime() {
  return typeof $persistentStore !== "undefined" && typeof $request !== "undefined";
}
function statusOf(response) {
  const value = response && (response.status || response.statusCode || response.status_code);
  const match = String(value || "").match(/^(?:HTTP\/\S+\s+)?(\d{3})(?:\s|$)/);
  return match ? Number(match[1]) : 0;
}
function notify(title, subtitle, body) {
  try {
    if (typeof $notification !== "undefined" && typeof $notification.post === "function") {
      $notification.post(title, subtitle, body);
    }
  } catch (_) { /* A notification must never interrupt traffic. */ }
}
function parseOptions(raw) {
  const options = {model: "gpt-6-astra", blocks: 10, ttl: 3600, renew: 600,
    cooldown: 300, maxBackoff: 1800, probeTimeout: 20, forceHttp: false, mode: "turn", strikes: 2};
  const numeric = {blocks: [1, 64], ttl: [120, 86400], renew: [30, 86400],
    cooldown: [30, 3600], max_backoff: [30, 86400], timeout: [1, 20], strikes: [1, 10]};
  const names = {timeout: "probeTimeout", max_backoff: "maxBackoff"};
  for (const part of String(raw || "").split("&")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    let key, value;
    try {
      key = decodeURIComponent(part.slice(0, separator));
      value = decodeURIComponent(part.slice(separator + 1));
    } catch (_) { continue; }
    if (key === "model" && value) options.model = value;
    if (key === "mode" && (value === "turn" || value === "experimental")) options.mode = value;
    if (key === "force_http") options.forceHttp = value === "1" || value === "true";
    if (Object.prototype.hasOwnProperty.call(numeric, key)) {
      const n = Number(value), bounds = numeric[key];
      if (Number.isInteger(n) && n >= bounds[0] && n <= bounds[1]) options[names[key] || key] = n;
    }
  }
  if (options.renew >= options.ttl) options.renew = Math.max(30, Math.floor(options.ttl / 3));
  options.maxBackoff = Math.max(options.maxBackoff, options.cooldown);
  return options;
}

// Portable SHA-256 for the JSC runtime (no Node crypto dependency).
// Hash identifiers before persistence. This is NOT a signature check of state tokens.
function fingerprint(value) {
  const bytes = [];
  const encoded = encodeURIComponent(String(value));
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "%") { bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(encoded.charCodeAt(i));
  }
  const length = bytes.length;
  bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bits = length * 8;
  for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bits / Math.pow(256, i)) & 255);
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const rotate = (n, b) => (n >>> b) | (n << (32 - b));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = [];
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (bytes[j] << 24) | (bytes[j+1] << 16) | (bytes[j+2] << 8) | bytes[j+3];
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i-15], b = w[i-2];
      w[i] = ((rotate(a,7)^rotate(a,18)^(a>>>3)) + w[i-16] +
        (rotate(b,17)^rotate(b,19)^(b>>>10)) + w[i-7]) | 0;
    }
    let [a,b,c,d,e,f,g,j] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (j + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + k[i] + w[i]) | 0;
      const t2 = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) | 0;
      j=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    [a,b,c,d,e,f,g,j].forEach((n,i) => { h[i]=(h[i]+n)|0; });
  }
  return h.map(n => (n>>>0).toString(16).padStart(8,"0")).join("");
}
function getHeader(headers, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
}

function setHeader(headers, name, value) {
  const result = Object.assign({}, headers);
  const wanted = name.toLowerCase();
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === wanted) delete result[key];
  }
  result[name] = value;
  return result;
}


function decodeBase64Url(value) {
  value = String(value || "").trim();
  if (!value || value.length > 2048 || /[\r\n\t ]/.test(value)) return undefined;
  const padding = (value.match(/=+$/) || [""])[0].length;
  if (padding > 2) return undefined;
  const core = value.slice(0, value.length - padding);
  if (!/^[A-Za-z0-9_-]+$/.test(core) || core.length % 4 === 1) return undefined;
  if (padding && (core.length + padding) % 4 !== 0) return undefined;

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of core) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return undefined;
    accumulator = accumulator * 64 + digit;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      const divisor = Math.pow(2, bits);
      bytes.push(Math.floor(accumulator / divisor) & 255);
      accumulator %= divisor;
    }
  }
  if (accumulator !== 0) return undefined;
  return bytes;
}


function parseState(value) {
  value = String(value || "").trim();
  const raw = decodeBase64Url(value);
  if (!raw || raw.length < 73 || raw[0] !== 0x80 || (raw.length - 57) % 16 !== 0) return undefined;

  let high = 0;
  let low = 0;
  for (let index = 1; index < 5; index++) high = high * 256 + raw[index];
  for (let index = 5; index < 9; index++) low = low * 256 + raw[index];
  const issuedAt = high * 4294967296 + low;
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 1577836800 || issuedAt >= 4102444800) return undefined;

  return {
    value,
    issuedAt,
    blocks: (raw.length - 57) / 16,
    fingerprint: fingerprint(value)
  };
}

function acceptState(value, options, now) {
  const token = parseState(value);
  if (!token || token.blocks !== options.blocks) return undefined;
  if (token.issuedAt > now + 30 || now >= token.issuedAt + options.ttl - 30) return undefined;
  return token;
}

function extractState(headers) {
  const value = getHeader(headers, "x-codex-turn-state");
  return value ? String(value) : undefined;
}


function formatTime(seconds) {
  if (!seconds) return "-";
  const date = new Date(seconds * 1000);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => String(value).padStart(2, "0")).join(":");
}

function duration(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  if (seconds < 60) return seconds + " 秒";
  return Math.floor(seconds / 60) + " 分 " + (seconds % 60) + " 秒";
}


function copyProbeHeaders(source) {
  const result = {};
  for (const name of [
    "authorization",
    "chatgpt-account-id",
    "originator",
    "user-agent",
    "version",
    "openai-beta",
    "x-codex-installation-id"
  ]) {
    const value = getHeader(source, name);
    if (value) result[name] = value;
  }
  result["content-type"] = "application/json";
  result.accept = "text/event-stream";
  result[PROBE_HEADER] = "1";
  return result;
}

function probeBody(model) {
  return JSON.stringify({
    model,
    instructions: "Reply with OK.",
    input: [{
      type: "message",
      role: "user",
      content: [{type: "input_text", text: "Reply with OK."}]
    }],
    stream: true,
    store: false,
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"]
  });
}


function accountKey(headers) {
  const auth = String(getHeader(headers, "authorization") || "").trim();
  return auth ? fingerprint(JSON.stringify([String(getHeader(headers, "chatgpt-account-id") || ""), auth])) : "";
}
function modelFromHeaders(headers) {
  const direct = String(getHeader(headers, "x-codex-model") || "");
  const match = String(getHeader(headers, "x-codex-routing-hint") || "").match(/(?:^|[;,\s])model=([^;,\s]+)/i);
  const hinted = match ? match[1] : "";
  return direct && hinted && direct !== hinted ? "!conflict" : direct || hinted;
}
function requestModel(headers, body) {
  const header = modelFromHeaders(headers);
  let model = "";
  // Do not guess from compressed or binary bodies. Reliable header metadata can still be used.
  if (typeof body === "string" && body.length <= MAX_BODY &&
      !getHeader(headers, "content-encoding")) {
    try { const parsed = JSON.parse(body); model = typeof parsed.model === "string" ? parsed.model : ""; } catch (_) {}
  }
  return header && model && header !== model ? "!conflict" : header || model;
}
function handlesModel(headers, options, body) { return requestModel(headers, body) === options.model; }
function requestContext(headers) {
  let turn = "";
  try {
    const metadata = JSON.parse(String(getHeader(headers, "x-codex-turn-metadata") || "{}"));
    if (typeof metadata.turn_id === "string") turn = metadata.turn_id;
  } catch (_) {}
  return {thread: String(getHeader(headers, "thread-id") || getHeader(headers, "session-id") || ""), turn};
}
function sourceOf(url) {
  const match = String(url || "").match(/^https:\/\/(chatgpt\.com\/backend-api\/codex|api\.openai\.com\/v1)\/responses(?:\?|$)/i);
  return match ? match[1].toLowerCase() : "";
}
function entryKey(headers, options, url, body) {
  const account = accountKey(headers), source = sourceOf(url);
  return account && source && handlesModel(headers, options, body)
    ? fingerprint(JSON.stringify([source, account, options.model, options.mode, options.blocks, options.ttl, options.renew])) : "";
}
function flowIdentifier(url, headers) {
  const direct = typeof $request !== "undefined" && $request && $request.id;
  const id = direct || getHeader(headers, "x-request-id");
  // No heuristic based on a truncated thread/turn: concurrent requests would collide.
  const account = accountKey(headers);
  return id && account && sourceOf(url) ? fingerprint(JSON.stringify([url, account, String(id)])) : "";
}
function contextFor(options) {
  const headers = $request.headers || {}, raw = requestContext(headers);
  const key = entryKey(headers, options, $request.url, $request.body);
  if (!key || !raw.thread || !raw.turn) return undefined;
  const turn = fingerprint(JSON.stringify([key, raw.thread, raw.turn]));
  return {key, turn, flow: flowIdentifier($request.url, headers, key), headers};
}
function makeEntry(token, options, now) {
  return {value: token.value, fingerprint: token.fingerprint, blocks: token.blocks, length: token.value.length,
    issuedAt: token.issuedAt, acquiredAt: now, refreshAt: token.issuedAt + options.ttl - options.renew,
    expiresAt: token.issuedAt + options.ttl - 30};
}
function usable(entry, now, options) {
  return !!(entry && entry.expiresAt > now && acceptState(entry.value, options, now));
}
function shouldRenew(entry, now, options) {
  return !usable(entry, now, options) || entry.refreshAt <= now;
}
function emptyStore() { return {version: 2, entries: {}, turns: {}, flows: {}, history: []}; }
function dictionary(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function readStore() {
  try {
    const parsed = JSON.parse($persistentStore.read(STORE_KEY) || "{}");
    if (!parsed || parsed.version !== 2) return emptyStore();
    return {version: 2, entries: dictionary(parsed.entries), turns: dictionary(parsed.turns),
      flows: dictionary(parsed.flows), history: Array.isArray(parsed.history) ? parsed.history.slice(-24) : []};
  } catch (_) { throw new Error("persistent store unavailable or corrupt"); }
}
function writeStore(store) {
  try { return $persistentStore.write(JSON.stringify(store), STORE_KEY) === true; } catch (_) { return false; }
}
function cleanStore(store, now) {
  for (const name of ["entries", "turns", "flows"]) {
    const map = store[name], retention = name === "flows" ? 86400 : 172800;
    for (const key of Object.keys(map)) {
      if (!map[key] || !Number.isFinite(map[key].updatedAt) || now - map[key].updatedAt > retention) delete map[key];
    }
    const limit = name === "entries" ? 64 : 512;
    const keys = Object.keys(map).sort((a,b) => map[b].updatedAt - map[a].updatedAt);
    for (const key of keys.slice(limit)) delete map[key];
  }
}
function addHistory(store, event) { store.history.push(event); store.history = store.history.slice(-24); }
function eventId() { return fingerprint(String(Date.now()) + ":" + Math.random()); }
function retryDelay(headers, fallback, now) {
  const value = String(getHeader(headers || {}, "retry-after") || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(fallback, Math.ceil(seconds));
  }
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(fallback, Math.ceil(date / 1000 - now)) : fallback;
}
function applyFailure(record, status, headers, options, now, reason) {
  record.failures = Math.min((record.failures || 0) + 1, 16);
  const base = Math.min(options.maxBackoff, options.cooldown * Math.pow(2, record.failures - 1));
  let delay = Math.min(options.maxBackoff, base + Math.floor(Math.random() * Math.min(30, base / 10)));
  if (status === 401 || status === 403) delay = options.ttl;
  if (status === 429) delay = retryDelay(headers, delay, now);
  record.nextProbeAt = Math.max(record.nextProbeAt || 0, now + delay);
  record.lastReason = reason;
  record.updatedAt = now;
  record.generation = (record.generation || 0) + 1;
  record.probeId = "";
  record.probeUntil = 0;
}
function stateReason(value, options, now) {
  if (!value) return "missing_state";
  const parsed = parseState(value);
  if (!parsed) return "invalid_state";
  if (parsed.blocks !== options.blocks) return "unexpected_shape";
  if (!acceptState(value, options, now)) return "expired_or_future_state";
  return "valid_state";
}
function streamCompleted(body) {
  if (typeof body !== "string" || body.length > MAX_BODY) return false;
  const text = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const chunks = text.split("\n\n");
  // An event not terminated by an empty line is truncated.
  const tail = chunks.pop();
  if (tail && tail.trim()) return false;
  let responseId = "", terminal = false;
  for (const chunk of chunks) {
    let event = "", data = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) continue;
    const payload = data.join("\n");
    if (payload === "[DONE]") { if (!terminal) return false; continue; }
    let parsed;
    try { parsed = JSON.parse(payload); } catch (_) { return false; }
    if (!parsed || typeof parsed.type !== "string" || (event && event !== parsed.type)) return false;
    if (terminal || ["error", "response.failed", "response.incomplete"].includes(parsed.type)) return false;
    const response = parsed.response;
    if (response && typeof response.id === "string") {
      if (responseId && responseId !== response.id) return false;
      responseId = response.id;
    }
    if (parsed.type === "response.completed") {
      if (!response || !response.id || response.status !== "completed") return false;
      terminal = true;
    }
  }
  return terminal;
}
function notifyProblem(status, value, reason, source, record, now) {
  if (value && value.length === 312) {
    notify("Codex 收到 312，请注意", source, "观察到 312 字符 state；不代表已确认降智。同轮不主动换票。");
  } else if (value && ["invalid_state", "unexpected_shape", "expired_or_future_state"].includes(reason)) {
    notify("Codex state 未通过校验", source, "实际长度 " + value.length + "；原因：" + reason);
  }
  const messages = {network_error: "网络异常", missing_state: "未采集到 state", incomplete_stream: "探针未完成",
    state_changed: "同轮 state 发生变化", http_error: "响应异常"};
  const message = status === 429 ? "请求限流" : status === 401 || status === 403 ? "认证或访问失败" : messages[reason];
  if (message) notify("Codex " + message + "，请注意", source + (status ? " · HTTP " + status : ""),
    record && record.nextProbeAt > now ? "下次允许探针：" + formatTime(record.nextProbeAt) + "；正式请求不会自动重放。" : "请检查请求结果；同轮保持原状态。");
}
function notifyCaptured(entry, options, now) {
  notify("Codex " + entry.length + " 已采集", options.mode === "turn" ? "仅供当前轮次复用" : "实验模式候选票",
    "本地有效期剩余 " + duration(entry.expiresAt - now) + "；结构校验通过，不代表质量保证。");
}
function canReplace(current, token) {
  return !current || token.issuedAt > current.issuedAt;
}
function applyProbeRoute() { return "rules"; }

function renew(context, options, callback) {
  const now = nowSeconds(), store = readStore();
  const record = store.entries[context.key] || {generation: 0, updatedAt: now};
  if (record.probeUntil > now || record.nextProbeAt > now) { callback(); return; }
  const probeId = eventId(), generation = record.generation || 0;
  record.probeId = probeId;
  record.probeUntil = now + options.probeTimeout + 5;
  record.updatedAt = now;
  store.entries[context.key] = record;
  if (!writeStore(store)) { callback(); return; }
  let settled = false;
  const finish = (error, response, body) => {
    if (settled) return;
    settled = true;
    try {
      const finishedAt = nowSeconds(), latest = readStore(), active = latest.entries[context.key];
      // Re-read after I/O: another request may have captured a ticket or imposed a cooldown.
      if (!active || active.probeId !== probeId || (active.generation || 0) !== generation) { callback(); return; }
      active.probeId = "";
      active.probeUntil = 0;
      const status = statusOf(response), value = extractState(response && response.headers);
      const token = !error && status === 200 && streamCompleted(body) ? acceptState(value, options, finishedAt) : undefined;
      let reason = error || !status ? "network_error" : status !== 200 ? "http_error" : stateReason(value, options, finishedAt);
      if (reason === "valid_state" && !streamCompleted(body)) reason = "incomplete_stream";
      const accepted = token && canReplace(active.ticket, token);
      if (accepted) {
        active.ticket = makeEntry(token, options, finishedAt);
        active.generation = generation + 1;
        active.ticketGeneration = (active.ticketGeneration || 0) + 1;
        active.failures = 0;
        active.nextProbeAt = finishedAt + options.cooldown;
        active.needsRenew = false;
        active.strikes = 0;
        active.lastReason = "probe_captured";
      } else {
        if (token) reason = "not_newer_state";
        applyFailure(active, status, (response && response.headers) || {}, options, finishedAt, reason);
      }
      active.updatedAt = finishedAt;
      active.lastProbe = {at: finishedAt, status, length: value ? value.length : 0, accepted: !!accepted, reason};
      addHistory(latest, {at: finishedAt, type: "probe", reason: accepted ? "probe_captured" : reason, length: value ? value.length : 0});
      if (writeStore(latest)) {
        if (accepted) notifyCaptured(active.ticket, options, finishedAt);
        else notifyProblem(status, value, reason, "采集探针", active, finishedAt);
      }
      callback();
    } catch (_) { console.log("[probe] runtime failure; pass through"); done({}); }
  };
  try {
    if (typeof $httpClient === "undefined" || typeof $httpClient.post !== "function") {
      finish("unavailable"); return;
    }
    $httpClient.post({url: $request.url, headers: copyProbeHeaders(context.headers), body: probeBody(options.model),
      timeout: options.probeTimeout, "auto-redirect": false, "auto-cookie": false}, finish);
  } catch (_) { finish("network"); }
}

function recordRequest(store, context, turn, now, reason, value) {
  if (context.flow) {
    store.flows[context.flow] = {key: context.key, turn: context.turn, updatedAt: now,
      generation: turn.ticketGeneration || 0, turnId: turn.id,
      injected: reason === "injected",
      fingerprint: value ? fingerprint(value) : "", sent: !!value};
  }
  addHistory(store, {at: now, type: "request", reason, length: value ? value.length : 0});
}
function finishRequest(context, options) {
  const now = nowSeconds(), store = readStore();
  cleanStore(store, now);
  const native = extractState(context.headers);
  let turn = store.turns[context.turn];
  const record = store.entries[context.key];
  if (!turn) {
    turn = {id: eventId(), key: context.key, updatedAt: now, phase: "waiting", ticketGeneration: record ? record.ticketGeneration || 0 : 0};
    // Seed only a previously unseen turn. Never replace a ticket midway through a turn.
    if (!native && options.mode === "experimental" && record && !record.needsRenew && usable(record.ticket, now, options)) {
      turn.ticket = record.ticket;
      turn.phase = "locked";
    }
    store.turns[context.turn] = turn;
  }
  turn.updatedAt = now;
  let value, reason;
  if (native) {
    // A client-owned state always wins; do not later inject an unrelated state into this turn.
    turn.phase = "native";
    turn.ticket = undefined;
    reason = "native_preserved";
  } else if (turn.phase === "locked" && usable(turn.ticket, now, options)) {
    value = turn.ticket.value;
    reason = "injected";
    turn.injectionCount = (turn.injectionCount || 0) + 1;
  } else {
    if (turn.phase === "locked") { turn.phase = "expired"; turn.ticket = undefined; }
    reason = turn.phase === "waiting" ? "waiting_for_response" : "turn_passthrough";
  }
  recordRequest(store, context, turn, now, reason, native || value);
  if (!writeStore(store)) {
    notify("Codex 缓存写入失败", "本次透传", "请检查 Shadowrocket 持久化存储。");
    done({}); return;
  }
  if (value) {
    notify("Codex " + (turn.ticket.blocks === 10 ? "292" : value.length) + " 打票成功", "本次请求已注入 " + value.length,
      "本地注入完成；剩余 " + duration(turn.ticket.expiresAt - now) + "。不代表上游生成已成功。");
    done({headers: setHeader(context.headers, "x-codex-turn-state", value)});
  } else {
    if (!native) notify("Codex 本次未注入", options.mode === "turn" ? "同轮模式" : "实验模式",
      "请求已正常放行；原因：" + reason + (record && record.nextProbeAt > now ? "；探针等待至 " + formatTime(record.nextProbeAt) : ""));
    done({});
  }
}
function handleRequest(options) {
  const headers = $request.headers || {};
  if (getHeader(headers, PROBE_HEADER) === "1") { done({}); return; }
  const context = contextFor(options);
  if (!context || !context.flow) { console.log("[request] insufficient identity/model/turn/flow; observe only"); done({}); return; }
  if (options.forceHttp && /websocket/i.test(String(getHeader(headers, "upgrade") || ""))) {
    notify("Codex 等待 HTTP 回退", "已启用 force_http", "当前 WebSocket 请求已中止。");
    done({abort: true}); return;
  }
  const now = nowSeconds(), store = readStore();
  cleanStore(store, now);
  const record = store.entries[context.key];
  const existing = store.turns[context.turn];
  if (extractState(headers) || existing || options.mode !== "experimental") { finishRequest(context, options); return; }
  if (record && !record.needsRenew && !shouldRenew(record.ticket, now, options)) { finishRequest(context, options); return; }
  renew(context, options, () => finishRequest(context, options));
}
function handleResponse(options) {
  const headers = $request.headers || {};
  if (getHeader(headers, PROBE_HEADER) === "1") { done({}); return; }
  const now = nowSeconds();
  let context = contextFor(options);
  // Shadowrocket response hooks may omit the request body. Recover only from an
  // identity-bound request receipt, never from a guessed/default model.
  if (!context && !requestModel(headers, $request.body)) {
    const receipt = readStore().flows[flowIdentifier($request.url, headers)];
    const supplemented = setHeader(headers, "x-codex-model", options.model);
    const key = entryKey(supplemented, options, $request.url);
    if (receipt && receipt.key === key) {
      context = {key, turn: receipt.turn, flow: flowIdentifier($request.url, headers), headers};
    }
  }
  const responseHeaders = $response.headers || {}, value = extractState(responseHeaders), status = statusOf($response);
  const reason = !status ? "network_error" : status !== 200 ? "http_error" : stateReason(value, options, now);
  // Without reliable correlation, allow diagnostics but never mutate cached state.
  if (!context || !context.flow) {
    if (sourceOf($request.url) && handlesModel(headers, options, $request.body) && (status !== 200 || (value && reason !== "valid_state"))) {
      notifyProblem(status, value, reason, "未关联的响应", null, now);
    }
    done({}); return;
  }
  const store = readStore();
  cleanStore(store, now);
  const flow = store.flows[context.flow];
  if (flow) delete store.flows[context.flow];
  let record = store.entries[context.key];
  if (!record) record = {generation: 0, updatedAt: now};
  const turn = store.turns[context.turn];
  const matched = flow && turn && flow.turnId === turn.id && flow.key === context.key && flow.turn === context.turn;
  let captured, scheduled = false;
  let observation = reason;
  if (status === 401 || status === 403 || status === 429 || status >= 500 || !status) {
    // Rate limits apply to the identity even if a response was too late to correlate.
    applyFailure(record, status, responseHeaders, options, now, reason);
  }
  if (matched && status === 200 && value) {
    const token = acceptState(value, options, now);
    const changed = flow.sent && flow.fingerprint !== fingerprint(value);
    if (changed && token) observation = "state_changed";
    if (!token && turn.phase === "waiting" && !flow.sent) {
      // The server already selected a different shape for this turn. Do not later
      // adopt another response's state halfway through that same turn.
      turn.phase = "observed_only";
      turn.updatedAt = now;
    }
    if (token && turn.phase === "waiting" && !flow.sent) {
      turn.ticket = makeEntry(token, options, now);
      turn.phase = "locked";
      turn.updatedAt = now;
      captured = turn.ticket;
      // Capture a formal response's header only as a routing observation, not generation success.
      if (options.mode === "experimental" && canReplace(record.ticket, token)) {
        record.ticket = turn.ticket;
        record.generation = (record.generation || 0) + 1;
        record.ticketGeneration = (record.ticketGeneration || 0) + 1;
        record.probeId = "";
        record.probeUntil = 0;
        record.needsRenew = false;
        record.strikes = 0;
        // Do not clear a server-imposed cooldown just because another in-flight response succeeded.
        turn.ticketGeneration = record.ticketGeneration;
      }
    }
    if (options.mode === "experimental" && flow.injected && record.ticket && flow.fingerprint === record.ticket.fingerprint && flow.generation === (record.ticketGeneration || 0)) {
      if (!token || changed) {
        record.strikes = (record.strikes || 0) + 1;
        if (record.strikes >= options.strikes && !record.needsRenew) {
          record.needsRenew = true;
          record.generation = (record.generation || 0) + 1;
          record.probeId = "";
          record.probeUntil = 0;
          scheduled = true;
        }
      } else record.strikes = 0;
    }
  }
  record.lastReason = observation;
  record.updatedAt = now;
  store.entries[context.key] = record;
  addHistory(store, {at: now, type: "response", status, reason: observation, length: value ? value.length : 0});
  const saved = writeStore(store);
  if (saved && captured) notifyCaptured(captured, options, now);
  if (saved && scheduled) notify("Codex 已安排重新采集", "仅在后续新轮次触发", "连续 state 异常；保留当前轮次状态并遵守探针冷却。");
  if (status !== 200 || (value && observation !== "valid_state")) notifyProblem(status, value, observation, "正式请求响应", record, now);
  done({});
}
function panelView(store, options, now) {
  const entries = Object.values(store.entries || {}).filter(Boolean).sort((a,b) => b.updatedAt - a.updatedAt);
  const record = entries[0];
  const lines = ["模式：" + (options.mode === "turn" ? "同轮复用，保留客户端 state" : "跨轮实验，当前轮次锁定"),
    "有缓存不代表下一请求一定注入；需身份、模型、轮次匹配。"];
  if (record) {
    lines.push("最近状态：" + (record.lastReason || "等待响应"));
    if (record.ticket) lines.push("候选票剩余：" + duration(record.ticket.expiresAt - now));
    if (record.needsRenew) lines.push("后续新轮次：需要重新采集");
    if (record.nextProbeAt > now) lines.push("下次允许探针：" + formatTime(record.nextProbeAt));
    if (record.lastProbe) lines.push("最近探针：" + formatTime(record.lastProbe.at) + "／" + record.lastProbe.reason);
  }
  for (const event of (store.history || []).slice(-6).reverse()) {
    lines.push(formatTime(event.at) + " " + event.type + " " + event.reason + (event.length ? "／长度 " + event.length : ""));
  }
  return {title: "Codex 292：本地诊断", content: lines.join("\n"), style: "info", icon: "bolt.shield.fill"};
}
function main() {
  try {
    const options = parseOptions(typeof $argument === "string" ? $argument : "");
    if (typeof $input !== "undefined" && $input && $input.purpose === "panel") {
      done(panelView(readStore(), options, nowSeconds()));
    } else if (typeof $response !== "undefined") handleResponse(options);
    else handleRequest(options);
  } catch (_) { console.log("[runtime] unexpected error; request passed through"); done({}); }
}
if (typeof module !== "undefined") module.exports = {STORE_KEY, parseOptions, fingerprint, parseState, acceptState,
  decodeBase64Url, accountKey, requestModel, modelFromHeaders, handlesModel, entryKey, requestContext, flowIdentifier,
  sourceOf, statusOf, makeEntry, usable, shouldRenew, retryDelay, streamCompleted, emptyStore, panelView,
  getHeader, setHeader, extractState, formatTime, applyProbeRoute, isShadowrocketRuntime};
if (typeof $done === "function") main();
