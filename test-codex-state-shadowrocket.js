const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');
const state = require('./codex-state-shadowrocket');
const source = fs.readFileSync(require.resolve('./codex-state-shadowrocket'), 'utf8');
const now = 1900000000;
const url = 'https://api.openai.com/v1/responses';
const options = state.parseOptions('');
const experimental = state.parseOptions('mode=experimental');
function token(blocks = 10, issuedAt = now, salt = 0, padded = true) {
  const raw = Buffer.alloc(57 + 16 * blocks, salt);
  raw[0] = 128;
  raw.writeBigUInt64BE(BigInt(issuedAt), 1);
  return raw.toString(padded ? 'base64' : 'base64url').replace(/\+/g, '-').replace(/\//g, '_');
}
const valid = token(), wrong = token(11);
function headers(turn = 'turn-1', overrides = {}) {
  return {authorization: 'Bearer fixture-secret', 'chatgpt-account-id': 'fixture-account',
    'x-codex-model': options.model, 'thread-id': 'thread-1',
    'x-codex-turn-metadata': JSON.stringify({turn_id: turn}), ...overrides};
}
function event(type, extra = {}) { return `event: ${type}\ndata: ${JSON.stringify({type, ...extra})}\n\n`; }
function completed(id = 'resp_test') {
  return event('response.created', {response: {id, status: 'in_progress'}}) +
    event('response.completed', {response: {id, status: 'completed'}});
}
function harness(initial = state.emptyStore()) {
  let persisted = JSON.stringify(initial), clock = now, calls = 0;
  const pending = [];
  const api = {
    clock(value) { clock = value; },
    get store() { return JSON.parse(persisted); },
    set store(value) { persisted = JSON.stringify(value); },
    get calls() { return calls; }, pending,
    run({h = headers(), id = 'flow-1', mode = 'turn', body, response, probe, defer = false,
      writeFail = false, corruptStore = false, readThrows = false, noNotification = false, notificationThrows = false,
      requestUrl = url, throwPost = false, args = ''} = {}) {
      const notices = [], results = [];
      const sandbox = {
        Date: class extends Date { static now() { return clock * 1000; } },
        $argument: 'mode=' + mode + args,
        $request: {id, url: requestUrl, headers: h, ...(body === undefined ? {} : {body})},
        $persistentStore: {read: () => { if (readThrows) throw new Error('storage'); return corruptStore ? 'broken' : persisted; },
          write: value => { if (writeFail) return false; persisted = value; return true; }},
        $httpClient: {post: (request, callback) => {
          calls++;
          if (throwPost) throw new Error('network');
          if (defer) { pending.push({request, callback}); return; }
          assert.ok(probe, 'unexpected probe');
          callback(probe.error, {status: probe.status, headers: probe.headers || (probe.state ? {'x-codex-turn-state': probe.state} : {})}, probe.body || '');
        }},
        $done: value => results.push(value), console: {log() {}}
      };
      if (response !== undefined) sandbox.$response = response;
      if (!noNotification) sandbox.$notification = {post: (...parts) => {
        if (notificationThrows) throw new Error('notifications disabled');
        notices.push(parts.join(' '));
      }};
      vm.runInNewContext(source, sandbox);
      if (!defer) assert.equal(results.length, 1, 'must finish exactly once');
      return {notices, results, get result() { return results[0]; }};
    }
  };
  return api;
}
function has(run, text) { return run.notices.some(s => s.includes(text)); }
function injected(run) { return run.result && run.result.headers && run.result.headers['x-codex-turn-state']; }
function response(value = valid, status = 200, extra = {}) {
  return {status, headers: {...(value ? {'x-codex-turn-state': value} : {}), ...extra}};
}
function capture(h = harness(), mode = 'turn', value = valid) {
  h.run({mode}); h.run({mode, response: response(value)}); return h;
}
function seedExperimental(value = valid) {
  const s = state.emptyStore();
  const key = state.entryKey(headers(), experimental, url);
  s.entries[key] = {ticket: state.makeEntry(state.acceptState(value, experimental, now), experimental, now),
    generation: 1, ticketGeneration: 1, updatedAt: now};
  return harness(s);
}
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }

