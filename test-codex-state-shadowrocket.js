const assert = require("node:assert/strict");
const state = require("./codex-state-shadowrocket.js");

function token(blocks, issuedAt) {
  const raw = Buffer.alloc(57 + 16 * blocks);
  raw[0] = 0x80;
  raw.writeBigUInt64BE(BigInt(issuedAt), 1);
  return raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

const now = 1900000000;
const valid = token(10, now);
const wrongBlocks = token(11, now);
const options = state.parseOptions("model=gpt-6-astra&ttl=3600&renew=600&cooldown=300");

assert.equal(options.forceHttp, false);
assert.equal(valid.length, 292);
assert.equal(wrongBlocks.length, 312);
assert.equal(state.parseState(valid).blocks, 10);
assert.equal(state.acceptState(valid, options, now).blocks, 10);
assert.equal(state.acceptState(wrongBlocks, options, now), undefined);
assert.equal(state.acceptState(token(10, now - 3600), options, now), undefined);

const probe = {};
assert.equal(state.applyProbeRoute(probe, options, {read: () => "ignored"}), "rules");
assert.deepEqual(probe, {});

assert.equal(state.statusOf({statusCode: 200}), 200);
assert.equal(state.statusOf({status: 204}), 204);
assert.equal(state.handlesModel({"x-codex-routing-hint": "model=gpt-6-astra"}, options), true);
assert.equal(state.handlesModel({"x-codex-routing-hint": "model=gpt-daybreak-blue-latest"}, options), false);

const firstFlow = state.flowIdentifier("https://api.openai.com/v1/responses", {
  "chatgpt-account-id": "fixture-account",
  "thread-id": "thread-123"
});
const secondFlow = state.flowIdentifier("https://api.openai.com/v1/responses", {
  "chatgpt-account-id": "fixture-account",
  "thread-id": "thread-123"
});
assert.equal(firstFlow, secondFlow);

const injected = state.makeEntry(state.acceptState(valid, options, now), options, now);
assert.equal(injected.refreshAt, now + 3000);
assert.equal(injected.expiresAt, now + 3570);
assert.equal(state.usable(injected, now + 3569), true);
assert.equal(state.usable(injected, now + 3570), false);
assert.equal(state.parseOptions("force_http=1").forceHttp, true);

console.log("codex-state-shadowrocket self-check passed");

// Execute the real entrypoint with isolated Shadowrocket globals.
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync(require.resolve("./codex-state-shadowrocket.js"), "utf8");
const runtimeNow = Math.floor(Date.now() / 1000);
const runtimeValid = token(10, runtimeNow);
const runtime312 = token(11, runtimeNow);
const headers = {"chatgpt-account-id": "fixture-account", "x-codex-model": "gpt-6-astra"};
const key = state.entryKey(headers, options);
const cached = state.makeEntry(state.acceptState(runtimeValid, options, runtimeNow), options, runtimeNow);
function run({store = stateStore(), response, probe, notificationThrows = false, noNotification = false} = {}) {
  const notifications = [];
  const completions = [];
  let persisted = JSON.stringify(store);
  const sandbox = {
    $request: {id: "test-flow", url: "https://api.openai.com/v1/responses", headers},
    $persistentStore: {read: () => persisted, write: value => {persisted = value; return true;}},
    $httpClient: {post: (_, callback) => {
      assert.ok(probe, "unexpected probe");
      callback(probe.error, {status: probe.status, headers: probe.state ? {"x-codex-turn-state": probe.state} : {}}, probe.body || "");
    }},
    $done: value => completions.push(value),
    console: {log: () => {}}
  };
  if (!noNotification) sandbox.$notification = {post: (...args) => {
    if (notificationThrows) throw new Error("notification unavailable");
    notifications.push(args);
  }};
  if (response) sandbox.$response = response;
  vm.runInNewContext(source, sandbox);
  assert.equal(completions.length, 1);
  return {notifications, result: completions[0], store: JSON.parse(persisted)};
}
function stateStore(entry = cached) {
  return {entries: entry ? {[key]: {...entry}} : {}, flows: {}, history: []};
}
function hasNotice(result, text) {
  return result.notifications.some(parts => parts.join(" ").includes(text));
}
let result = run();
assert.ok(hasNotice(result, "292 打票成功"));
assert.equal(result.result.headers["x-codex-turn-state"], runtimeValid);
result = run({store: result.store});
assert.ok(hasNotice(result, "292 打票成功"));
assert.equal(result.store.entries[key].injectionCount, 2);
for (const notificationOptions of [{notificationThrows: true}, {noNotification: true}]) {
  assert.equal(run(notificationOptions).result.headers["x-codex-turn-state"], runtimeValid);
}
result = run({store: stateStore(null), probe: {status: 200, state: runtimeValid, body: "event: response.completed\n"}});
assert.ok(hasNotice(result, "已采集"));
assert.ok(hasNotice(result, "292 打票成功"));
result = run({store: stateStore(null), response: {status: 200, headers: {"x-codex-turn-state": runtimeValid}}});
assert.ok(hasNotice(result, "已采集"));
assert.equal(result.store.entries[key].value, runtimeValid);
for (const probeState of [runtime312, "invalid", undefined]) {
  result = run({store: stateStore(null), probe: {status: 200, state: probeState, body: "event: response.completed\n"}});
  assert.ok(hasNotice(result, probeState === runtime312 ? "收到 312，请注意" : probeState ? "未通过校验" : "未采集到 state"));
  assert.ok(hasNotice(result, "本次未注入"));
  assert.equal(result.store.entries[key].value, undefined);
}
result = run({store: stateStore({...cached, refreshAt: runtimeNow - 1}), probe: {status: 200, state: runtime312}});
assert.ok(hasNotice(result, "收到 312，请注意"));
assert.ok(hasNotice(result, "292 打票成功"));
assert.equal(result.result.headers["x-codex-turn-state"], runtimeValid);
result = run({response: {status: 200, headers: {"x-codex-turn-state": runtime312}}});
assert.ok(hasNotice(result, "收到 312，请注意"));
assert.equal(result.store.entries[key].value, runtimeValid);
for (const status of [401, 403, 429, 500]) {
  result = run({response: {status, headers: {}}});
  assert.ok(hasNotice(result, "HTTP " + status));
  result = run({store: stateStore(null), probe: {status}});
  assert.ok(hasNotice(result, "HTTP " + status));
}
result = run({store: stateStore(null), probe: {status: 0, error: "timeout"}});
assert.ok(hasNotice(result, "网络异常"));
result = run({store: stateStore(null), probe: {status: 200, state: runtimeValid, body: "event: response.created\n"}});
assert.ok(hasNotice(result, "探针未完成"));
assert.equal(hasNotice(result, "state 未通过校验"), false);
assert.equal(result.store.entries[key].value, undefined);
result = run({response: {status: 200, headers: {}}});
assert.equal(result.notifications.length, 0);
assert.equal(hasNotice(run(), "202"), false);
console.log("Shadowrocket notification integration checks passed");
