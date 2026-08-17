/**
 * Mirage — Isolated World Content Script
 *
 * Bridges the extension world (chrome.runtime, chrome.storage)
 * to the MAIN world content script via window.postMessage.
 * Runs at document_start before any page code.
 */

(function () {
  'use strict';

  let currentRules = [];

  // Fetch active mock rules from background on startup
  chrome.runtime.sendMessage({ type: 'GET_MOCK_RULES' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response?.ok) {
      currentRules = response.rules || [];
      broadcastRules(currentRules);
    }
  });

  // Listen for rule updates pushed from the background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'UPDATE_MOCK_RULES') {
      currentRules = msg.rules || [];
      broadcastRules(currentRules);
    }
  });

  // Listen for rule requests from main world (e.g., on frame init)
  window.addEventListener('__mirage_request_rules__', () => {
    broadcastRules(currentRules);
  });

  function broadcastRules(rules) {
    window.postMessage(
      { __mirage__: true, type: 'MOCK_RULES', rules },
      '*'
    );
  }
})();