test('portable SHA-256 agrees with node including long and Unicode identities', () => {
  for (const value of ['', 'abc', 'fixture-secret', '账号🔑', 'x'.repeat(1000)]) {
    assert.equal(state.fingerprint(value), crypto.createHash('sha256').update(value).digest('hex'));
  }
});
test('options reject malformed and unbounded values', () => {
  assert.equal(options.mode, 'turn');
  assert.equal(state.parseOptions('mode=wrong&ttl=Infinity&blocks=1.5&timeout=999&%zz=1').ttl, 3600);
  assert.equal(state.parseOptions('ttl=120&renew=600').renew, 40);
  assert.equal(state.parseOptions('force_http=0').forceHttp, false);
});
test('state parsing distinguishes bytes, blocks, time and encoding length', () => {
  assert.equal(valid.length, 292); assert.equal(wrong.length, 312);
  assert.equal(state.acceptState(valid, options, now).blocks, 10);
  assert.equal(state.acceptState(token(10, now, 0, false), options, now).value.length, 290);
  for (const value of [wrong, token(10, now - 3600), token(10, now + 31), 'invalid']) {
    assert.equal(state.acceptState(value, options, now), undefined);
  }
  const entry = state.makeEntry(state.acceptState(valid, options, now), options, now);
  assert.equal(state.shouldRenew(entry, now + 2999, options), false);
  assert.equal(state.shouldRenew(entry, now + 3000, options), true);
  assert.equal(state.usable(entry, now + 3570, options), false);
  assert.equal(state.usable({...entry, value: 'broken'}, now, options), false);
});
test('identity isolation covers credentials, source, model conflicts, full turn ids', () => {
  const key = state.entryKey(headers(), options, url);
  assert.ok(key);
  assert.notEqual(key, state.entryKey(headers('turn-1', {authorization: 'Bearer other'}), options, url));
  assert.notEqual(key, state.entryKey(headers(), options, 'https://chatgpt.com/backend-api/codex/responses'));
  assert.equal(state.entryKey(headers('turn-1', {authorization: ''}), options, url), '');
  assert.equal(state.entryKey(headers(), options, 'https://evil.example/responses'), '');
  assert.equal(state.handlesModel({}, options), false);
  assert.equal(state.handlesModel({}, options, JSON.stringify({model: options.model})), true);
  assert.equal(state.handlesModel(headers(), options, '{"model":"other"}'), false);
  assert.equal(state.handlesModel({'content-encoding': 'gzip'}, options, JSON.stringify({model: options.model})), false);
  assert.notEqual(state.accountKey({authorization: 'a'}), state.accountKey({authorization: 'b'}));
  assert.equal(state.requestContext(headers('long-prefix-12345678')).turn, 'long-prefix-12345678');
});
test('SSE only accepts complete structured completion with consistent response ids', () => {
  assert.ok(state.streamCompleted(completed()));
  assert.ok(state.streamCompleted(completed().replace(/\n/g, '\r\n')));
  assert.ok(state.streamCompleted(completed() + 'data: [DONE]\n\n'));
  for (const body of [
    'event: response.completed\n',
    event('response.output_text.delta', {delta: '"type":"response.completed"'}),
    event('response.completed', {response: {id: 'x', status: 'failed'}}),
    event('response.created', {response: {id: 'x'}}) + event('response.completed', {response: {id: 'y', status: 'completed'}}),
    completed() + event('response.failed'),
    completed().trim(),
    'event: response.completed\ndata: nope\n\n',
    'event: response.completed\ndata: {"type":"response.created"}\n\n',
    'data: [DONE]\n\n'
  ]) assert.equal(state.streamCompleted(body), false, body);
});
test('Retry-After seconds and date never shorten cooldown', () => {
  assert.equal(state.retryDelay({'retry-after': '700'}, 300, now), 700);
  assert.equal(state.retryDelay({'retry-after': new Date((now + 900) * 1000).toUTCString()}, 300, now), 900);
  assert.equal(state.retryDelay({'retry-after': '-1'}, 300, now), 300);
  assert.equal(state.retryDelay({'retry-after': 'junk'}, 300, now), 300);
  assert.equal(state.statusOf({status: 'HTTP/1.1 429 Too Many Requests'}), 429);
});
test('default first request observes response, then injects each same-turn request', () => {
  const h = capture();
  assert.equal(h.calls, 0);
  let run = h.run({id: 'flow-2'});
  assert.equal(injected(run), valid); assert.ok(has(run, '292 打票成功'));
  run = h.run({id: 'flow-3'});
  assert.equal(injected(run), valid); assert.ok(has(run, '292 打票成功'));
  assert.equal(Object.values(h.store.turns)[0].injectionCount, 2);
  assert.equal(injected(h.run({h: headers('turn-2'), id: 'flow-4'})), undefined);
  assert.equal(h.calls, 0);
});
test('default isolation prevents other users, sources, threads and colliding suffixes from reusing', () => {
  const h = capture();
  for (const changes of [{authorization: 'Bearer another'}, {'chatgpt-account-id': 'another'}, {'thread-id': 'thread-2'}]) {
    assert.equal(injected(h.run({h: headers('turn-1', changes), id: 'other'})), undefined);
  }
  assert.equal(injected(h.run({requestUrl: 'https://chatgpt.com/backend-api/codex/responses'})), undefined);
  const x = harness();
  x.run({h: headers('prefix-a-12345678')}); x.run({h: headers('prefix-a-12345678'), response: response()});
  assert.equal(injected(x.run({h: headers('prefix-b-12345678')})), undefined);
});
test('unknown model, missing turn, missing correlation, unsupported URL pass through without probes', () => {
  const h = harness();
  for (const overrides of [{'x-codex-model': ''}, {'x-codex-turn-metadata': ''}, {authorization: ''}, {'thread-id': ''}]) {
    assert.equal(injected(h.run({mode: 'experimental', h: headers('turn-1', overrides)})), undefined);
  }
  assert.equal(injected(h.run({mode: 'experimental', id: '', h: {...headers(), 'x-request-id': ''}})), undefined);
  assert.equal(h.calls, 0);
});
test('client state always wins and disables unrelated script injection for that turn', () => {
  const h = capture();
  const run = h.run({h: headers('turn-1', {'X-Codex-Turn-State': 'client-owned'})});
  assert.equal(injected(run), undefined); assert.equal(has(run, '打票成功'), false);
  assert.equal(injected(h.run()), undefined);
  assert.equal(Object.values(h.store.turns)[0].phase, 'native');
});
test('formal responses without a recorded flow cannot populate the cache', () => {
  const h = harness();
  h.run({response: response()});
  assert.equal(Object.keys(h.store.turns).length, 0);
  assert.equal(injected(h.run()), undefined);
});
test('same-turn response never replaces locked token, even when newer', () => {
  const h = capture();
  h.run({id: 'second'});
  h.run({id: 'second', response: response(token(10, now + 1, 1))});
  assert.equal(injected(h.run({id: 'third'})), valid);
});
test('expired turn cannot be reseeded by renewal or later responses', () => {
  const h = capture();
  h.clock(now + 3570);
  assert.equal(injected(h.run({id: 'expired'})), undefined);
  h.run({id: 'expired', response: response(token(10, now + 3570))});
  assert.equal(injected(h.run({id: 'still-expired'})), undefined);
  assert.equal(h.calls, 0);
});
test('notification failure or absence does not block injection; persistence failure does', () => {
  const h = capture();
  assert.equal(injected(h.run({notificationThrows: true})), valid);
  assert.equal(injected(h.run({noNotification: true})), valid);
  assert.equal(injected(h.run({writeFail: true})), undefined);
  assert.equal(injected(h.run({corruptStore: true})), undefined);
});
test('experimental first request probes then locks and injects, without persisting secrets', () => {
  const h = harness();
  const run = h.run({mode: 'experimental', probe: {status: 200, state: valid, body: completed()}});
  assert.equal(injected(run), valid); assert.ok(has(run, '已采集')); assert.ok(has(run, '打票成功'));
  assert.equal(h.calls, 1);
  assert.equal(injected(h.run({mode: 'experimental', h: headers('turn-2'), id: 'next'})), valid);
  const serialized = JSON.stringify(h.store);
  for (const secret of ['fixture-secret', 'fixture-account', 'thread-1', 'turn-1', 'Reply with OK']) assert.equal(serialized.includes(secret), false);
});
test('renewal starts in the last ten minutes only for a new turn; failed renewal keeps old valid candidate', () => {
  const h = seedExperimental(token(10, now - 2990));
  const first = h.run({mode: 'experimental'});
  assert.ok(injected(first));
  h.clock(now + 20);
  assert.ok(injected(h.run({mode: 'experimental', id: 'same-turn'})));
  assert.equal(h.calls, 0);
  const renew = h.run({mode: 'experimental', h: headers('turn-2'), id: 'new-turn', probe: {status: 200, state: wrong, body: completed()}});
  assert.ok(has(renew, '收到 312')); assert.equal(injected(renew), token(10, now - 2990));
  assert.equal(h.calls, 1);
  assert.ok(injected(h.run({mode: 'experimental', h: headers('turn-3'), id: 'cooling'})));
  assert.equal(h.calls, 1);
});
test('two anomalous observations arrange a new-turn probe but do not change current-turn token', () => {
  const h = seedExperimental();
  for (const id of ['a', 'b']) {
    assert.equal(injected(h.run({mode: 'experimental', id})), valid);
    h.run({mode: 'experimental', id, response: response(wrong)});
  }
  assert.equal(Object.values(h.store.entries)[0].needsRenew, true);
  assert.equal(injected(h.run({mode: 'experimental', id: 'same'})), valid);
  const newer = token(10, now + 1, 1);
  const run = h.run({mode: 'experimental', h: headers('turn-2'), id: 'next', probe: {status: 200, state: newer, body: completed()}});
  assert.equal(injected(run), newer);
  assert.equal(Object.values(h.store.entries)[0].needsRenew, false);
});
test('HTTP failures do not count as shape strikes and formal 429 blocks later probes', () => {
  const h = seedExperimental();
  h.run({mode: 'experimental'});
  h.run({mode: 'experimental', response: response(undefined, 429, {'retry-after': '900'})});
  const record = Object.values(h.store.entries)[0];
  assert.ok(record.nextProbeAt >= now + 900); assert.equal(record.strikes, undefined);
  h.clock(now + 100);
  assert.equal(injected(h.run({mode: 'experimental', h: headers('turn-2'), id: 'next'})), valid);
  assert.equal(h.calls, 0);
});
test('invalid, incomplete, failed probes never capture or inject absent cached ticket', () => {
  for (const probe of [
    {status: 200, state: wrong, body: completed()}, {status: 200, state: valid, body: 'event: response.completed\n'},
    {status: 200}, {status: 401}, {status: 403}, {status: 429}, {status: 500}, {status: 0, error: 'timeout'}
  ]) {
    const h = harness();
    const run = h.run({mode: 'experimental', probe});
    assert.equal(injected(run), undefined);
    const record = Object.values(h.store.entries)[0];
    assert.equal(record.ticket, undefined); assert.ok(record.nextProbeAt > now);
    assert.ok(has(run, '本次未注入'));
    h.run({mode: 'experimental', id: 'cooling', h: headers('turn-2')});
    assert.equal(h.calls, 1);
  }
});
test('newer probe accepted; same/older candidate cannot pretend to renew expiry', () => {
  const old = token(10, now - 3100);
  const h = seedExperimental(old);
  h.run({mode: 'experimental', probe: {status: 200, state: old, body: completed()}});
  const record = Object.values(h.store.entries)[0];
  assert.equal(record.ticket.value, old); assert.equal(record.lastReason, 'not_newer_state');
  assert.ok(record.nextProbeAt > now);
});
test('concurrent new turns share in-flight probe; a waiting turn is never retroactively reseeded', () => {
  const h = harness();
  const first = h.run({mode: 'experimental', defer: true});
  assert.equal(first.results.length, 0);
  const second = h.run({mode: 'experimental', h: headers('turn-2'), id: 'second'});
  assert.equal(injected(second), undefined); assert.equal(h.calls, 1);
  h.pending[0].callback(null, response(), completed());
  assert.equal(first.results.length, 1); assert.equal(injected(first), valid);
  assert.equal(injected(h.run({mode: 'experimental', h: headers('turn-2'), id: 'second-again'})), undefined);
  h.pending[0].callback(null, response(), completed());
  assert.equal(first.results.length, 1);
});
test('late probe cannot override a formal capture or a new server cooldown', () => {
  for (const status of [200, 429]) {
    const h = harness();
    const first = h.run({mode: 'experimental', defer: true});
    h.run({mode: 'experimental', h: headers('turn-2'), id: 'second'});
    const newer = token(10, now + 1, 1);
    h.run({mode: 'experimental', h: headers('turn-2'), id: 'second', response: response(newer, status, {'retry-after': '900'})});
    h.pending[0].callback(null, response(valid), completed());
    const record = Object.values(h.store.entries)[0];
    if (status === 200) { assert.equal(record.ticket.value, newer); assert.equal(injected(first), newer); }
    else { assert.equal(record.ticket, undefined); assert.equal(injected(first), undefined); assert.ok(record.nextProbeAt >= now + 900); }
  }
});
test('transient backoff grows and is capped, network throw completes exactly once', () => {
  const h = harness();
  for (let i = 0; i < 5; i++) {
    const at = now + i * 5000;
    h.clock(at);
    h.run({mode: 'experimental', h: headers('turn-' + i), id: 'flow-' + i, throwPost: true});
    const delay = Object.values(h.store.entries)[0].nextProbeAt - at;
    assert.ok(delay >= Math.min(1800, 300 * 2 ** i)); assert.ok(delay <= 1800);
  }
});
test('old v1 cache is ignored and malformed storage fails open', () => {
  const h = harness({entries: {default: {value: valid, expiresAt: now + 9999}}});
  assert.equal(injected(h.run()), undefined);
  assert.equal(h.store.version, 2);
});

