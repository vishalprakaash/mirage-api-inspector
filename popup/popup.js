/**
 * Mirage Popup — main UI controller
 * All state mutations go through background.js via chrome.runtime.sendMessage.
 */

// Guard: chrome.runtime not available outside extension context
if (typeof chrome === 'undefined' || !chrome.runtime) {
  document.body.innerHTML = '<div style="padding:24px;color:#8b949e;font-family:system-ui;font-size:13px"><strong style="color:#e6edf3">Mirage</strong><br><br>This page must be opened as a Chrome extension popup.<br><br><code style="color:#7c3aed">chrome://extensions → Load unpacked</code></div>';
  throw new Error('Not in extension context');
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function msg(type, payload = {}) {
  return new Promise((resolve) => {
    // Never let a dead/slow service worker hang the popup
    const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 2000);
    try {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) resolve({ ok: false });
        else resolve(response || { ok: false });
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    }
  });
}

let _toastTimer = null;
function showToast(text, type = 'default') {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = 'toast show ' + type;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function formatJSON(str) {
  try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; }
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function methodColor(m) {
  const map = { GET:'method-GET', POST:'method-POST', PUT:'method-PUT', DELETE:'method-DELETE', PATCH:'method-PATCH', ANY:'method-ANY' };
  return map[m] || 'method-ANY';
}

// ─── State ────────────────────────────────────────────────────────────────────

let state = null; // full state from background

async function loadState() {
  const res = await msg('GET_STATE');
  if (res.ok) state = res.state;
}

function activeProfile() {
  return state?.profiles?.find((p) => p.id === state.activeProfileId) ?? null;
}

function profileHeaderRules() {
  if (!state) return [];
  return state.headerRules.filter((r) => r.profileId === state.activeProfileId);
}

function profileMockRules() {
  if (!state) return [];
  return state.mockRules.filter((r) => r.profileId === state.activeProfileId);
}

// ─── Full render ──────────────────────────────────────────────────────────────

function render() {
  if (!state) return;
  renderTopBar();
  renderProfileBar();
  renderHeaderRules();
  renderMockRules();
  renderCounts();
}

function renderTopBar() {
  const cb = document.getElementById('global-enabled');
  cb.checked = state.globalEnabled;
}

function renderProfileBar() {
  const profile = activeProfile();
  const sel = document.getElementById('profile-select');
  const dot = document.getElementById('profile-dot');
  const enabledCb = document.getElementById('profile-enabled');

  // Rebuild options only when profiles change
  const ids = [...sel.options].map((o) => o.value);
  const currentIds = state.profiles.map((p) => p.id);
  if (JSON.stringify(ids) !== JSON.stringify(currentIds)) {
    sel.innerHTML = '';
    for (const p of state.profiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
  }
  sel.value = state.activeProfileId;

  dot.style.background = profile?.color ?? '#7c3aed';
  dot.style.boxShadow = `0 0 6px ${profile?.color ?? '#7c3aed'}80`;
  enabledCb.checked = profile?.enabled ?? false;
}

// ─── HEADER RULES ─────────────────────────────────────────────────────────────

function renderHeaderRules() {
  const list = document.getElementById('header-rules-list');
  const empty = document.getElementById('header-empty');
  const rules = profileHeaderRules();

  // Preserve expanded cards
  const expandedIds = new Set([...list.querySelectorAll('.rule-card.expanded')].map((c) => c.dataset.id));

  list.innerHTML = '';

  for (const rule of rules) {
    const card = buildHeaderRuleCard(rule, expandedIds.has(rule.id));
    list.appendChild(card);
  }

  empty.classList.toggle('visible', rules.length === 0);
}

function buildHeaderRuleCard(rule, expanded = false) {
  const card = document.createElement('div');
  card.className = 'rule-card' + (expanded ? ' expanded' : '') + (rule.enabled ? '' : ' disabled');
  card.dataset.id = rule.id;

  const headerCount = rule.headers?.filter((h) => h.enabled).length ?? 0;
  const urlChip = rule.urlFilter ? `<span class="rule-url-chip" title="${escHtml(rule.urlFilter)}">${escHtml(rule.urlFilter)}</span>` : '';

  card.innerHTML = `
    <div class="rule-card-header">
      <div class="rule-expand-icon">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
      </div>
      <div class="rule-summary">
        <input class="rule-name-input" value="${escHtml(rule.name || 'Untitled Rule')}" placeholder="Rule name" title="Click to rename" />
        ${urlChip}
        ${headerCount > 0 ? `<span class="badge badge-req">${headerCount} header${headerCount !== 1 ? 's' : ''}</span>` : ''}
      </div>
      <div class="rule-card-actions">
        <label style="display:flex;align-items:center;cursor:pointer" title="Enable rule">
          <input type="checkbox" ${rule.enabled ? 'checked' : ''} class="rule-enable-cb" />
          <span class="toggle-track sm"><span class="toggle-thumb"></span></span>
        </label>
        <button class="btn-icon btn-icon-sm btn-icon-danger rule-delete-btn" title="Delete rule">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
        </button>
      </div>
    </div>
    <div class="rule-card-body">
      <div class="url-filter-row">
        <span class="field-label">URL Filter</span>
        <input class="url-filter-input rule-url-input" placeholder="All URLs  •  localhost*  •  https://api.example.com/*" value="${escHtml(rule.urlFilter || '')}" />
      </div>
      <div class="section-label" style="margin-top:4px">Headers</div>
      <div class="headers-table header-items"></div>
      <button class="add-row-btn add-header-btn">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/></svg>
        Add Header
      </button>
    </div>
  `;

  // Populate header items
  const headerItems = card.querySelector('.header-items');
  for (const h of rule.headers || []) {
    headerItems.appendChild(buildHeaderRow(h));
  }

  // ── Events ──
  const headerEl = card.querySelector('.rule-card-header');
  headerEl.addEventListener('click', (e) => {
    if (e.target.closest('.rule-card-actions') || e.target.closest('.rule-name-input')) return;
    card.classList.toggle('expanded');
  });

  // Name
  const nameInput = card.querySelector('.rule-name-input');
  nameInput.addEventListener('change', debounce(() => saveHeaderRule(rule, { name: nameInput.value }), 400));
  nameInput.addEventListener('click', (e) => e.stopPropagation());

  // Enable toggle
  const enableCb = card.querySelector('.rule-enable-cb');
  enableCb.addEventListener('change', () => {
    card.classList.toggle('disabled', !enableCb.checked);
    saveHeaderRule(rule, { enabled: enableCb.checked });
  });

  // Delete
  card.querySelector('.rule-delete-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteHeaderRule(rule.id);
  });

  // URL filter
  const urlInput = card.querySelector('.rule-url-input');
  urlInput.addEventListener('input', debounce(() => saveHeaderRule(rule, { urlFilter: urlInput.value.trim() }), 600));

  // Add header row
  card.querySelector('.add-header-btn').addEventListener('click', () => {
    const newHeader = { id: uid(), type: 'request', operation: 'set', name: '', value: '', enabled: true };
    rule.headers = rule.headers || [];
    rule.headers.push(newHeader);
    headerItems.appendChild(buildHeaderRow(newHeader));
    saveHeaderRule(rule, { headers: rule.headers });
  });

  return card;
}

function buildHeaderRow(h) {
  const row = document.createElement('div');
  row.className = 'header-row' + (h.enabled ? '' : ' row-disabled');
  row.dataset.id = h.id;

  row.innerHTML = `
    <select class="h-type type-select" title="Request or response header">
      <option value="request" ${h.type === 'request' ? 'selected' : ''}>⬆ Request</option>
      <option value="response" ${h.type === 'response' ? 'selected' : ''}>⬇ Response</option>
    </select>
    <input class="h-name" placeholder="Header-Name" value="${escHtml(h.name || '')}" />
    <input class="h-value" placeholder="value" value="${escHtml(h.value || '')}" />
    <label style="display:flex;align-items:center;cursor:pointer;flex-shrink:0" title="Enable">
      <input type="checkbox" ${h.enabled ? 'checked' : ''} class="h-enable-cb" />
      <span class="toggle-track sm"><span class="toggle-thumb"></span></span>
    </label>
    <button class="btn-icon btn-icon-sm btn-icon-danger h-delete" title="Remove">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
    </button>
  `;

  const card = () => row.closest('.rule-card');
  const getRule = () => state.headerRules.find((r) => r.id === card()?.dataset?.id);

  const syncHeader = debounce(() => {
    const rule = getRule();
    if (!rule) return;
    const headerInRule = rule.headers?.find((hh) => hh.id === h.id);
    if (headerInRule) {
      Object.assign(headerInRule, {
        type: row.querySelector('.h-type').value,
        name: row.querySelector('.h-name').value.trim(),
        value: row.querySelector('.h-value').value.trim(),
        enabled: row.querySelector('.h-enable-cb').checked
      });
      saveHeaderRule(rule, { headers: rule.headers });
    }
  }, 400);

  row.querySelector('.h-type').addEventListener('change', syncHeader);
  row.querySelector('.h-name').addEventListener('input', syncHeader);
  row.querySelector('.h-value').addEventListener('input', syncHeader);

  const enableCb = row.querySelector('.h-enable-cb');
  enableCb.addEventListener('change', () => {
    row.classList.toggle('row-disabled', !enableCb.checked);
    syncHeader();
  });

  row.querySelector('.h-delete').addEventListener('click', () => {
    const rule = getRule();
    if (rule) {
      rule.headers = rule.headers.filter((hh) => hh.id !== h.id);
      saveHeaderRule(rule, { headers: rule.headers });
    }
    row.remove();
  });

  return row;
}

async function saveHeaderRule(ruleRef, changes) {
  const existing = state.headerRules.find((r) => r.id === ruleRef.id);
  const merged = { ...ruleRef, ...(existing || {}), ...changes };
  // Update local state immediately
  const idx = state.headerRules.findIndex((r) => r.id === ruleRef.id);
  if (idx >= 0) state.headerRules[idx] = merged;
  else state.headerRules.push(merged);

  await msg('UPSERT_HEADER_RULE', { rule: merged });
  renderCounts();
}

async function deleteHeaderRule(ruleId) {
  state.headerRules = state.headerRules.filter((r) => r.id !== ruleId);
  await msg('DELETE_HEADER_RULE', { ruleId });
  renderHeaderRules();
  renderCounts();
}

function addHeaderRule() {
  const profile = activeProfile();
  if (!profile) return;

  const rule = {
    id: uid(),
    profileId: profile.id,
    enabled: true,
    name: 'New Rule',
    urlFilter: '',
    headers: [{ id: uid(), type: 'request', operation: 'set', name: '', value: '', enabled: true }]
  };

  state.headerRules.push(rule);
  msg('UPSERT_HEADER_RULE', { rule });
  renderHeaderRules();
  renderCounts();

  // Auto-expand newly added card
  const list = document.getElementById('header-rules-list');
  const newCard = [...list.querySelectorAll('.rule-card')].find((c) => c.dataset.id === rule.id);
  if (newCard) {
    newCard.classList.add('expanded');
    newCard.querySelector('.rule-name-input')?.focus();
  }
}

// ─── MOCK RULES ───────────────────────────────────────────────────────────────

function renderMockRules() {
  const list = document.getElementById('mock-rules-list');
  const empty = document.getElementById('mock-empty');
  const rules = profileMockRules();

  const expandedIds = new Set([...list.querySelectorAll('.rule-card.expanded')].map((c) => c.dataset.id));
  list.innerHTML = '';

  for (const rule of rules) {
    list.appendChild(buildMockRuleCard(rule, expandedIds.has(rule.id)));
  }

  empty.classList.toggle('visible', rules.length === 0);
}

function buildMockRuleCard(rule, expanded = false) {
  const card = document.createElement('div');
  card.className = 'rule-card' + (expanded ? ' expanded' : '') + (rule.enabled ? '' : ' disabled');
  card.dataset.id = rule.id;

  const statusClass = rule.statusCode < 300 ? 'status-ok' : rule.statusCode < 400 ? 'status-redir' : 'status-err';
  const method = rule.method || 'ANY';

  card.innerHTML = `
    <div class="rule-card-header">
      <div class="rule-expand-icon">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
      </div>
      <div class="rule-summary">
        <input class="rule-name-input" value="${escHtml(rule.name || 'Untitled Mock')}" placeholder="Mock name" />
        <span class="method-badge ${methodColor(method)}">${escHtml(method)}</span>
        <span class="${statusClass}" style="font-size:11px;font-weight:700">${rule.statusCode || 200}</span>
        ${rule.urlFilter ? `<span class="rule-url-chip" title="${escHtml(rule.urlFilter)}">${escHtml(rule.urlFilter)}</span>` : ''}
      </div>
      <div class="rule-card-actions">
        <label style="display:flex;align-items:center;cursor:pointer" title="Enable">
          <input type="checkbox" ${rule.enabled ? 'checked' : ''} class="rule-enable-cb" />
          <span class="toggle-track sm"><span class="toggle-thumb"></span></span>
        </label>
        <button class="btn-icon btn-icon-sm btn-icon-danger rule-delete-btn" title="Delete">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
        </button>
      </div>
    </div>
    <div class="rule-card-body">
      <div class="url-filter-row">
        <span class="field-label">URL Filter</span>
        <input class="url-filter-input mock-url-input" placeholder="All URLs  •  localhost*  •  https://api.example.com/users" value="${escHtml(rule.urlFilter || '')}" />
      </div>
      <div class="form-grid">
        <div class="form-field">
          <label class="field-label">Method</label>
          <select class="mock-method">
            ${['ANY','GET','POST','PUT','DELETE','PATCH'].map((m) => `<option value="${m}" ${rule.method === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label class="field-label">Status Code</label>
          <input type="number" class="mock-status" min="100" max="599" value="${rule.statusCode || 200}" />
        </div>
        <div class="form-field">
          <label class="field-label">Content-Type</label>
          <select class="mock-content-type">
            ${['application/json','text/plain','text/html','application/xml','text/xml','application/x-www-form-urlencoded'].map((ct) => `<option value="${ct}" ${rule.contentType === ct ? 'selected' : ''}>${ct}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label class="field-label">Delay (ms)</label>
          <input type="number" class="mock-delay" min="0" max="30000" value="${rule.delay || 0}" placeholder="0" />
        </div>
      </div>
      <div class="response-body-wrap">
        <div class="response-body-toolbar">
          <label class="field-label">Response Body</label>
          <button class="btn-format mock-fmt-btn" title="Format JSON">{ } Format</button>
        </div>
        <textarea class="mock-body response-body-area" placeholder='{ "message": "Hello from Mirage!" }'>${escHtml(rule.responseBody || '')}</textarea>
      </div>
      <div>
        <div class="section-label" style="margin-bottom:6px">Response Headers</div>
        <div class="response-headers-list mock-res-headers"></div>
        <button class="add-row-btn add-res-header-btn" style="margin-top:5px">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/></svg>
          Add Response Header
        </button>
      </div>
    </div>
  `;

  // Populate response headers
  const resHeaderList = card.querySelector('.mock-res-headers');
  for (const h of rule.responseHeaders || []) {
    resHeaderList.appendChild(buildResHeaderRow(h));
  }

  // ── Events ──
  const headerEl = card.querySelector('.rule-card-header');
  headerEl.addEventListener('click', (e) => {
    if (e.target.closest('.rule-card-actions') || e.target.closest('.rule-name-input')) return;
    card.classList.toggle('expanded');
  });

  const nameInput = card.querySelector('.rule-name-input');
  nameInput.addEventListener('change', debounce(() => saveMockRule(rule, { name: nameInput.value }), 400));
  nameInput.addEventListener('click', (e) => e.stopPropagation());

  const enableCb = card.querySelector('.rule-enable-cb');
  enableCb.addEventListener('change', () => {
    card.classList.toggle('disabled', !enableCb.checked);
    saveMockRule(rule, { enabled: enableCb.checked });
  });

  card.querySelector('.rule-delete-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteMockRule(rule.id);
  });

  card.querySelector('.mock-url-input').addEventListener('input', debounce((e) => {
    saveMockRule(rule, { urlFilter: e.target.value.trim() });
    // Update chip in header
    const chip = card.querySelector('.rule-url-chip');
    if (chip) chip.textContent = chip.title = e.target.value.trim();
  }, 600));

  card.querySelector('.mock-method').addEventListener('change', (e) => {
    saveMockRule(rule, { method: e.target.value });
    const badge = card.querySelector('.method-badge');
    badge.textContent = e.target.value;
    badge.className = 'method-badge ' + methodColor(e.target.value);
  });

  card.querySelector('.mock-status').addEventListener('input', debounce((e) => {
    const code = parseInt(e.target.value);
    if (code >= 100 && code <= 599) saveMockRule(rule, { statusCode: code });
  }, 600));

  card.querySelector('.mock-content-type').addEventListener('change', (e) => {
    saveMockRule(rule, { contentType: e.target.value });
  });

  card.querySelector('.mock-delay').addEventListener('input', debounce((e) => {
    saveMockRule(rule, { delay: parseInt(e.target.value) || 0 });
  }, 600));

  card.querySelector('.mock-body').addEventListener('input', debounce((e) => {
    saveMockRule(rule, { responseBody: e.target.value });
  }, 600));

  card.querySelector('.mock-fmt-btn').addEventListener('click', () => {
    const ta = card.querySelector('.mock-body');
    ta.value = formatJSON(ta.value);
    saveMockRule(rule, { responseBody: ta.value });
  });

  card.querySelector('.add-res-header-btn').addEventListener('click', () => {
    const newH = { id: uid(), name: '', value: '' };
    rule.responseHeaders = rule.responseHeaders || [];
    rule.responseHeaders.push(newH);
    resHeaderList.appendChild(buildResHeaderRow(newH));
    saveMockRule(rule, { responseHeaders: rule.responseHeaders });
  });

  return card;
}

function buildResHeaderRow(h) {
  const row = document.createElement('div');
  row.className = 'res-header-row';
  row.dataset.id = h.id;

  row.innerHTML = `
    <input class="rh-name" placeholder="Header-Name" value="${escHtml(h.name || '')}" />
    <input class="rh-value" placeholder="value" value="${escHtml(h.value || '')}" />
    <button class="btn-icon btn-icon-sm btn-icon-danger rh-delete" title="Remove">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
    </button>
  `;

  const card = () => row.closest('.rule-card');
  const getRule = () => state.mockRules.find((r) => r.id === card()?.dataset?.id);

  const sync = debounce(() => {
    const rule = getRule();
    if (!rule) return;
    const hh = rule.responseHeaders?.find((rh) => rh.id === h.id);
    if (hh) {
      hh.name = row.querySelector('.rh-name').value.trim();
      hh.value = row.querySelector('.rh-value').value.trim();
      saveMockRule(rule, { responseHeaders: rule.responseHeaders });
    }
  }, 400);

  row.querySelector('.rh-name').addEventListener('input', sync);
  row.querySelector('.rh-value').addEventListener('input', sync);

  row.querySelector('.rh-delete').addEventListener('click', () => {
    const rule = getRule();
    if (rule) {
      rule.responseHeaders = rule.responseHeaders?.filter((rh) => rh.id !== h.id);
      saveMockRule(rule, { responseHeaders: rule.responseHeaders });
    }
    row.remove();
  });

  return row;
}

async function saveMockRule(ruleRef, changes) {
  const existing = state.mockRules.find((r) => r.id === ruleRef.id);
  const merged = { ...ruleRef, ...(existing || {}), ...changes };
  const idx = state.mockRules.findIndex((r) => r.id === ruleRef.id);
  if (idx >= 0) state.mockRules[idx] = merged;
  else state.mockRules.push(merged);

  await msg('UPSERT_MOCK_RULE', { rule: merged });
  renderCounts();
}

async function deleteMockRule(ruleId) {
  state.mockRules = state.mockRules.filter((r) => r.id !== ruleId);
  await msg('DELETE_MOCK_RULE', { ruleId });
  renderMockRules();
  renderCounts();
}

function addMockRule() {
  const profile = activeProfile();
  if (!profile) return;

  const rule = {
    id: uid(),
    profileId: profile.id,
    enabled: true,
    name: 'New Mock',
    urlFilter: '',
    method: 'ANY',
    statusCode: 200,
    contentType: 'application/json',
    responseBody: '{\n  "message": "Mocked by Mirage"\n}',
    delay: 0,
    responseHeaders: []
  };

  state.mockRules.push(rule);
  msg('UPSERT_MOCK_RULE', { rule });
  renderMockRules();
  renderCounts();

  const list = document.getElementById('mock-rules-list');
  const newCard = [...list.querySelectorAll('.rule-card')].find((c) => c.dataset.id === rule.id);
  if (newCard) {
    newCard.classList.add('expanded');
    newCard.querySelector('.rule-name-input')?.focus();
  }
}

// ─── Counts ───────────────────────────────────────────────────────────────────

function renderCounts() {
  const hCount = profileHeaderRules().filter((r) => r.enabled).length;
  const mCount = profileMockRules().filter((r) => r.enabled).length;

  const hEl = document.getElementById('header-count');
  const mEl = document.getElementById('mock-count');
  hEl.textContent = hCount > 0 ? String(hCount) : '';
  mEl.textContent = mCount > 0 ? String(mCount) : '';
}

// ─── Profile actions ──────────────────────────────────────────────────────────

async function showModal({ title, body, confirmText = 'OK', danger = false }) {
  return new Promise((resolve) => {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = body;
    document.getElementById('modal-confirm').textContent = confirmText;
    document.getElementById('modal-confirm').className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    document.getElementById('modal-overlay').classList.remove('hidden');

    const close = (result) => {
      document.getElementById('modal-overlay').classList.add('hidden');
      resolve(result);
    };

    document.getElementById('modal-confirm').onclick = () => close(true);
    document.getElementById('modal-cancel').onclick = () => close(false);
    document.getElementById('modal-close').onclick = () => close(false);
    document.getElementById('modal-overlay').onclick = (e) => {
      if (e.target === document.getElementById('modal-overlay')) close(false);
    };
  });
}

async function promptText(title, placeholder = '', initial = '') {
  return new Promise((resolve) => {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = `<input type="text" class="modal-input" placeholder="${escHtml(placeholder)}" value="${escHtml(initial)}" id="modal-text-input" />`;
    document.getElementById('modal-confirm').textContent = 'Save';
    document.getElementById('modal-confirm').className = 'btn btn-primary';
    document.getElementById('modal-overlay').classList.remove('hidden');

    const input = document.getElementById('modal-text-input');
    input.focus();
    input.select();

    const close = (result) => {
      document.getElementById('modal-overlay').classList.add('hidden');
      resolve(result);
    };

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value.trim()); });
    document.getElementById('modal-confirm').onclick = () => close(input.value.trim());
    document.getElementById('modal-cancel').onclick = () => close(null);
    document.getElementById('modal-close').onclick = () => close(null);
  });
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
    });
  });
}

