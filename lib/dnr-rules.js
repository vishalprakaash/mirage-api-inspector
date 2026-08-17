/**
 * Mirage — declarativeNetRequest rule construction.
 *
 * Chrome allows exactly one url condition per DNR rule and one action per rule,
 * so a single Mirage header rule fans out into up to
 * (url patterns) x (request headers?, response headers?) DNR rules.
 */

// fetch() requests are reported as 'xmlhttprequest'; there is no 'fetch' type.
const RESOURCE_TYPES = ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket', 'other'];

/**
 * Translates a Mirage url pattern into declarativeNetRequest filter options.
 *
 * Chrome's `urlFilter` mini-language cannot express an optional port, so
 * anything port-shaped falls back to `regexFilter`. Kept in step with
 * patternToRegex() in mock-match.js, which does the same job for mocks.
 */
function patternToDeclarativeFilter(pattern) {
  if (!pattern || pattern === '*') return {};

  const p = String(pattern).trim();
  if (!p) return {};

  if (/^localhost\*?$/i.test(p)) {
    return {
      regexFilter: '^https?://localhost(:\\d+)?([/?#].*)?$',
      isUrlFilterCaseSensitive: false
    };
  }

  // Explicit ports (and any other localhost form) need a regex.
  if (/:\d/.test(p) || /localhost/i.test(p)) {
    const regexStr = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return { regexFilter: '^' + regexStr, isUrlFilterCaseSensitive: false };
  }

  // urlFilter handles the common case: * is a wildcard, | anchors.
  return { urlFilter: p, isUrlFilterCaseSensitive: false };
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
