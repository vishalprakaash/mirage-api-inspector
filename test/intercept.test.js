/**
 * Integration tests for content-main.js — loads the real content script into a
 * simulated page and drives fetch / XHR through it.
 * Run: node test/intercept.test.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../lib/mock-match.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATCHER = globalThis.__MirageMatch;

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

// ─── Simulated page ──────────────────────────────────────────────────────────

class ProgressEventShim extends Event {
  constructor(type, init = {}) {
    super(type);
    Object.assign(this, init);
  }
}

/** Minimal XMLHttpRequest whose open/send the content script can wrap. */
function makeXHRClass() {
  return class FakeXHR extends EventTarget {
    constructor() {
      super();
      this.responseType = '';
      this.readyState = 0;
      this.status = 0;
      this.passedThrough = false;
      this.sentPayload = undefined;
    }
    open(method, url) {
      this._method = method;
      this._url = url;
    }
    send(body) {
      this.passedThrough = true;
      this.sentPayload = body;
    }
  };
}

const CONTENT_MAIN = fs.readFileSync(path.join(__dirname, '..', 'content-main.js'), 'utf8');

/**
 * Boots a fresh page with the content script installed.
 * Returns handles for driving requests and inspecting pass-through calls.
 */
function bootPage(rules) {
  const win = new EventTarget();
  const passthrough = [];

  // Stand-in for the page's native fetch, so pass-through is observable.
  win.fetch = async (resource, init) => {
    passthrough.push({ resource, init });
    return new Response('ORIGINAL', { status: 299 });
  };

  const doc = { baseURI: 'https://app.test/' };
  const XHR = makeXHRClass();
  const sandboxGlobal = { __MirageMatch: MATCHER };

  // content-main.js reads these as free variables.
  const load = new Function(
    'window', 'document', 'XMLHttpRequest', 'ProgressEvent', 'globalThis', 'console',
    CONTENT_MAIN
  );
  load(win, doc, XHR, ProgressEventShim, sandboxGlobal, { debug() {} });

  // Deliver rules the way content-isolated.js does.
  const ev = new Event('message');
  ev.source = win;
  ev.data = { __mirage__: true, type: 'MOCK_RULES', rules };
  win.dispatchEvent(ev);

  return { win, XHR, passthrough, sandboxGlobal };
}

/** Drives one XHR and resolves once it settles (or times out as pass-through). */
function runXHR(XHR, method, url, body) {
  return new Promise((resolve) => {
    const xhr = new XHR();
    xhr.open(method, url);
    let settled = false;
    xhr.addEventListener('load', () => {
      settled = true;
      resolve({ mocked: true, xhr });
    });
    xhr.send(body);
    // A pass-through never fires 'load' here, since the stub send() is inert.
    setTimeout(() => {
      if (!settled) resolve({ mocked: false, xhr });
    }, 60);
  });
}

const mock = (over = {}) => ({
  id: 'm1', enabled: true, method: 'ANY', urlFilters: [],
  statusCode: 200, contentType: 'application/json',
  responseBody: '{"mocked":true}', delay: 0, responseHeaders: [], ...over
});

