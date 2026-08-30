/**
 * Tests for the hit counter store (lib/hits.js).
 * Run: node test/hits.test.js
 */

// chrome.storage.local stub, capturing writes so coalescing can be observed.
const store = {};
let writes = 0;

globalThis.chrome = {
  storage: {
    local: {
      get(key, cb) { cb({ [key]: store[key] }); },
      set(obj, cb) {
        writes++;
        Object.assign(store, obj);
        cb && cb();
      }
    }
  }
};

const { HITS_KEY, recordHit, getHits, resetHits, pruneHits, flushHits } =
  await import('../lib/hits.js');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\nCounting');

  await recordHit('rule-a');
  await recordHit('rule-a');
  await recordHit('rule-b');

  check('counts accumulate per rule', await getHits(), { 'rule-a': 2, 'rule-b': 1 });

  await recordHit('rule-a', 5);
  check('explicit amount added', (await getHits())['rule-a'], 7);

  console.log('Guards');

  const before = await getHits();
  await recordHit(null);
  await recordHit(undefined);
  await recordHit('');
  check('falsy rule ids ignored', await getHits(), before);

  console.log('Persistence');

  await flushHits();
  check('written under the expected key', store[HITS_KEY]['rule-a'], 7);
  check('storage matches in-memory', store[HITS_KEY], await getHits());

  console.log('Write coalescing');

  // A burst of hits must not produce a write per hit.
  writes = 0;
  for (let i = 0; i < 50; i++) await recordHit('burst');
  const writesDuringBurst = writes;
  await sleep(600); // let the coalescing timer fire
  const writesAfterFlush = writes;

  check('burst does not write per hit', writesDuringBurst === 0, true);
  check('coalesced into a single write', writesAfterFlush, 1);
  check('every hit in the burst counted', (await getHits()).burst, 50);

  console.log('getHits flushes pending work');

  writes = 0;
  await recordHit('pending');
  const snapshot = await getHits();
  check('pending hit visible to reader', snapshot.pending, 1);
  check('reading forced a flush', store[HITS_KEY].pending, 1);

  console.log('Snapshot isolation');

  const snap = await getHits();
  snap['rule-a'] = 9999;
  check('returned object is a copy', (await getHits())['rule-a'], 7);

  console.log('Pruning');

  await pruneHits(new Set(['rule-a', 'burst']));
  const pruned = await getHits();
  check('kept live rules', Object.keys(pruned).sort(), ['burst', 'rule-a']);
  check('dropped deleted rules', pruned['rule-b'], undefined);
  check('prune persisted', store[HITS_KEY]['rule-b'], undefined);

  console.log('Reset');

  await resetHits(['rule-a']);
  check('selective reset clears one', (await getHits())['rule-a'], undefined);
  check('selective reset keeps others', (await getHits()).burst, 50);

  await resetHits();
  check('full reset empties everything', await getHits(), {});
  check('full reset persisted', store[HITS_KEY], {});

  console.log('Recovery after reset');

  await recordHit('after-reset');
  check('counting resumes', (await getHits())['after-reset'], 1);

  console.log('\n' + '─'.repeat(52));
  if (fail > 0) {
    console.log('\nFailures:');
    console.log(failures.join('\n'));
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
