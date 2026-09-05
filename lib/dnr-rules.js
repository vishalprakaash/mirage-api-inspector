/**
 * Mirage — declarativeNetRequest rule construction.
 *
 * Chrome allows exactly one url condition per DNR rule and one action per rule,
 * so a single Mirage header rule fans out into up to
 * (url patterns) x (request headers?, response headers?) DNR rules.
 */

// fetch() requests are reported as 'xmlhttprequest'; there is no 'fetch' type.
const RESOURCE_TYPES = ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket', 'other'];

/** A bare hostname or IP, optionally followed by `*` — no scheme, port, or path. */
const HOST_ONLY = /^[a-z0-9][a-z0-9.-]*\*?$/i;

/**
 * Translates a Mirage url pattern into declarativeNetRequest filter options.
 *
 * Host-shaped patterns (`localhost*`, `127.0.0.1*`, `api.example.com`) use
 * `requestDomains`, which matches the request's host directly. That is
 * inherently port- and path-agnostic and needs no regex, so `localhost*`
 * covers every port without one. Chrome matches the domain and its
 * subdomains only, so `localhost*` still will not match `localhost.evil.com`.
 *
 * Everything else uses `urlFilter`, whose own mini-language already handles
 * `*` wildcards. `regexFilter` is deliberately avoided: a rule Chrome rejects
 * takes the whole batch down, and the failure is silent.
 */
function patternToDeclarativeFilter(pattern) {
  if (!pattern || pattern === '*') return {};

  const p = String(pattern).trim();
  if (!p) return {};

  if (HOST_ONLY.test(p)) {
    const host = p.replace(/\*$/, '').toLowerCase();
    if (host) return { requestDomains: [host] };
  }

  return { urlFilter: p };
}

/** Url patterns for a rule; tolerates the pre-v2 single-string shape. */
function rulePatterns(rule) {
  if (Array.isArray(rule.urlFilters)) {
    return rule.urlFilters.filter((p) => p && String(p).trim());
  }
  return rule.urlFilter && String(rule.urlFilter).trim() ? [rule.urlFilter] : [];
}

function buildHeaderOperation(h) {
  switch (h.operation || 'set') {
    case 'set': return { header: h.name, operation: 'set', value: h.value ?? '' };
    case 'append': return { header: h.name, operation: 'append', value: h.value ?? '' };
    case 'remove': return { header: h.name, operation: 'remove' };
    default: return null;
  }
}

function buildCondition(urlFilter) {
  const base = { resourceTypes: [...RESOURCE_TYPES] };
  if (!urlFilter || urlFilter === '*') return base;
  return { ...base, ...patternToDeclarativeFilter(urlFilter) };
}

/**
 * Builds the dynamic rule set for one profile.
 *
 * Rule ids are assigned sequentially from 1; the caller replaces the whole set.
 */
function buildDeclarativeRules(headerRules, profileId) {
  const rules = [];
  let nextId = 1;

  for (const rule of headerRules || []) {
    if (rule.profileId !== profileId || !rule.enabled) continue;

    const requestHeaders = [];
    const responseHeaders = [];

    for (const h of rule.headers || []) {
      if (!h.enabled || !h.name || !String(h.name).trim()) continue;
      const op = buildHeaderOperation(h);
      if (!op) continue;
      (h.type === 'response' ? responseHeaders : requestHeaders).push(op);
    }

    if (requestHeaders.length === 0 && responseHeaders.length === 0) continue;

    // No patterns means "all urls" — represented by a single empty condition.
    const patterns = rulePatterns(rule);
    const conditions = (patterns.length ? patterns : ['']).map(buildCondition);

    for (const condition of conditions) {
      if (requestHeaders.length > 0) {
        rules.push({
          id: nextId++,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders },
          condition
        });
      }
      if (responseHeaders.length > 0) {
        rules.push({
          id: nextId++,
          priority: 1,
          action: { type: 'modifyHeaders', responseHeaders },
          condition
        });
      }
    }
  }

  return rules;
}

export {
  buildDeclarativeRules,
  buildCondition,
  buildHeaderOperation,
  patternToDeclarativeFilter,
  rulePatterns,
  RESOURCE_TYPES
};
