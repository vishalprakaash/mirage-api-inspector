/**
 * Tests for declarativeNetRequest rule construction (lib/dnr-rules.js).
 * Run: node test/dnr.test.js
 */

import {
  buildDeclarativeRules,
  buildCondition,
  patternToDeclarativeFilter,
  rulePatterns
} from '../lib/dnr-rules.js';

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

const PROFILE = 'p1';

const hdr = (over = {}) => ({
  id: 'h1', profileId: PROFILE, enabled: true, name: 'R',
  urlFilters: [], headers: [], ...over
});

const reqHeader = { id: 'a', type: 'request', operation: 'set', name: 'Authorization', value: 'Bearer t', enabled: true };
const resHeader = { id: 'b', type: 'response', operation: 'set', name: 'X-Env', value: 'dev', enabled: true };

console.log('\nURL fan-out');

// One pattern, request headers only → one rule.
let out = buildDeclarativeRules([hdr({ urlFilters: ['localhost*'], headers: [reqHeader] })], PROFILE);
check('single url, request only → 1 rule', out.length, 1);
check('carries request header', out[0].action.requestHeaders[0].header, 'Authorization');

// Three patterns → three rules, one per pattern.
out = buildDeclarativeRules(
  [hdr({ urlFilters: ['localhost*', 'https://a.dev/*', 'https://b.dev/*'], headers: [reqHeader] })],
  PROFILE
);
check('three urls → 3 rules', out.length, 3);
check('rule ids are unique', new Set(out.map((r) => r.id)).size, 3);
check('every rule has a condition', out.every((r) => !!r.condition), true);

// Two patterns x (request + response) → four rules.
out = buildDeclarativeRules(
  [hdr({ urlFilters: ['localhost*', 'https://a.dev/*'], headers: [reqHeader, resHeader] })],
  PROFILE
);
check('2 urls x 2 directions → 4 rules', out.length, 4);
check('ids unique across fan-out', new Set(out.map((r) => r.id)).size, 4);
check('two request-header rules', out.filter((r) => r.action.requestHeaders).length, 2);
check('two response-header rules', out.filter((r) => r.action.responseHeaders).length, 2);

// No patterns → one catch-all rule.
out = buildDeclarativeRules([hdr({ urlFilters: [], headers: [reqHeader] })], PROFILE);
check('no urls → 1 catch-all rule', out.length, 1);
check('catch-all has no url filter',
  'urlFilter' in out[0].condition || 'regexFilter' in out[0].condition, false);

// Blank entries must not create bogus rules.
out = buildDeclarativeRules([hdr({ urlFilters: ['', '  ', 'localhost*'], headers: [reqHeader] })], PROFILE);
check('blank urls ignored → 1 rule', out.length, 1);

console.log('Rule id uniqueness across multiple rules');

out = buildDeclarativeRules(
  [
    hdr({ id: 'h1', urlFilters: ['localhost*', 'https://a.dev/*'], headers: [reqHeader, resHeader] }),
    hdr({ id: 'h2', urlFilters: ['https://b.dev/*'], headers: [reqHeader] }),
    hdr({ id: 'h3', urlFilters: [], headers: [resHeader] })
  ],
  PROFILE
);
check('total rules across 3 header rules', out.length, 4 + 1 + 1);
check('all ids unique', new Set(out.map((r) => r.id)).size, out.length);
check('ids are positive integers', out.every((r) => Number.isInteger(r.id) && r.id > 0), true);

console.log('Filtering');

check('other profile excluded',
  buildDeclarativeRules([hdr({ profileId: 'other', headers: [reqHeader] })], PROFILE).length, 0);
check('disabled rule excluded',
  buildDeclarativeRules([hdr({ enabled: false, headers: [reqHeader] })], PROFILE).length, 0);
check('disabled header excluded',
  buildDeclarativeRules([hdr({ headers: [{ ...reqHeader, enabled: false }] })], PROFILE).length, 0);
check('nameless header excluded',
  buildDeclarativeRules([hdr({ headers: [{ ...reqHeader, name: '' }] })], PROFILE).length, 0);
check('whitespace-only name excluded',
  buildDeclarativeRules([hdr({ headers: [{ ...reqHeader, name: '   ' }] })], PROFILE).length, 0);
check('rule with no headers excluded',
  buildDeclarativeRules([hdr({ headers: [] })], PROFILE).length, 0);
check('missing headers array is safe',
  buildDeclarativeRules([hdr({ headers: undefined })], PROFILE).length, 0);
