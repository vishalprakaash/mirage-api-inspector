/**
 * Mirage — shared matching engine.
 *
 * Pure functions, no browser-extension APIs. Loaded as the first MAIN-world
 * content script (exposing `__MirageMatch`, which content-main.js immediately
 * captures and deletes from the page global), and loadable in Node for tests.
 */

(function (global) {
  'use strict';

  // ─── URL matching ──────────────────────────────────────────────────────────

  /** Compiled-regex cache, keyed by raw pattern. */
  const _regexCache = new Map();

  function patternToRegex(pattern) {
    if (_regexCache.has(pattern)) return _regexCache.get(pattern);

    const p = String(pattern).trim();
    let regex = null;

    // Shorthand: `localhost*` / `localhost` → any port, any path.
    if (/^localhost\*?$/i.test(p)) {
      regex = /^https?:\/\/localhost(:\d+)?([/?#].*)?$/i;
    } else {
      let body = p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');

      // No explicit scheme in the pattern → accept both http and https.
      if (!/^https?:/i.test(p) && !body.startsWith('.*')) {
        body = 'https?:\\/\\/' + body;
      }

      try {
        regex = new RegExp('^' + body + '([?#].*)?$', 'i');
      } catch {
        regex = null; // invalid pattern → never matches
      }
    }

    _regexCache.set(pattern, regex);
    return regex;
  }

  function matchesPattern(url, pattern) {
    if (!pattern || pattern === '*' || pattern === '**') return true;
    const regex = patternToRegex(pattern);
    return regex ? regex.test(url) : false;
  }

  /** A rule with no patterns applies everywhere; otherwise any one may match. */
  function matchesAnyPattern(url, patterns) {
    const list = (patterns || []).filter((p) => p && String(p).trim());
    if (list.length === 0) return true;
    return list.some((p) => matchesPattern(url, p));
  }

  /** Reads url patterns off a rule, tolerating the pre-v2 single-string shape. */
  function rulePatterns(rule) {
    if (!rule) return [];
    if (Array.isArray(rule.urlFilters)) {
      return rule.urlFilters.filter((p) => p && String(p).trim());
    }
    return rule.urlFilter && String(rule.urlFilter).trim() ? [rule.urlFilter] : [];
  }

  function methodMatches(rule, method) {
    if (!rule.method || rule.method === 'ANY') return true;
    return rule.method === String(method || 'GET').toUpperCase();
  }

  // ─── Request payload matching ──────────────────────────────────────────────

  /** True when this rule inspects the request body at all. */
  function ruleNeedsBody(rule) {
    const bm = rule && rule.bodyMatch;
    return !!(bm && bm.mode && bm.mode !== 'any' && String(bm.value || '').trim());
  }

  function stripWs(s) {
    return String(s).replace(/\s+/g, '');
  }

  function tryParseJSON(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, value: null };
    }
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return a === b;

    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length !== b.length) return false;
      return a.every((item, i) => deepEqual(item, b[i]));
    }

    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }

  /**
   * Exact comparison. When both sides parse as JSON, compares structurally so
   * key order and formatting don't matter; otherwise compares trimmed text.
   */
  function jsonAwareEqual(a, b) {
    const pa = tryParseJSON(a);
    const pb = tryParseJSON(b);
    if (pa.ok && pb.ok) return deepEqual(pa.value, pb.value);
    return String(a).trim() === String(b).trim();
  }

  function bodyMatches(rule, bodyText) {
    if (!ruleNeedsBody(rule)) return true;

    const needle = String(rule.bodyMatch.value);
    const hay = String(bodyText == null ? '' : bodyText);

    if (rule.bodyMatch.mode === 'exact') return jsonAwareEqual(hay, needle);

    if (rule.bodyMatch.mode === 'includes') {
      // Literal first; then whitespace-insensitive so `"id": 5` also finds `{"id":5}`.
      return hay.includes(needle) || stripWs(hay).includes(stripWs(needle));
    }

    return true;
  }

  /** Full match: URL AND method AND payload. */
  function ruleMatches(rule, url, method, bodyText) {
    if (!rule || !rule.enabled) return false;
    if (!methodMatches(rule, method)) return false;
    if (!matchesAnyPattern(url, rulePatterns(rule))) return false;
    return bodyMatches(rule, bodyText);
  }

  /** Narrows to rules matching URL+method, before the body is read. */
  function candidateRules(rules, url, method) {
    return (rules || []).filter(
      (r) => r && r.enabled && methodMatches(r, method) && matchesAnyPattern(url, rulePatterns(r))
    );
  }

  // ─── Request body → text ───────────────────────────────────────────────────

  function formDataToText(fd) {
    try {
      const parts = [];
      for (const [k, v] of fd.entries()) {
        parts.push(k + '=' + (typeof v === 'string' ? v : (v && v.name) || ''));
      }
      return parts.join('&');
    } catch {
      return '';
    }
  }

  function decodeBuffer(buf) {
    try {
      return new TextDecoder().decode(buf);
    } catch {
      return '';
    }
  }

  /** Synchronous conversion, for XHR.send(). Blob is not readable here. */
  function bodyToTextSync(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;

    try {
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return body.toString();
      }
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        return formDataToText(body);
      }
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        return decodeBuffer(body);
      }
      if (typeof Document !== 'undefined' && body instanceof Document) {
        return new XMLSerializer().serializeToString(body);
      }
    } catch {
      return '';
    }

    return '';
  }

  /** Async conversion, for fetch(). Handles Blob on top of the sync cases. */
  async function bodyToTextAsync(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;

    try {
      if (typeof Blob !== 'undefined' && body instanceof Blob) return await body.text();
      if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return '';
    } catch {
      return '';
    }

    return bodyToTextSync(body);
  }

  /**
   * Extracts the body of a fetch() call without consuming the caller's Request.
   * An explicit `init.body` wins over the Request's own body, matching fetch().
   */
  async function extractFetchBody(resource, init) {
    try {
      if (init && init.body != null) return await bodyToTextAsync(init.body);
      if (typeof Request !== 'undefined' && resource instanceof Request) {
        try {
          return await resource.clone().text();
        } catch {
          return ''; // already-consumed or unclonable body
        }
      }
    } catch {
      return '';
    }
    return '';
  }

  const api = {
    patternToRegex,
    matchesPattern,
    matchesAnyPattern,
    rulePatterns,
    methodMatches,
    ruleNeedsBody,
    bodyMatches,
    ruleMatches,
    candidateRules,
    jsonAwareEqual,
    deepEqual,
    formDataToText,
    bodyToTextSync,
    bodyToTextAsync,
    extractFetchBody
  };

  global.__MirageMatch = api;

  // Node / ESM-bundler consumers (tests)
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