// ─── Export / Import ──────────────────────────────────────────────────────────

async function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mirage-config-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Configuration exported', 'success');
}

async function importData(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.profiles) throw new Error('Invalid Mirage configuration file');

    const confirmed = await showModal({
      title: 'Import Configuration',
      body: `<p style="color:var(--text-secondary);font-size:13px">This will replace your current configuration with the imported data. This cannot be undone.</p>`,
      confirmText: 'Import',
      danger: true
    });

    if (!confirmed) return;

    const res = await msg('IMPORT_DATA', { data });
    if (res.ok) {
      await loadState();
      render();
      showToast('Configuration imported', 'success');
    }
  } catch (err) {
    showToast('Import failed: ' + err.message, 'error');
  }
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

function initEvents() {
  // Global toggle
  document.getElementById('global-enabled').addEventListener('change', async (e) => {
    const res = await msg('SET_GLOBAL_ENABLED', { enabled: e.target.checked });
    if (res.ok && state) { state.globalEnabled = e.target.checked; renderCounts(); }
  });

  // Profile select
  document.getElementById('profile-select').addEventListener('change', async (e) => {
    if (!state) return;
    const res = await msg('SET_ACTIVE_PROFILE', { profileId: e.target.value });
    if (res.ok) {
      state.activeProfileId = e.target.value;
      renderProfileBar();
      renderHeaderRules();
      renderMockRules();
      renderCounts();
    }
  });

  // Profile enable
  document.getElementById('profile-enabled').addEventListener('change', async (e) => {
    if (!state) return;
    const res = await msg('UPDATE_PROFILE', { profileId: state.activeProfileId, changes: { enabled: e.target.checked } });
    if (res.ok) {
      const p = activeProfile();
      if (p) p.enabled = e.target.checked;
      const dot = document.getElementById('profile-dot');
      dot.style.opacity = e.target.checked ? '1' : '0.3';
    }
  });

  // Add profile
  document.getElementById('btn-add-profile').addEventListener('click', async () => {
    const name = await promptText('New Profile', 'Profile name', 'My Profile');
    if (!name) return;
    const res = await msg('CREATE_PROFILE', { name });
    if (res.ok) {
      await loadState();
      render();
      showToast(`Profile "${name}" created`, 'success');
    }
  });

  // Rename profile
  document.getElementById('btn-rename-profile').addEventListener('click', async () => {
    const profile = activeProfile();
    if (!profile) return;
    const name = await promptText('Rename Profile', 'Profile name', profile.name);
    if (!name || name === profile.name) return;
    const res = await msg('UPDATE_PROFILE', { profileId: profile.id, changes: { name } });
    if (res.ok) {
      profile.name = name;
      renderProfileBar();
      showToast('Profile renamed', 'success');
    }
  });

  // Delete profile
  document.getElementById('btn-delete-profile').addEventListener('click', async () => {
    const profile = activeProfile();
    if (!profile) return;
    if (state.profiles.length <= 1) { showToast('Cannot delete the last profile', 'error'); return; }
    const confirmed = await showModal({
      title: 'Delete Profile',
      body: `<p style="color:var(--text-secondary);font-size:13px">Delete <strong style="color:var(--text-primary)">${escHtml(profile.name)}</strong> and all its rules? This cannot be undone.</p>`,
      confirmText: 'Delete',
      danger: true
    });
    if (!confirmed) return;
    const res = await msg('DELETE_PROFILE', { profileId: profile.id });
    if (res.ok) {
      await loadState();
      render();
      showToast('Profile deleted');
    }
  });

  // Add rules
  document.getElementById('btn-add-header-rule').addEventListener('click', addHeaderRule);
  document.getElementById('btn-add-mock-rule').addEventListener('click', addMockRule);

  // Export/Import
  document.getElementById('btn-export').addEventListener('click', exportData);
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file-input').click();
  });
  document.getElementById('import-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importData(file);
    e.target.value = '';
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function init() {
  // Wire UI synchronously so tabs/buttons work even if state loading is slow
  initTabs();
  initEvents();
  await loadState();
  render();
}

init();