check('empty input is safe', buildDeclarativeRules([], PROFILE).length, 0);
check('undefined input is safe', buildDeclarativeRules(undefined, PROFILE).length, 0);

console.log('Header operations');

const opOf = (operation) =>
  buildDeclarativeRules([hdr({ urlFilters: [], headers: [{ ...reqHeader, operation }] })], PROFILE)[0]
    .action.requestHeaders[0];

check('set carries value', opOf('set'), { header: 'Authorization', operation: 'set', value: 'Bearer t' });
check('append carries value', opOf('append'), { header: 'Authorization', operation: 'append', value: 'Bearer t' });
check('remove omits value', opOf('remove'), { header: 'Authorization', operation: 'remove' });

// A header with no explicit type is treated as a request header.
out = buildDeclarativeRules(
  [hdr({ headers: [{ id: 'c', name: 'X-A', value: '1', enabled: true }] })], PROFILE
);
check('untyped header defaults to request', !!out[0].action.requestHeaders, true);

console.log('Conditions');

check('no filter → resourceTypes only', Object.keys(buildCondition('')).sort(), ['resourceTypes']);
check('wildcard → resourceTypes only', Object.keys(buildCondition('*')).sort(), ['resourceTypes']);
check('localhost* uses a regex filter', 'regexFilter' in buildCondition('localhost*'), true);
check('no invalid "fetch" resource type',
  buildCondition('').resourceTypes.includes('fetch'), false);
check('covers xmlhttprequest',
  buildCondition('').resourceTypes.includes('xmlhttprequest'), true);

// Each rule must get its own resourceTypes array, never a shared reference.
out = buildDeclarativeRules([hdr({ urlFilters: ['a.dev/*', 'b.dev/*'], headers: [reqHeader] })], PROFILE);
check('conditions do not share array identity',
  out[0].condition.resourceTypes === out[1].condition.resourceTypes, false);

console.log('Pattern → DNR filter');

check('empty → no filter', patternToDeclarativeFilter(''), {});
check('wildcard → no filter', patternToDeclarativeFilter('*'), {});
check('whitespace → no filter', patternToDeclarativeFilter('   '), {});
check('undefined → no filter', patternToDeclarativeFilter(undefined), {});

check('plain host uses urlFilter',
  patternToDeclarativeFilter('https://api.acme.dev/*'),
  { urlFilter: 'https://api.acme.dev/*', isUrlFilterCaseSensitive: false });

check('localhost shorthand uses regexFilter',
  patternToDeclarativeFilter('localhost*').regexFilter,
  '^https?://localhost(:\\d+)?([/?#].*)?$');

check('explicit port uses regexFilter',
  'regexFilter' in patternToDeclarativeFilter('https://acme.dev:8443/api/*'), true);

check('regex metacharacters are escaped',
  patternToDeclarativeFilter('http://localhost:3000/a.b').regexFilter,
  '^http://localhost:3000/a\\.b');

check('star becomes .* in regex form',
  patternToDeclarativeFilter('http://localhost:3000/*').regexFilter,
  '^http://localhost:3000/.*');

// The generated localhost regex must behave like the mock-side matcher.
{
  const re = new RegExp(patternToDeclarativeFilter('localhost*').regexFilter, 'i');
  check('DNR localhost regex: bare host', re.test('http://localhost'), true);
  check('DNR localhost regex: with port', re.test('http://localhost:3000'), true);
  check('DNR localhost regex: port + path', re.test('https://localhost:8443/a/b'), true);
  check('DNR localhost regex: query without path', re.test('http://localhost:3000?q=1'), true);
  check('DNR localhost regex: rejects lookalike host', re.test('https://localhost.evil.com/'), false);
  check('DNR localhost regex: rejects substring host', re.test('https://notlocalhost.dev/'), false);
}

console.log('Legacy shape');

check('legacy urlFilter string still works',
  buildDeclarativeRules([{ id: 'x', profileId: PROFILE, enabled: true, urlFilter: 'localhost*', headers: [reqHeader] }], PROFILE).length, 1);
check('rulePatterns reads legacy field', rulePatterns({ urlFilter: 'localhost*' }), ['localhost*']);
check('rulePatterns drops blanks', rulePatterns({ urlFilters: ['a', '', '  ', 'b'] }), ['a', 'b']);

console.log('\n' + '─'.repeat(52));
if (fail > 0) {
  console.log('\nFailures:');
  console.log(failures.join('\n'));
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
