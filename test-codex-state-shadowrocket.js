const assert = require("node:assert/strict");
const state = require("./codex-state-shadowrocket.js");

function token(blocks, issuedAt) {
  const raw = Buffer.alloc(57 + 16 * blocks);
  raw[0] = 0x80;
  raw.writeBigUInt64BE(BigInt(issuedAt), 1);
  return raw.toString("base64").replace(/\\+/g, "-").replace(/\\//g, "_");
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