test('body-only model uses an identity-bound receipt when response hook omits body', () => {
  const h = harness(), noModel = headers('turn-1', {'x-codex-model': ''});
  h.run({h: noModel, body: JSON.stringify({model: options.model})});
  h.run({h: noModel, response: response()});
  assert.equal(injected(h.run({h: noModel, body: JSON.stringify({model: options.model}), id: 'second'})), valid);
  const other = harness();
  other.run({h: noModel, response: response()});
  assert.equal(Object.keys(other.store.turns).length, 0);
});
test('429 probe invalidation does not disable same-ticket anomaly accounting', () => {
  const h = seedExperimental();
  h.run({mode: 'experimental', id: 'limited'});
  h.run({mode: 'experimental', id: 'limited', response: response(null, 429, {'retry-after': '900'})});
  for (const id of ['a', 'b']) {
    h.run({mode: 'experimental', id});
    h.run({mode: 'experimental', id, response: response(wrong)});
  }
  const record = Object.values(h.store.entries)[0];
  assert.equal(record.needsRenew, true); assert.ok(record.nextProbeAt >= now + 900);
  assert.equal(injected(h.run({mode: 'experimental', h: headers('new-turn'), id: 'next'})), undefined);
  assert.equal(h.calls, 0);
});
test('scheduled-renewal notice is sent only after persistence succeeds', () => {
  const h = seedExperimental();
  h.run({mode: 'experimental', id: 'a'}); h.run({mode: 'experimental', id: 'a', response: response(wrong)});
  h.run({mode: 'experimental', id: 'b'});
  const run = h.run({mode: 'experimental', id: 'b', response: response(wrong), writeFail: true});
  assert.equal(has(run, '已安排重新采集'), false);
  assert.equal(Object.values(h.store.entries)[0].needsRenew, undefined);
});
test('successful but aging probe has minimum cooldown instead of repeatedly probing', () => {
  const h = harness();
  const aged = token(10, now - 3050);
  assert.equal(injected(h.run({mode: 'experimental', probe: {status: 200, state: aged, body: completed()}})), aged);
  assert.equal(injected(h.run({mode: 'experimental', h: headers('turn-2'), id: 'second'})), aged);
  assert.equal(h.calls, 1);
  assert.ok(Object.values(h.store.entries)[0].nextProbeAt >= now + 300);
});
test('old-turn anomalous responses cannot invalidate newer candidate ticket', () => {
  const h = seedExperimental();
  h.run({mode: 'experimental', id: 'old-1'});
  h.run({mode: 'experimental', id: 'old-2'});
  const updated = h.store, record = Object.values(updated.entries)[0];
  record.ticket = state.makeEntry(state.acceptState(token(10, now + 1), experimental, now), experimental, now);
  record.ticketGeneration += 1; record.generation += 1;
  h.store = updated;
  for (const id of ['old-1', 'old-2']) h.run({mode: 'experimental', id, response: response(wrong)});
  assert.equal(Object.values(h.store.entries)[0].needsRenew, undefined);
});
test('missing response state is ignored; a matching state resets observed anomalies', () => {
  const h = seedExperimental();
  h.run({mode: 'experimental', id: 'a'}); h.run({mode: 'experimental', id: 'a', response: response(wrong)});
  h.run({mode: 'experimental', id: 'b'}); h.run({mode: 'experimental', id: 'b', response: response(null)});
  assert.equal(Object.values(h.store.entries)[0].strikes, 1);
  h.run({mode: 'experimental', id: 'c'}); h.run({mode: 'experimental', id: 'c', response: response(valid)});
  assert.equal(Object.values(h.store.entries)[0].strikes, 0);
});
test('credential rotation avoids an old credential auth cooldown', () => {
  const h = harness();
  h.run({mode: 'experimental', probe: {status: 401}});
  const run = h.run({mode: 'experimental', h: headers('turn-2', {authorization: 'Bearer new-secret'}), id: 'rotated',
    probe: {status: 200, state: valid, body: completed()}});
  assert.equal(injected(run), valid); assert.equal(h.calls, 2);
});


