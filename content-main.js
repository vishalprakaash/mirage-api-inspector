/**
 * Mirage — MAIN World Content Script
 *
 * Intercepts window.fetch and XMLHttpRequest to return mocked responses.
 * Receives mock rules from the isolated world via postMessage.
 * Runs at document_start in the page's own JavaScript context.
 */

(function () {
  'use strict';

  // Rules are plain objects: { id, urlFilter, method, statusCode, contentType, responseBody, delay, responseHeaders }
  let mockRules = [];

  // ─── Receive rules from isolated world ─────────────────────────────────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data?.__mirage__) return;
    if (event.data.type === 'MOCK_RULES') {
      mockRules = event.data.rules || [];
    }
  });

  // Request initial rules
  window.dispatchEvent(new Event('__mirage_request_rules__'));

  // ─── URL + Method matching ──────────────────────────────────────────────────

  function findMockRule(url, method) {
    const upperMethod = (method || 'GET').toUpperCase();

    for (const rule of mockRules) {
      if (!rule.enabled) continue;

      // Method check
      if (rule.method && rule.method !== 'ANY' && rule.method !== upperMethod) continue;

      // URL check
      if (!matchUrl(url, rule.urlFilter)) continue;

      return rule;
    }
    return null;
  }

  function matchUrl(url, pattern) {
    if (!pattern || pattern === '*' || pattern === '') return true;

    try {
      const p = pattern.trim();

      // localhost* shorthand
      if (/^localhost\*?$/i.test(p)) {
        return /^https?:\/\/localhost(:\d+)?(\/.*)?(\?.*)?$/i.test(url);
      }

      // Convert glob to regex
      let regexStr = p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');

      if (!/^https?:/i.test(p) && !regexStr.startsWith('.*')) {
        regexStr = 'https?:\\/\\/' + regexStr;
      }
      if (!regexStr.startsWith('^')) regexStr = '^' + regexStr;

      return new RegExp(regexStr, 'i').test(url);
    } catch {
      return false;
    }
  }

  // ─── Build mock Response ───────────────────────────────────────────────────

  function buildResponse(rule) {
    const headers = new Headers();
    headers.set('Content-Type', rule.contentType || 'application/json');
    headers.set('X-Mirage-Mock', 'true');

    for (const h of rule.responseHeaders || []) {
      if (h.name) headers.set(h.name, h.value || '');
    }

    return new Response(rule.responseBody || '', {
      status: rule.statusCode || 200,
      statusText: statusText(rule.statusCode || 200),
      headers
    });
  }

  function statusText(code) {
    const map = { 200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 503: 'Service Unavailable' };
    return map[code] || 'Unknown';
  }

  function sleep(ms) {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  // ─── Intercept fetch ───────────────────────────────────────────────────────

  const _originalFetch = window.fetch.bind(window);

  window.fetch = async function mirageIntercept(resource, options) {
    const url = resource instanceof Request ? resource.url : String(resource);
    const method = resource instanceof Request ? resource.method : (options?.method || 'GET');

    const rule = findMockRule(url, method);

    if (rule) {
      await sleep(rule.delay || 0);
      const response = buildResponse(rule);
      // Log to console for developer visibility
      console.debug(
        `%c[Mirage Mock]%c ${method.toUpperCase()} ${url} → ${rule.statusCode}`,
        'color:#7c3aed;font-weight:bold',
        'color:inherit'
      );
      return response;
    }

    return _originalFetch(resource, options);
  };

  // ─── Intercept XMLHttpRequest ──────────────────────────────────────────────

  const _originalOpen = XMLHttpRequest.prototype.open;
  const _originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__mirageUrl = String(url);
    this.__mirageMethod = String(method).toUpperCase();
    return _originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const rule = findMockRule(this.__mirageUrl, this.__mirageMethod);

    if (rule) {
      const xhr = this;
      const delay = rule.delay || 0;

      setTimeout(() => {
        const responseBody = rule.responseBody || '';
        const status = rule.statusCode || 200;

        // Simulate XHR response
        Object.defineProperty(xhr, 'readyState', { get: () => 4, configurable: true });
        Object.defineProperty(xhr, 'status', { get: () => status, configurable: true });
        Object.defineProperty(xhr, 'statusText', { get: () => statusText(status), configurable: true });
        Object.defineProperty(xhr, 'responseText', { get: () => responseBody, configurable: true });
        Object.defineProperty(xhr, 'response', { get: () => responseBody, configurable: true });

        // Build response headers string
        const headers = { 'Content-Type': rule.contentType || 'application/json', 'X-Mirage-Mock': 'true' };
        for (const h of rule.responseHeaders || []) {
          if (h.name) headers[h.name] = h.value || '';
        }

        const headerStr = Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n');

        Object.defineProperty(xhr, 'getAllResponseHeaders', {
          value: () => headerStr,
          configurable: true
        });

        console.debug(
          `%c[Mirage Mock]%c XHR ${xhr.__mirageMethod} ${xhr.__mirageUrl} → ${status}`,
          'color:#7c3aed;font-weight:bold',
          'color:inherit'
        );

        xhr.dispatchEvent(new Event('loadstart'));
        xhr.dispatchEvent(new Event('progress'));
        xhr.dispatchEvent(new ProgressEvent('load', { lengthComputable: false }));
        xhr.dispatchEvent(new Event('loadend'));

        if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange();
        if (typeof xhr.onload === 'function') xhr.onload(new Event('load'));
      }, delay);

      return;
    }

    return _originalSend.apply(this, arguments);
  };
})();
