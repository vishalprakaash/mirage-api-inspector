/**
 * Tests for background.js message handling — in particular that hit counters
 * reset when a switch is flipped.
 * Run: node test/background.test.js
 */

const store = {};
let messageHandler = null;
const pushedToTabs = [];

globalThis.chrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: null,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { messageHandler = fn; } }
  },
  storage: {
    local: {
      get(key, cb) { cb({ [key]: store[key] }); },
      set(obj, cb) { Object.assign(store, obj); cb && cb(); }
    }
  },
  declarativeNetRequest: {
    async getDynamicRules() { return []; },
    async updateDynamicRules() {}
  },
  tabs: {
    async query() { return [{ id: 1 }]; },
    sendMessage(_id, msg) { pushedToTabs.push(msg); return Promise.resolve(); }
  },
  webNavigation: { onCommitted: { addListener() {} } },
  action: {
    async setBadgeBackgroundColor() {},
    async setBadgeText() {},
    async setTitle() {}
  }
};

await import('../background.js');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    failures.push(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
  }
}

const send = (msg) => new Promise((resolve) => messageHandler(msg, {}, resolve));
const hitsNow = async () => (await send({ type: 'GET_HITS' })).hits;

async function makeMock(profileId, id, enabled = true) {
  const rule = {
    id, profileId, enabled, name: id, urlFilters: ['localhost*'],
    method: 'ANY', statusCode: 200, contentType: 'application/json',
    responseBody: '{}', delay: 0, bodyMatch: { mode: 'any', value: '' },
    responseHeaders: []
  };
  await send({ type: 'UPSERT_MOCK_RULE', rule });
  return rule;
}