test('unavailable or corrupt storage preserves data and never triggers probes', () => {
  for (const failure of [{readThrows: true}, {corruptStore: true}]) {
    const h = seedExperimental(), before = JSON.stringify(h.store);
    assert.equal(injected(h.run({mode: 'experimental', ...failure})), undefined);
    assert.equal(h.calls, 0); assert.equal(JSON.stringify(h.store), before);
    h.run({mode: 'experimental', response: response(wrong), ...failure});
    assert.equal(JSON.stringify(h.store), before);
  }
});
test('a first nonmatching server state prevents mid-turn adoption of a later different shape', () => {
  const h = harness();
  h.run(); h.run({response: response(wrong)});
  h.run({id: 'second'}); h.run({id: 'second', response: response(valid)});
  assert.equal(injected(h.run({id: 'third'})), undefined);
  assert.equal(Object.values(h.store.turns)[0].phase, 'observed_only');
});
test('a different same-generation turn ticket cannot modify global candidate anomaly count', () => {
  const h = seedExperimental();
  const snapshot = h.store, record = Object.values(snapshot.entries)[0];
  record.needsRenew = true; record.nextProbeAt = now + 300; record.strikes = 2;
  h.store = snapshot;
  h.run({mode: 'experimental'});
  const older = token(10, now - 10, 1);
  h.run({mode: 'experimental', response: response(older)});
  assert.equal(injected(h.run({mode: 'experimental', id: 'older'})), older);
  h.run({mode: 'experimental', id: 'older', response: response(older)});
  assert.equal(Object.values(h.store.entries)[0].strikes, 2);
});

console.log(`${checks} groups passed`);
