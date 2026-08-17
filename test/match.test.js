/**
 * Tests for the Mirage matching engine (lib/mock-match.js).
 * Run: node test/match.test.js
 */

// mock-match.js is a classic script for the MAIN world; importing it for its
// side effect publishes the same API the content script picks up.
import '../lib/mock-match.js';
const M = globalThis.__MirageMatch;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    failures.push(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function group(title) {
  console.log('\n' + title);
}

// ─── Single-pattern URL matching ─────────────────────────────────────────────

group('URL patterns');

const urlCases = [
  ['http://localhost:3000/api/users', 'localhost*', true],
  ['http://localhost/api', 'localhost*', true],
  ['https://localhost:8443/deep/path?q=1', 'localhost*', true],
  ['http://localhost:3000', 'localhost*', true],
  ['https://notlocalhost.com/x', 'localhost*', false],
  ['https://evil.com/localhost', 'localhost*', false],
  ['https://localhost.attacker.com/', 'localhost*', false],
  ['https://api.example.com/users', 'https://api.example.com/*', true],
  ['https://api.example.com/users?page=2', 'https://api.example.com/*', true],
  ['https://other.com/users', 'https://api.example.com/*', false],
  ['https://api.example.com/users', 'api.example.com/*', true],
  ['http://api.example.com/users', 'api.example.com/*', true],
  ['https://api.example.com/users/42', '*/users/*', true],
  ['https://api.example.com/v1/orders', 'https://api.example.com/v1/orders', true],
  ['https://api.example.com/v1/orders/9', 'https://api.example.com/v1/orders', false],
  ['https://api.example.com/x', '', true],
  ['https://api.example.com/x', '*', true],
];

for (const [url, pattern, expected] of urlCases) {
  check(`matchesPattern(${url}, ${pattern || '<empty>'})`, M.matchesPattern(url, pattern), expected);
}

// ─── Multi-pattern URL matching ──────────────────────────────────────────────

group('Multiple URL filters');

const multi = ['localhost*', 'https://staging.acme.com/api/*'];

check('matches first pattern', M.matchesAnyPattern('http://localhost:5173/api/me', multi), true);
check('matches second pattern', M.matchesAnyPattern('https://staging.acme.com/api/orders', multi), true);
check('matches neither', M.matchesAnyPattern('https://prod.acme.com/api/orders', multi), false);
check('empty list matches all', M.matchesAnyPattern('https://anything.dev/x', []), true);
check('blank entries ignored', M.matchesAnyPattern('https://anything.dev/x', ['', '   ']), true);
check('blank entry alongside real one', M.matchesAnyPattern('https://prod.acme.com/x', ['', 'localhost*']), false);

check('rulePatterns reads array', M.rulePatterns({ urlFilters: ['a', '', 'b'] }), ['a', 'b']);
check('rulePatterns migrates legacy string', M.rulePatterns({ urlFilter: 'localhost*' }), ['localhost*']);
check('rulePatterns on bare rule', M.rulePatterns({}), []);

// ─── Payload: exact ──────────────────────────────────────────────────────────

group('Payload — exact');

const exact = (value) => ({ enabled: true, bodyMatch: { mode: 'exact', value } });

check('identical json', M.bodyMatches(exact('{"id":1}'), '{"id":1}'), true);
check('key order ignored',
  M.bodyMatches(exact('{"a":1,"b":2}'), '{"b":2,"a":1}'), true);
check('formatting ignored',
  M.bodyMatches(exact('{"a":1}'), '{\n  "a": 1\n}'), true);
check('nested structural equality',
  M.bodyMatches(exact('{"u":{"id":7,"tags":["x","y"]}}'), '{"u":{"tags":["x","y"],"id":7}}'), true);
check('array order still matters',
  M.bodyMatches(exact('{"t":["x","y"]}'), '{"t":["y","x"]}'), false);
check('different value fails', M.bodyMatches(exact('{"id":1}'), '{"id":2}'), false);
check('extra key fails', M.bodyMatches(exact('{"id":1}'), '{"id":1,"x":0}'), false);
check('plain text exact', M.bodyMatches(exact('hello'), 'hello'), true);
check('plain text trimmed', M.bodyMatches(exact('hello'), '  hello  '), true);
check('plain text mismatch', M.bodyMatches(exact('hello'), 'hello world'), false);
check('empty body vs required payload', M.bodyMatches(exact('{"id":1}'), ''), false);
check('number vs string not equal', M.bodyMatches(exact('{"id":1}'), '{"id":"1"}'), false);
check('null handled', M.bodyMatches(exact('{"a":null}'), '{"a":null}'), true);

// ─── Payload: includes ───────────────────────────────────────────────────────

group('Payload — includes');

const inc = (value) => ({ enabled: true, bodyMatch: { mode: 'includes', value } });

check('substring present', M.bodyMatches(inc('userId'), '{"userId":42,"n":"a"}'), true);
check('substring absent', M.bodyMatches(inc('orgId'), '{"userId":42}'), false);
check('whitespace-insensitive json fragment',
  M.bodyMatches(inc('"userId": 42'), '{"userId":42}'), true);
check('whitespace-insensitive reverse',
  M.bodyMatches(inc('"userId":42'), '{ "userId": 42 }'), true);
check('form-encoded fragment', M.bodyMatches(inc('action=delete'), 'id=3&action=delete'), true);
check('empty body', M.bodyMatches(inc('x'), ''), false);

// ─── Payload: any / disabled ─────────────────────────────────────────────────

group('Payload — any');

check('mode any always matches', M.bodyMatches({ bodyMatch: { mode: 'any', value: '' } }, 'anything'), true);
check('no bodyMatch always matches', M.bodyMatches({}, 'anything'), true);
check('blank value disables matcher', M.bodyMatches({ bodyMatch: { mode: 'exact', value: '  ' } }, 'zzz'), true);

check('ruleNeedsBody false for any', M.ruleNeedsBody({ bodyMatch: { mode: 'any', value: 'x' } }), false);
check('ruleNeedsBody false for blank', M.ruleNeedsBody({ bodyMatch: { mode: 'exact', value: '' } }), false);
check('ruleNeedsBody true when set', M.ruleNeedsBody({ bodyMatch: { mode: 'exact', value: '{}' } }), true);
check('ruleNeedsBody false when absent', M.ruleNeedsBody({}), false);

// ─── Combined URL + method + payload ─────────────────────────────────────────

group('Combined matching');

const rule = {
  enabled: true,
  method: 'POST',
  urlFilters: ['localhost*', 'https://api.acme.com/orders'],
  bodyMatch: { mode: 'includes', value: '"draft":true' }
};

check('all three match',
  M.ruleMatches(rule, 'http://localhost:3000/orders', 'POST', '{"draft":true}'), true);
check('second url matches',
  M.ruleMatches(rule, 'https://api.acme.com/orders', 'POST', '{"draft":true}'), true);
check('wrong method',
  M.ruleMatches(rule, 'http://localhost:3000/orders', 'GET', '{"draft":true}'), false);
check('wrong url',
  M.ruleMatches(rule, 'https://prod.acme.com/orders', 'POST', '{"draft":true}'), false);
check('payload absent',
  M.ruleMatches(rule, 'http://localhost:3000/orders', 'POST', '{"draft":false}'), false);
check('disabled rule never matches',
  M.ruleMatches({ ...rule, enabled: false }, 'http://localhost:3000/orders', 'POST', '{"draft":true}'), false);

check('ANY method matches anything',
  M.methodMatches({ method: 'ANY' }, 'DELETE'), true);
check('missing method matches anything',
  M.methodMatches({}, 'DELETE'), true);
check('method is case-insensitive on input',
  M.methodMatches({ method: 'POST' }, 'post'), true);

// ─── candidateRules narrowing ────────────────────────────────────────────────

group('candidateRules');

const rules = [
  { id: 'a', enabled: true, method: 'GET', urlFilters: ['localhost*'] },
  { id: 'b', enabled: true, method: 'POST', urlFilters: ['localhost*'] },
  { id: 'c', enabled: false, method: 'GET', urlFilters: ['localhost*'] },
  { id: 'd', enabled: true, method: 'ANY', urlFilters: ['https://api.acme.com/*'] }
];

check('narrows by method and url',
  M.candidateRules(rules, 'http://localhost:3000/x', 'GET').map((r) => r.id), ['a']);
check('skips disabled',
  M.candidateRules(rules, 'http://localhost:3000/x', 'POST').map((r) => r.id), ['b']);
check('other host',
  M.candidateRules(rules, 'https://api.acme.com/v1', 'DELETE').map((r) => r.id), ['d']);
check('no match',
  M.candidateRules(rules, 'https://nope.dev/x', 'GET').map((r) => r.id), []);

// ─── Body serialisation ──────────────────────────────────────────────────────

group('Body serialisation');

check('string passthrough', M.bodyToTextSync('raw'), 'raw');
check('null → empty', M.bodyToTextSync(null), '');
check('undefined → empty', M.bodyToTextSync(undefined), '');
check('URLSearchParams', M.bodyToTextSync(new URLSearchParams({ a: '1', b: '2' })), 'a=1&b=2');
check('Uint8Array decoded', M.bodyToTextSync(new TextEncoder().encode('{"x":1}')), '{"x":1}');
check('ArrayBuffer decoded', M.bodyToTextSync(new TextEncoder().encode('hey').buffer), 'hey');

const fd = new FormData();
fd.append('name', 'ada');
fd.append('role', 'admin');
check('FormData serialised', M.bodyToTextSync(fd), 'name=ada&role=admin');

// ─── Async body extraction ───────────────────────────────────────────────────

(async () => {
  group('Async body extraction');

  check('init.body string', await M.extractFetchBody('https://x.dev', { body: '{"a":1}' }), '{"a":1}');
  check('no body', await M.extractFetchBody('https://x.dev', {}), '');
  check('no init at all', await M.extractFetchBody('https://x.dev', undefined), '');
  check('blob body', await M.bodyToTextAsync(new Blob(['{"b":2}'])), '{"b":2}');

  if (typeof Request !== 'undefined') {
    const req = new Request('https://x.dev/api', { method: 'POST', body: '{"from":"request"}' });
    check('Request body read', await M.extractFetchBody(req, undefined), '{"from":"request"}');
    check('original Request not consumed', req.bodyUsed, false);

    const req2 = new Request('https://x.dev/api', { method: 'POST', body: '{"ignored":true}' });
    check('init.body wins over Request body',
      await M.extractFetchBody(req2, { body: '{"wins":true}' }), '{"wins":true}');
  }

  // ─── Report ────────────────────────────────────────────────────────────────

  console.log('\n' + '─'.repeat(52));
  if (fail > 0) {
    console.log('\nFailures:');
    console.log(failures.join('\n'));
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