(async () => {
  const { state } = await send({ type: 'GET_STATE' });
  const profileId = state.activeProfileId;

  console.log('\nRecording hits');

  const a = await makeMock(profileId, 'mock-a');
  const b = await makeMock(profileId, 'mock-b');

  for (let i = 0; i < 5; i++) await send({ type: 'MOCK_HIT', ruleId: 'mock-a' });
  await send({ type: 'MOCK_HIT', ruleId: 'mock-b' });

  check('hits recorded per rule', await hitsNow(), { 'mock-a': 5, 'mock-b': 1 });

  console.log('Reset on per-mock toggle');

  // Turning one mock off clears that mock's counter and leaves the other alone.
  await send({ type: 'UPSERT_MOCK_RULE', rule: { ...a, enabled: false } });
  check('toggled mock cleared', (await hitsNow())['mock-a'], undefined);
  check('other mock untouched', (await hitsNow())['mock-b'], 1);

  // Turning it back on also starts from zero.
  await send({ type: 'MOCK_HIT', ruleId: 'mock-a' });
  check('counting resumes after re-enable', (await hitsNow())['mock-a'], 1);
  await send({ type: 'UPSERT_MOCK_RULE', rule: { ...a, enabled: true } });
  check('re-enabling also resets', (await hitsNow())['mock-a'], undefined);

  console.log('Edits must not reset');

  await send({ type: 'MOCK_HIT', ruleId: 'mock-a' });
  await send({ type: 'MOCK_HIT', ruleId: 'mock-a' });
  await send({ type: 'UPSERT_MOCK_RULE', rule: { ...a, enabled: true, responseBody: '{"changed":1}' } });
  check('editing a rule keeps its count', (await hitsNow())['mock-a'], 2);

  await send({ type: 'UPSERT_MOCK_RULE', rule: { ...a, enabled: true, urlFilters: ['127.0.0.1*'] } });
  check('changing url filters keeps its count', (await hitsNow())['mock-a'], 2);

  console.log('Reset on profile toggle');

  await send({ type: 'MOCK_HIT', ruleId: 'mock-b' });
  check('counts present before profile toggle',
    Object.keys(await hitsNow()).sort(), ['mock-a', 'mock-b']);

  await send({ type: 'UPDATE_PROFILE', profileId, changes: { enabled: false } });
  check('profile toggle clears every mock in it', await hitsNow(), {});

  console.log('Profile rename must not reset');

  await send({ type: 'UPDATE_PROFILE', profileId, changes: { enabled: true } });
  await send({ type: 'MOCK_HIT', ruleId: 'mock-a' });
  await send({ type: 'UPDATE_PROFILE', profileId, changes: { name: 'Renamed' } });
  check('renaming a profile keeps counts', (await hitsNow())['mock-a'], 1);

  console.log('Reset on global toggle');

  await send({ type: 'MOCK_HIT', ruleId: 'mock-b' });
  check('counts present before global toggle',
    Object.keys(await hitsNow()).sort(), ['mock-a', 'mock-b']);

  await send({ type: 'SET_GLOBAL_ENABLED', enabled: false });
  check('global off clears everything', await hitsNow(), {});

  await send({ type: 'SET_GLOBAL_ENABLED', enabled: true });
  await send({ type: 'MOCK_HIT', ruleId: 'mock-a' });
  check('counting resumes after global on', (await hitsNow())['mock-a'], 1);
  await send({ type: 'SET_GLOBAL_ENABLED', enabled: true });
  check('global toggle clears even when already on', await hitsNow(), {});

  console.log('Header rules are never counted');

  await send({
    type: 'UPSERT_HEADER_RULE',
    rule: {
      id: 'hdr-1', profileId, enabled: true, name: 'H', urlFilters: [],
      headers: [{ id: 'x', type: 'request', operation: 'set', name: 'X-A', value: '1', enabled: true }]
    }
  });
  await send({ type: 'UPSERT_HEADER_RULE', rule: {
    id: 'hdr-1', profileId, enabled: false, name: 'H', urlFilters: [], headers: []
  } });
  check('no counter appears for header rules', (await hitsNow())['hdr-1'], undefined);

  console.log('Deleting a rule drops its counter');

  await send({ type: 'MOCK_HIT', ruleId: 'mock-b' });
  check('count exists before delete', (await hitsNow())['mock-b'], 1);
  await send({ type: 'DELETE_MOCK_RULE', ruleId: 'mock-b' });
  check('deleted rule counter pruned', (await hitsNow())['mock-b'], undefined);

  console.log('Reset writes to storage so the popup sees it');

  await send({ type: 'MOCK_HIT', ruleId: 'mock-a' });
  await send({ type: 'GET_HITS' }); // force flush
  check('storage holds the count before reset', store.__mirage_hits__['mock-a'], 1);
  await send({ type: 'SET_GLOBAL_ENABLED', enabled: false });
  check('storage reflects the reset', store.__mirage_hits__, {});

  console.log('Resetting handlers return the fresh counts');

  // The popup updates from these replies, so a reset shows even if the
  // storage-change event never reaches it.
  await send({ type: 'SET_GLOBAL_ENABLED', enabled: true });
  await send({ type: 'MOCK_HIT', ruleId: 'mock-a' });

  const globalRes = await send({ type: 'SET_GLOBAL_ENABLED', enabled: false });
  check('global toggle replies with hits', globalRes.hits, {});

  await send({ type: 'SET_GLOBAL_ENABLED', enabled: true });
  await send({ type: 'MOCK_HIT', ruleId: 'mock-a' });
  const mockRes = await send({ type: 'UPSERT_MOCK_RULE', rule: { ...a, enabled: false } });
  check('mock toggle replies with hits', mockRes.hits, {});

  await send({ type: 'UPSERT_MOCK_RULE', rule: { ...a, enabled: true } });
  await send({ type: 'MOCK_HIT', ruleId: 'mock-a' });
  const profRes = await send({ type: 'UPDATE_PROFILE', profileId, changes: { enabled: false } });
  check('profile toggle replies with hits', profRes.hits, {});

  // An edit that does not flip the switch must report the count unchanged.
  await send({ type: 'UPDATE_PROFILE', profileId, changes: { enabled: true } });
  await send({ type: 'MOCK_HIT', ruleId: 'mock-a' });
  const editRes = await send({ type: 'UPSERT_MOCK_RULE', rule: { ...a, enabled: true, delay: 50 } });
  check('edit replies with the surviving count', editRes.hits['mock-a'], 1);

  console.log('\n' + '─'.repeat(52));
  if (fail > 0) {
    console.log('\nFailures:');
    console.log(failures.join('\n'));
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
