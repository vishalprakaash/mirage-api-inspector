/**
 * Mirage — MAIN World Content Script
 *
 * Intercepts window.fetch and XMLHttpRequest to return mocked responses.
 * Receives mock rules from the isolated world via postMessage.
 * Runs at document_start in the page's own JavaScript context.
 *
 * Matching logic lives in lib/mock-match.js, which the manifest loads
 * immediately before this file in the same world.
 */

(function () {
  'use strict';

  // Take the matcher off the page global and remove the global itself, so the
  // page is left exactly as we found it.
  const M = globalThis.__MirageMatch;
  try {
    delete globalThis.__MirageMatch;
  } catch {
    globalThis.__MirageMatch = undefined;
  }

  if (!M) return; // matcher failed to load; leave the page untouched

  /** Active rules: { id, urlFilters[], method, bodyMatch, statusCode, ... } */
  let mockRules = [];

  // ─── Receive rules from isolated world ─────────────────────────────────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.__mirage__ !== true) return;
    if (event.data.type === 'MOCK_RULES') {
      mockRules = Array.isArray(event.data.rules) ? event.data.rules : [];
    }
  });

  window.dispatchEvent(new Event('__mirage_request_rules__'));

  // ─── Response construction ─────────────────────────────────────────────────

  const STATUS_TEXT = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 409: 'Conflict', 418: "I'm a Teapot",
    422: 'Unprocessable Entity', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout'
  };

  function statusText(code) {
    return STATUS_TEXT[code] || '';
  }

  function mockHeaders(rule) {
    const out = { 'Content-Type': rule.contentType || 'application/json', 'X-Mirage-Mock': 'true' };
    for (const h of rule.responseHeaders || []) {
      if (h && h.name) out[h.name] = h.value || '';
    }
    return out;
  }

  function buildResponse(rule, url) {
    const status = rule.statusCode || 200;
    const headers = new Headers(mockHeaders(rule));

    // 204/304 must not carry a body, or the Response constructor throws.
    const body = status === 204 || status === 304 ? null : (rule.responseBody || '');

    const response = new Response(body, { status, statusText: statusText(status), headers });

    // fetch() consumers read `response.url`; it is empty on a constructed Response.
    try {
      Object.defineProperty(response, 'url', { value: url, configurable: true });
    } catch {
      /* non-fatal */
    }

    return response;
  }

  function sleep(ms) {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  function logMock(label, method, url, rule) {
    const payloadNote = M.ruleNeedsBody(rule) ? ` [payload ${rule.bodyMatch.mode}]` : '';
    console.debug(
      `%c[Mirage]%c ${label} ${method} ${url} → ${rule.statusCode || 200}${payloadNote}`,
      'color:#7c3aed;font-weight:bold',
      'color:inherit'
    );
  }

  /**
   * Picks the rule to apply. Reads the request body only when some candidate
   * actually matches on payload, so ordinary traffic is untouched.
   */
  async function resolveRuleAsync(url, method, resource, init) {
    const candidates = M.candidateRules(mockRules, url, method);
    if (candidates.length === 0) return null;

    if (!candidates.some(M.ruleNeedsBody)) return candidates[0];

    const bodyText = await M.extractFetchBody(resource, init);
    return candidates.find((r) => M.bodyMatches(r, bodyText)) || null;
  }

  // ─── fetch ─────────────────────────────────────────────────────────────────

  const _originalFetch = window.fetch;

  window.fetch = async function fetch(resource, init) {
    let rule = null;
    let url = '';
    let method = 'GET';

    // Never let a matcher failure break the page's own networking.
    try {
      const isRequest = typeof Request !== 'undefined' && resource instanceof Request;
      url = isRequest ? resource.url : String(resource);
      method = String((isRequest ? resource.method : init && init.method) || 'GET').toUpperCase();
      rule = await resolveRuleAsync(url, method, resource, init);
    } catch (err) {
      console.debug('[Mirage] matcher error, passing request through:', err);
      rule = null;
    }

    if (!rule) return _originalFetch.call(this, resource, init);

    await sleep(rule.delay || 0);
    logMock('fetch', method, url, rule);
    return buildResponse(rule, url);
  };

  // ─── XMLHttpRequest ────────────────────────────────────────────────────────

  const _originalOpen = XMLHttpRequest.prototype.open;
  const _originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function open(method, url) {
    this.__mirageMethod = String(method || 'GET').toUpperCase();
    try {
      // Resolve against the document so relative URLs match patterns correctly.
      this.__mirageUrl = new URL(String(url), document.baseURI).href;
    } catch {
      this.__mirageUrl = String(url);
    }
    return _originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function send(body) {
    let rule = null;

    try {
      const candidates = M.candidateRules(mockRules, this.__mirageUrl, this.__mirageMethod);
      if (candidates.length > 0) {
        if (candidates.some(M.ruleNeedsBody)) {
          const bodyText = M.bodyToTextSync(body);
          rule = candidates.find((r) => M.bodyMatches(r, bodyText)) || null;
        } else {
          rule = candidates[0];
        }
      }
    } catch (err) {
      console.debug('[Mirage] matcher error, passing request through:', err);
      rule = null;
    }

    if (!rule) return _originalSend.apply(this, arguments);

    const xhr = this;
    const status = rule.statusCode || 200;
    const responseBody = status === 204 || status === 304 ? '' : (rule.responseBody || '');
    const headers = mockHeaders(rule);
    const headerStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';

    const define = (prop, value) => {
      try {
        Object.defineProperty(xhr, prop, { value, configurable: true, writable: false });
      } catch {
        /* some props may be locked by the page; ignore */
      }
    };

    setTimeout(() => {
      // `response` must respect responseType, or JSON callers get a string.
      let responseValue = responseBody;
      const rt = xhr.responseType;
      if (rt === 'json') {
        try {
          responseValue = JSON.parse(responseBody);
        } catch {
          responseValue = null;
        }
      } else if (rt === 'arraybuffer') {
        responseValue = new TextEncoder().encode(responseBody).buffer;
      } else if (rt === 'blob') {
        responseValue = new Blob([responseBody], { type: headers['Content-Type'] });
      }

      define('readyState', 4);
      define('status', status);
      define('statusText', statusText(status));
      // Reading `responseText` is a DOMException unless responseType is '' or 'text'.
      define('responseText', rt === '' || rt === 'text' ? responseBody : '');
      define('response', responseValue);
      define('responseURL', xhr.__mirageUrl);
      define('getAllResponseHeaders', () => headerStr);
      define('getResponseHeader', (name) => {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === String(name).toLowerCase());
        return key ? headers[key] : null;
      });

      logMock('xhr', xhr.__mirageMethod, xhr.__mirageUrl, rule);

      const progressInit = { lengthComputable: false, loaded: responseBody.length, total: 0 };

      // dispatchEvent already invokes the on* handler attributes — calling them
      // directly as well would fire every listener twice.
      xhr.dispatchEvent(new Event('readystatechange'));
      xhr.dispatchEvent(new ProgressEvent('load', progressInit));
      xhr.dispatchEvent(new ProgressEvent('loadend', progressInit));
    }, rule.delay || 0);
  };
})();