// ─── Tests ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('\nContent script bootstrap');
  {
    const { sandboxGlobal, win } = bootPage([]);
    check('matcher global cleaned off the page', sandboxGlobal.__MirageMatch, undefined);
    check('fetch was wrapped', typeof win.fetch, 'function');
    check('real matcher still intact for other tests', typeof MATCHER.bodyMatches, 'function');
  }

  console.log('fetch — URL matching');
  {
    const { win, passthrough } = bootPage([mock({ urlFilters: ['https://api.test/users'] })]);

    const res = await win.fetch('https://api.test/users');
    check('matched request is mocked', res.status, 200);
    check('mocked body returned', await res.text(), '{"mocked":true}');
    check('mock marker header set', res.headers.get('X-Mirage-Mock'), 'true');
    check('content-type applied', res.headers.get('Content-Type'), 'application/json');
    check('response.url populated', res.url, 'https://api.test/users');
    check('no pass-through for a match', passthrough.length, 0);

    const miss = await win.fetch('https://api.test/orders');
    check('unmatched request passes through', miss.status, 299);
    check('pass-through recorded', passthrough.length, 1);
  }

  console.log('fetch — multiple URL filters');
  {
    const rules = [mock({ urlFilters: ['localhost*', 'https://staging.test/api/*'] })];
    const { win, passthrough } = bootPage(rules);

    check('first pattern matches', (await win.fetch('http://localhost:5173/x')).status, 200);
    check('second pattern matches', (await win.fetch('https://staging.test/api/y')).status, 200);
    check('neither matches → passthrough', (await win.fetch('https://prod.test/api/y')).status, 299);
    check('exactly one pass-through', passthrough.length, 1);
  }

  console.log('fetch — method filter');
  {
    const { win } = bootPage([mock({ method: 'POST', urlFilters: ['https://api.test/*'] })]);
    check('POST matches', (await win.fetch('https://api.test/a', { method: 'POST' })).status, 200);
    check('GET does not', (await win.fetch('https://api.test/a')).status, 299);
  }

  console.log('fetch — payload matching');
  {
    const rules = [mock({
      method: 'POST',
      urlFilters: ['https://api.test/orders'],
      bodyMatch: { mode: 'includes', value: '"draft":true' },
      responseBody: '{"draft":"mocked"}'
    })];
    const { win } = bootPage(rules);

    const hit = await win.fetch('https://api.test/orders', { method: 'POST', body: '{"draft":true}' });
    check('payload match → mocked', await hit.text(), '{"draft":"mocked"}');

    const missBody = await win.fetch('https://api.test/orders', { method: 'POST', body: '{"draft":false}' });
    check('payload mismatch → passthrough', missBody.status, 299);

    const noBody = await win.fetch('https://api.test/orders', { method: 'POST' });
    check('missing payload → passthrough', noBody.status, 299);

    // Whitespace-insensitive fragment matching.
    const spaced = await win.fetch('https://api.test/orders', { method: 'POST', body: '{ "draft" : true }' });
    check('whitespace-insensitive payload match', spaced.status, 200);
  }

  console.log('fetch — exact payload');
  {
    const rules = [mock({
      urlFilters: ['https://api.test/exact'],
      bodyMatch: { mode: 'exact', value: '{"a":1,"b":2}' }
    })];
    const { win } = bootPage(rules);

    const reordered = await win.fetch('https://api.test/exact', { method: 'POST', body: '{"b":2,"a":1}' });
    check('key order ignored on exact', reordered.status, 200);

    const extra = await win.fetch('https://api.test/exact', { method: 'POST', body: '{"a":1,"b":2,"c":3}' });
    check('extra key rejected on exact', extra.status, 299);
  }

  console.log('fetch — Request object bodies');
  {
    const rules = [mock({
      urlFilters: ['https://api.test/req'],
      bodyMatch: { mode: 'includes', value: 'from-request' }
    })];
    const { win } = bootPage(rules);

    const req = new Request('https://api.test/req', { method: 'POST', body: '{"x":"from-request"}' });
    const res = await win.fetch(req);
    check('Request body is matched', res.status, 200);
    check('caller Request not consumed', req.bodyUsed, false);
  }

  console.log('fetch — first matching rule wins');
  {
    const rules = [
      mock({ id: 'a', urlFilters: ['https://api.test/*'], responseBody: 'FIRST' }),
      mock({ id: 'b', urlFilters: ['https://api.test/*'], responseBody: 'SECOND' })
    ];
    const { win } = bootPage(rules);
    check('earlier rule takes precedence', await (await win.fetch('https://api.test/z')).text(), 'FIRST');
  }

  console.log('fetch — disabled rules');
  {
    const { win } = bootPage([mock({ enabled: false, urlFilters: ['https://api.test/*'] })]);
    check('disabled rule ignored', (await win.fetch('https://api.test/a')).status, 299);
  }

  console.log('fetch — status codes and headers');
  {
    const rules = [mock({
      urlFilters: ['https://api.test/err'],
      statusCode: 503,
      responseHeaders: [{ id: 'r', name: 'Retry-After', value: '30' }]
    })];
    const { win } = bootPage(rules);
    const res = await win.fetch('https://api.test/err');
    check('custom status', res.status, 503);
    check('status text derived', res.statusText, 'Service Unavailable');
    check('custom response header', res.headers.get('Retry-After'), '30');
    check('response marked not-ok', res.ok, false);
  }

  console.log('fetch — 204 must carry no body');
  {
    const { win } = bootPage([mock({ urlFilters: ['https://api.test/none'], statusCode: 204, responseBody: 'ignored' })]);
    const res = await win.fetch('https://api.test/none');
    check('204 returned without throwing', res.status, 204);
    check('204 body is empty', await res.text(), '');
  }

  console.log('fetch — delay');
  {
    const { win } = bootPage([mock({ urlFilters: ['https://api.test/slow'], delay: 120 })]);
    const t0 = Date.now();
    await win.fetch('https://api.test/slow');
    check('delay honoured (>=100ms)', Date.now() - t0 >= 100, true);
  }

  console.log('XHR — basic mocking');
  {
    const { XHR } = bootPage([mock({
      urlFilters: ['https://api.test/users'],
      statusCode: 201,
      responseBody: '{"id":9}'
    })]);

    const { mocked, xhr } = await runXHR(XHR, 'GET', 'https://api.test/users');
    check('load event fired', mocked, true);
    check('readyState is DONE', xhr.readyState, 4);
    check('status applied', xhr.status, 201);
    check('statusText applied', xhr.statusText, 'Created');
    check('responseText applied', xhr.responseText, '{"id":9}');
    check('responseURL applied', xhr.responseURL, 'https://api.test/users');
    check('original send not called', xhr.passedThrough, false);
    check('getResponseHeader works', xhr.getResponseHeader('content-type'), 'application/json');
    check('unknown header → null', xhr.getResponseHeader('X-Nope'), null);
    check('getAllResponseHeaders includes marker',
      xhr.getAllResponseHeaders().includes('X-Mirage-Mock: true'), true);
  }

  console.log('XHR — pass-through');
  {
    const { XHR } = bootPage([mock({ urlFilters: ['https://api.test/users'] })]);
    const { mocked, xhr } = await runXHR(XHR, 'GET', 'https://api.test/other');
    check('unmatched XHR not mocked', mocked, false);
    check('original send called', xhr.passedThrough, true);
  }

  console.log('XHR — relative URL resolution');
  {
    const { XHR } = bootPage([mock({ urlFilters: ['https://app.test/api/*'] })]);
    const { mocked } = await runXHR(XHR, 'GET', '/api/thing');
    check('relative URL resolved against baseURI', mocked, true);
  }

  console.log('XHR — payload matching');
  {
    const { XHR } = bootPage([mock({
      method: 'POST',
      urlFilters: ['https://api.test/orders'],
      bodyMatch: { mode: 'includes', value: 'action=delete' }
    })]);

    const hit = await runXHR(XHR, 'POST', 'https://api.test/orders', 'id=3&action=delete');
    check('XHR payload match → mocked', hit.mocked, true);

    const miss = await runXHR(XHR, 'POST', 'https://api.test/orders', 'id=3&action=create');
    check('XHR payload mismatch → passthrough', miss.mocked, false);
  }

  console.log('XHR — responseType handling');
  {
    const { XHR } = bootPage([mock({ urlFilters: ['https://api.test/j'], responseBody: '{"n":5}' })]);

    const xhr = new XHR();
    xhr.responseType = 'json';
    xhr.open('GET', 'https://api.test/j');
    await new Promise((r) => {
      xhr.addEventListener('load', r);
      xhr.send();
    });
    check('json responseType parsed', xhr.response, { n: 5 });
    check('responseText empty for json type', xhr.responseText, '');
  }

  console.log('XHR — listeners fire exactly once');
  {
    const { XHR } = bootPage([mock({ urlFilters: ['https://api.test/once'] })]);
    let loadCount = 0;
    let readyCount = 0;

    const xhr = new XHR();
    xhr.open('GET', 'https://api.test/once');
    xhr.onload = () => loadCount++;
    xhr.addEventListener('load', () => loadCount++);
    xhr.addEventListener('readystatechange', () => readyCount++);
    xhr.send();
    await new Promise((r) => setTimeout(r, 40));

    // onload is a plain property on the stub, so only the listener counts here;
    // the guard is that neither fires twice.
    check('load fired once per listener', loadCount, 1);
    check('readystatechange fired once', readyCount, 1);
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
