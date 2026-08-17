/**
 * URL pattern matching for Mirage.
 * Supports: exact URLs, glob patterns, localhost* shorthand, and regex.
 */

/**
 * Converts a user-friendly URL pattern to a RegExp.
 * Returns null if the pattern matches everything (empty / "*").
 */
function patternToRegex(pattern) {
  if (!pattern || pattern === '*' || pattern === '**') return null;

  const p = pattern.trim();

  // Special shorthand: localhost*  →  matches localhost with any port and any path
  if (/^localhost\*?$/i.test(p)) {
    return /^https?:\/\/localhost(:\d+)?(\/.*)?(\?.*)?$/i;
  }

  // Escape everything except * and ?
  let regexStr = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');

  // If no protocol prefix in the pattern, allow http and https
  if (!/^https?:/i.test(p) && !regexStr.startsWith('.*')) {
    regexStr = 'https?:\\/\\/' + regexStr;
  }

  // Anchor
  if (!regexStr.startsWith('^')) regexStr = '^' + regexStr;
  if (!regexStr.endsWith('$')) regexStr = regexStr + '([?#].*)?$';

  try {
    return new RegExp(regexStr, 'i');
  } catch {
    // If regex is invalid, fall back to simple includes check
    return null;
  }
}

/**
 * Returns true if the given URL matches the pattern.
 * An empty pattern matches everything.
 */
function matchesPattern(url, pattern) {
  if (!pattern || pattern === '*' || pattern === '') return true;
  const regex = patternToRegex(pattern);
  if (!regex) return true;
  return regex.test(url);
}

/**
 * Converts a pattern to declarativeNetRequest filter options.
 * Returns an object with either { urlFilter } or { regexFilter } key.
 */
function patternToDeclarativeFilter(pattern) {
  if (!pattern || pattern === '*' || pattern === '') return {};

  const p = pattern.trim();

  if (/^localhost\*?$/i.test(p)) {
    return {
      regexFilter: '^https?://localhost(:\\d+)?(/.*)?$',
      isUrlFilterCaseSensitive: false
    };
  }

  // Use regexFilter for patterns with port wildcards like *:3000*
  if (/:\d/.test(p) || p.includes('localhost')) {
    const regexStr = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return {
      regexFilter: '^' + regexStr,
      isUrlFilterCaseSensitive: false
    };
  }

  // Standard urlFilter (declarativeNetRequest uses | as anchors, * as wildcard)
  return { urlFilter: p, isUrlFilterCaseSensitive: false };
}

export { patternToRegex, matchesPattern, patternToDeclarativeFilter };
