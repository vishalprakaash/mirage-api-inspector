/**
 * Mirage — Isolated World Content Script
 *
 * Bridges the extension world (chrome.runtime) to the MAIN world content
 * script via window.postMessage. Runs at document_start, before page code.
 */

(function () {
  'use strict';

  let currentRules = [];
  let haveRules = false;

  // The MAIN-world script may ask for rules before this listener exists, and
  // may load before the first fetch. Re-broadcasting on every arrival covers
  // both directions of that race.
  window.addEventListener('__mirage_request_rules__', () => broadcastRules());

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'UPDATE_MOCK_RULES') {
      currentRules = msg.rules || [];
      haveRules = true;
      broadcastRules();
    }
  });

  /**
   * Pulls the active rules on startup.
   *
   * At document_start the MV3 service worker is often still spinning up, and
   * sendMessage then fails with "Could not establish connection". Giving up on
   * that leaves the page with no rules until the next navigation, so retry a
   * few times with backoff.
   */
  function requestRules(attempt = 0) {
    let responded = false;

    try {
      chrome.runtime.sendMessage({ type: 'GET_MOCK_RULES' }, (response) => {
        responded = true;

        if (chrome.runtime.lastError) {
          retry(attempt);
          return;
        }
        if (response && response.ok) {
          currentRules = response.rules || [];
          haveRules = true;
          broadcastRules();
        }
      });
    } catch {
      // Extension context invalidated (reloaded/updated) — nothing to retry.
      return;
    }

    // Guard against the callback never firing at all.
    setTimeout(() => {
      if (!responded && !haveRules) retry(attempt);
    }, 500);
  }

  function retry(attempt) {
    if (haveRules || attempt >= 4) return;
    setTimeout(() => requestRules(attempt + 1), 150 * Math.pow(2, attempt));
  }

  function broadcastRules() {
    window.postMessage({ __mirage__: true, type: 'MOCK_RULES', rules: currentRules }, '*');
  }

  requestRules();
})();
