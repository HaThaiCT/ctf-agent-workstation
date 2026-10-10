/* CTF Solver - Frontend
 *
 * Supports 2 challenge modes: single and parallel.
 * Each challenge has one or more "runs" — per-agent WebSocket streams.
 */

const $ = (sel) => document.querySelector(sel);

// === Global State ===
let currentChallengeId = null;
let autoScroll = true;
let stepCount = 0;
let defaultAgent = null;
let defaultFlagFormat = "";
let currentTheme = "dark";
let chatViewMode = "split";
let agentCatalog = [];
let agentByName = new Map();
let gatewayStatus = { status: 'loading', error: 'Loading 9router models…' };
let catalogState = 'loading';
let catalogRequest = 0;
let defaultsLoaded = false;
let skillCatalog = [];
let skillByName = new Map();
let defaultEnabledSkills = [];
let defaultSkillsMode = "auto";
let skillCatalogError = "";
let resourceStatus = null;
const skillBindings = new Map();
let addRunPromptDirty = false;
let addRunPromptTemplateToken = 0;

const pendingTools = new Map();

// Run tracking — one WS per run, one feed per run
let currentRuns = [];               // run objects for current challenge
let activeRunId = null;             // which run tab is active
let currentChallengeMode = "single";
let currentChallengeDefaultSkills = [];
let currentChallengeSkillsMode = "auto";
let runSkillModalRunId = null;
let runGoalModalRunId = null;
let wsConnections = new Map();      // run_id -> WebSocket
let globalWs = null;
let globalWsReconnectTimer = null;
let appAlive = true;
let historyLoadingRuns = new Set(); // run_ids currently replaying saved chat history
const INITIAL_TRANSCRIPT_EVENTS = 50;
const TRANSCRIPT_PAGE_EVENTS = 200;
const TRANSCRIPT_RENDER_BATCH = 25;
const LIVE_RENDER_BATCH = 50;
const MAX_TOOL_OUTPUT_DISPLAY_CHARS = 50000;
let historyLoadToken = 0;
let runHistoryState = new Map();
let historyRenderDepth = 0;
let statsRenderPending = false;
let pendingScrollRuns = new Set();
let scrollFramePending = false;
let queuedRunEvents = [];
let queuedRunEventFrame = false;
let renderedEventNodes = new Map();
let suppressHistoricalStateUpdates = 0;
let transcriptSearchResults = [];
let transcriptSearchActiveIndex = -1;
let metadataLastSyncAt = null;
let metadataSyncError = null;
let metadataSyncTimer = null;
let fileBrowserPath = "";
let fileBrowserRequestToken = 0;

// Per-run counters
let runToolCounts = new Map();
let runStepCounts = new Map();

// Per-run statistics
let runStats = new Map();
let statsUseSnapshot = false;
let statsRefreshTimer = null;

// Timer & cost
let timerInterval = null;
let challengeFlagFormat = "";
let challengeFlagFormats = [];
let currentFlagQuestions = [];
let lastThinkingEl = null;

// === Views ===
const views = {
  dashboard: $("#dashboard-view"),
  detail: $("#detail-view"),
  usage: $("#usage-view"),
  settings: $("#settings-view"),
};

function showView(name) {
  Object.values(views).forEach((v) => v.classList.add("hidden"));
  views[name].classList.remove("hidden");
  if (name !== "detail") document.title = "CTF Solver";
}

// === Agent Helpers ===
function primaryAgentName() {
  return agentCatalog[0]?.name || "claude";
}

function getAgentMeta(name) {
  return agentByName.get(name) || { name, label: name || 'Unavailable harness', models: [], default_model: '', badge_mode: 'model' };
}

function isParallelMode(mode) {
  return mode === "parallel";
}

// === Agent UI Renderers ===
let enabledAgents = [];
let agentModels = {};
let agentEfforts = {};
let settingsAgentDirty = new Set();
let settingsEnabledDirty = false;
let settingsOriginalModels = {};
let settingsOriginalEfforts = {};

function renderAgentSelect(selectEl) {
  selectEl.innerHTML = agentCatalog.map((agent) =>
    `<option value="${esc(agent.name)}">${esc(agent.label)}</option>`
  ).join("");
}

function bindModelEffortControls(agentName, modelSelect, effortSelect, selection = {}, onChange = () => {}) {
  const host = modelSelect.parentElement;
  let note = host.querySelector('.model-effort-note');
  if (!note) {
    note = document.createElement('span');
    note.className = 'model-effort-note text-muted';
    note.setAttribute('role', 'status');
    host.appendChild(note);
  }
  modelSelect.setAttribute('aria-label', '9router model');
  effortSelect.setAttribute('aria-label', 'Model effort');
  const state = { agentName, model: selection.model, effort: selection.effort, locked: false };
  const meta = () => getAgentMeta(state.agentName);
  function render(preserve = false) {
    const models = meta().models || [];
    let notice = '';
    if (!models.some(m => m.value === state.model) && !preserve && models.length) {
      if (state.model !== undefined) notice = 'Saved model unavailable; selected the current 9router preset. ';
      state.model = meta().default_model;
      state.effort = selection.effort;
    }
    modelSelect.innerHTML = models.map(m => '<option value="' + esc(m.value) + '" title="' + esc(m.value) + '">' + esc(m.label || m.value) + '</option>').join('');
    if (state.model !== undefined && !models.some(m => m.value === state.model)) {
      const opt = new Option('Unavailable: ' + (state.model || '(blank model)'), state.model || '');
      opt.disabled = true;
      modelSelect.appendChild(opt);
    }
    if (!modelSelect.options.length) modelSelect.add(new Option('No 9router models available', ''));
    modelSelect.value = state.model ?? '';
    modelSelect.title = state.model ?? '';
    const model = models.find(m => m.value === modelSelect.value);
    const levels = model?.effort_levels || [{ value: state.effort ?? '', label: state.effort ? 'Unavailable model — ' + state.effort : 'Provider-managed' }];
    if (model?.effort_mode === 'managed') state.effort = '';
    else if (model && !levels.some(e => e.value === state.effort)) {
      if (state.effort !== undefined) notice += 'Effort reset to this model’s default. ';
      const preset = state.effort === undefined ? meta().selected_effort : model?.default_effort;
      state.effort = levels.some(e => e.value === preset) ? preset : (model?.default_effort ?? '');
    }
    effortSelect.innerHTML = levels.map(e => '<option value="' + esc(e.value) + '">' + esc(e.label) + '</option>').join('');
    effortSelect.value = state.effort ?? '';
    modelSelect.dataset.unavailable = model ? 'false' : 'true';
    modelSelect.disabled = state.locked || catalogState !== 'ready' || !models.length;
    effortSelect.disabled = state.locked || catalogState !== 'ready' || !model || model.effort_mode === 'managed';
    note.textContent = notice + (model?.effort_note || (!model ? 'Select an available 9router model before starting.' : ''));
    onChange({ agent: state.agentName, model: modelSelect.value, effort: effortSelect.value });
  }
  modelSelect.onchange = () => {
    state.model = modelSelect.value;
    state.effort = effortSelect.value;
    render(true);
  };
  effortSelect.onchange = () => { state.effort = effortSelect.value; onChange(state); };
  const controls = {
    refresh() {
      if (state.model !== undefined || modelSelect.value) state.model = modelSelect.value;
      if (state.effort !== undefined || effortSelect.value) state.effort = effortSelect.value;
      render(state.model !== undefined);
    },
    lock(locked) { state.locked = locked; render(true); },
    setAgent(name, preset) { state.agentName = name; state.model = preset.model; state.effort = preset.effort; selection = preset; render(); },
  };
  modelSelect._gatewayControls = controls;
  render(selection.preserve === true);
  return controls;
}

function agentPreset(name) {
  const meta = getAgentMeta(name);
  return {
    model: Object.hasOwn(agentModels, name) ? agentModels[name] : (meta.default_model || undefined),
    effort: Object.hasOwn(agentEfforts, name) ? agentEfforts[name] : meta.selected_effort,
  };
}

function createAgentRow(agentName, model, effort) {
  const row = document.createElement('div');
  row.className = 'agent-row';
  const providerSel = document.createElement('select');
  providerSel.className = 'agent-row-provider';
  providerSel.setAttribute('aria-label', 'Harness');
  renderAgentSelect(providerSel);
  providerSel.value = agentName;
  const modelSel = document.createElement('select');
  modelSel.className = 'agent-row-model';
  const effortSel = document.createElement('select');
  effortSel.className = 'agent-row-effort';
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'agent-row-remove';
  removeBtn.textContent = '×';
  removeBtn.setAttribute('aria-label', 'Remove harness row');
  row.append(providerSel, modelSel, effortSel, removeBtn);
  const controls = bindModelEffortControls(agentName, modelSel, effortSel, {model, effort});
  providerSel.addEventListener('change', () => controls.setAgent(providerSel.value, agentPreset(providerSel.value)));
  removeBtn.addEventListener('click', () => row.remove());
  return row;
}

function addAgentRow(container, agentName, model, effort) {
  const name = agentName || defaultAgent || primaryAgentName();
  const preset = agentPreset(name);
  container.appendChild(createAgentRow(name, model ?? preset.model, effort ?? preset.effort));
}

function populateAgentList(container) {
  container.innerHTML = '';
  for (const name of enabledAgents.length ? enabledAgents : [defaultAgent || primaryAgentName()]) addAgentRow(container, name);
}

function getAgentRows(container) {
  const rows = Array.from(container.querySelectorAll('.agent-row'));
  const error = catalogState !== 'ready' ? (gatewayStatus.error || '9router models are not ready; Refresh models in Settings.')
    : !rows.length ? 'At least one agent is required'
    : rows.some(row => row.querySelector('.agent-row-model').dataset.unavailable === 'true') ? 'Select an available 9router model for every harness.' : '';
  const unavailableHarness = rows.find(row => gatewayStatus.harnesses?.[row.querySelector('.agent-row-provider').value]?.ready === false);
  if (unavailableHarness) { showToast(gatewayStatus.harnesses[unavailableHarness.querySelector('.agent-row-provider').value].error || 'Native harness unavailable', 'error'); return null; }
  if (error) { showToast(error, 'error'); return null; }
  return rows.map(row => ({ agent: row.querySelector('.agent-row-provider').value,
    model: row.querySelector('.agent-row-model').value, effort: row.querySelector('.agent-row-effort').value }));
}

function renderUsageShell() {
  $('#usage-grid').innerHTML = agentCatalog.map(agent => '<div class="usage-card" id="usage-' + esc(agent.name) + '"><div class="usage-card-header"><span class="usage-agent-name">' + esc(agent.label) + '</span><span class="badge" data-harness-status></span></div><div class="usage-harness-info" data-harness-error></div><div class="usage-challenge-stats" data-challenge-stats></div></div>').join('');
}

function isAgentCatalogResponse(data) {
  const gateway = data?.gateway;
  if (!Array.isArray(data?.agents) || gateway?.provider !== '9router' || !['ready', 'error', 'empty'].includes(gateway.status) || typeof gateway.base_url !== 'string' || !gateway.harnesses) return false;
  return data.agents.every(agent => {
    if (!agent || typeof agent.name !== 'string' || !Array.isArray(agent.models)) return false;
    if (new Set(agent.models.map(model => model?.value)).size !== agent.models.length) return false;
    return agent.models.every(model => model && typeof model.value === 'string' && model.value && ['managed', 'selectable'].includes(model.effort_mode) && Array.isArray(model.effort_levels) && model.effort_levels.length && model.effort_levels.every(level => level && typeof level.value === 'string' && typeof level.label === 'string'));
  });
}

async function loadAgentCatalog(force = false) {
  const request = ++catalogRequest;
  catalogState = 'loading';
  renderGatewayStatus();
  document.querySelectorAll('select').forEach(sel => sel._gatewayControls?.refresh());
  try {
    const res = await api('/api/agents' + (force ? '?refresh=1' : ''));
    if (!res) throw new Error('9router catalog unavailable');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '9router catalog unavailable');
    if (!isAgentCatalogResponse(data)) throw new Error('9router returned an invalid model catalog');
    if (request !== catalogRequest) return false;
    agentCatalog = data.agents;
    agentByName = new Map(agentCatalog.map(agent => [agent.name, agent]));
    gatewayStatus = data.gateway;
    catalogState = gatewayStatus.status === 'ready' && agentCatalog.some(a => a.models.length) ? 'ready' : gatewayStatus.status === 'empty' ? 'empty' : 'error';
    renderUsageShell();
  } catch (error) {
    if (request !== catalogRequest) return false;
    catalogState = 'error';
    gatewayStatus = { ...gatewayStatus, status: 'error', error: error.message };
  }
  document.querySelectorAll('select').forEach(sel => sel._gatewayControls?.refresh());
  renderGatewayStatus();
  return catalogState === 'ready';
}

function isLoopbackGateway() {
  try {
    const host = new URL(gatewayStatus.base_url).hostname;
    return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]' || host === '::1';
  } catch (_) { return true; }
}

function renderGatewayStatus() {
  const message = catalogState === 'loading' ? 'Loading 9router models…' : catalogState === 'ready' ? '9router catalog ready — native inference is not yet verified.' : gatewayStatus.error || (catalogState === 'empty' ? '9router has no tool-capable models.' : '9router catalog unavailable.');
  document.querySelectorAll('[data-gateway-status]').forEach(el => { el.textContent = message; el.dataset.state = catalogState; });
  document.querySelectorAll('[data-gateway-key]').forEach(el => { el.placeholder = gatewayStatus.key_configured ? 'Configured; leave blank to keep' : 'API key'; });
  document.querySelectorAll('[data-gateway-url]').forEach(el => { if (el.dataset.dirty !== 'true') el.value = gatewayStatus.base_url || 'https://rr28qzu.abc-tunnel.us/v1'; });
  document.querySelectorAll('[data-gateway-source]').forEach(el => { el.textContent = gatewayStatus.source ? 'Key source: ' + gatewayStatus.source : 'No API key configured'; });
  document.querySelectorAll('#challenge-form button[type="submit"], #btn-bulk-submit, #btn-import-submit, #btn-add-run-submit, #btn-start, #btn-retry, #btn-resume, #advisor-send, #btn-steer, .split-steer-btn').forEach(btn => { btn.disabled = catalogState !== 'ready' || !defaultsLoaded || btn.dataset.busy === 'true' || (btn.id === 'advisor-send' && advisorThinking); });
  document.querySelectorAll('#btn-new-challenge, #btn-bulk-upload, #btn-import, #btn-add-run').forEach(btn => { btn.disabled = catalogState === 'loading' || !defaultsLoaded || btn.dataset.busy === 'true'; });
  const target = $('#challenge-run-target');
  if (target) {
    Array.from(target.options).forEach(opt => { if (opt.value !== 'local') { opt.disabled = isLoopbackGateway(); opt.title = opt.disabled ? 'Local 9router is not reachable from swarm workers; select Local' : ''; } });
  }
}

function normalizeSkillNames(names) {
  const input = Array.isArray(names) ? names : [];
  const seen = new Set();
  const normalized = [];
  for (const name of input) {
    if (typeof name !== "string" || !name || seen.has(name)) continue;
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

function allSkillNames() {
  return skillCatalog.map((skill) => skill.name);
}

async function loadSkillCatalog() {
  const res = await api("/api/skills");
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res?.ok || !applySkillCatalogPayload(data)) {
    skillCatalogError = data.error || "Skill catalog unavailable. Retry in Settings.";
    renderResourceStatus();
    return false;
  }
  skillCatalogError = "";
  renderResourceStatus();
  return true;
}

function skillsMode(record, fallback = "auto") {
  if (["auto", "manual", "inherit"].includes(record?.skills_mode)) return record.skills_mode;
  return record?.enabled_skills?.length ? "manual" : fallback;
}

function applySkillCatalogPayload(data) {
  if (!data || !Array.isArray(data.skills)) return false;
  skillCatalog = data.skills;
  skillByName = new Map(skillCatalog.map((skill) => [skill.name, skill]));
  defaultEnabledSkills = normalizeSkillNames(data.default_enabled_skills ?? []);
  defaultSkillsMode = skillsMode(data);
  return true;
}

function initializeSkillControls() {
  document.querySelectorAll(".skill-checklist").forEach(container => {
    const allowInherit = ["run-skill-list", "add-run-skill-list"].includes(container.id);
    const controls = document.createElement("div");
    controls.className = "skill-policy";
    controls.innerHTML = '<label for="' + container.id + '-mode">Skill selection</label><select id="' + container.id + '-mode">' + (allowInherit ? '<option value="inherit">Inherit challenge policy</option>' : '') + '<option value="auto">Auto — select needed skills</option><option value="manual">Manual — exact selection</option></select><p class="settings-hint" data-skill-policy-note></p>';
    const details = document.createElement("details");
    details.className = "skill-manual-controls";
    details.innerHTML = '<summary>Advanced: inspect / choose skills</summary>';
    const toolbar = container.previousElementSibling;
    container.before(controls, details);
    if (toolbar?.classList.contains("skill-toolbar")) details.appendChild(toolbar);
    details.appendChild(container);
    const binding = { controls, details, select: controls.querySelector("select"), mode: allowInherit ? "inherit" : "auto" };
    skillBindings.set(container.id, binding);
    binding.select.addEventListener("change", () => {
      setSkillMode(container, binding.select.value);
      skillPolicyChanged(container);
    });
    container.addEventListener("change", e => {
      if (!e.target.classList.contains("skill-cb")) return;
      setSkillMode(container, "manual");
      skillPolicyChanged(container);
    });
    setSkillMode(container, binding.mode);
  });
}

function skillPolicyChanged(container) {
  if (container.id === "bulk-skill-list") updateChallengeSkillSummaries("bulk");
  if (container.id === "import-skill-list") updateChallengeSkillSummaries("import");
  if (container.id === "add-run-skill-list" && !addRunPromptDirty) refreshAddRunPromptTemplate({ preserveDirty: true, silent: true });
}

function setSkillMode(container, mode) {
  const binding = skillBindings.get(container?.id);
  if (!binding) return;
  binding.mode = mode;
  binding.select.value = mode;
  binding.controls.querySelector("[data-skill-policy-note]").textContent = mode === "auto"
    ? "The runtime selects related skills automatically when the run starts. Checkbox selections are ignored in Auto."
    : mode === "inherit" ? "Use the challenge's Auto or Manual policy, including future automatic selections."
    : "Only checked skills will be enabled. An empty selection enables none.";
  binding.details.open = mode === "manual";
}

function bindSkillSelection(container, selection = {}) {
  renderSkillChecklist(container, selection.enabled_skills ?? []);
  setSkillMode(container, skillsMode(selection));
}

function skillSelectionPayload(container) {
  const mode = skillBindings.get(container?.id)?.mode || "auto";
  return mode === "manual"
    ? { skills_mode: mode, enabled_skills: getSelectedSkills(container) }
    : { skills_mode: mode };
}

function appendSkillSelection(form, container) {
  for (const [key, value] of Object.entries(skillSelectionPayload(container))) {
    form.append(key, Array.isArray(value) ? JSON.stringify(value) : value);
  }
}

async function loadResources() {
  const res = await api("/api/resources");
  const data = res ? await res.json().catch(() => ({})) : {};
  resourceStatus = res?.ok && Array.isArray(data.mcp)
    ? data : { error: data.error || "Runtime resource status unavailable." };
  renderResourceStatus();
}

function renderResourceStatus() {
  const container = $("#settings-resource-status");
  if (!container) return;
  const catalog = resourceStatus?.category_catalog;
  const errors = [skillCatalogError, resourceStatus?.error, catalog?.error].filter(Boolean);
  container.innerHTML = '<p>Sources: repository skills, automatic category cache, uploaded app skills / all-skills.</p><p>' + skillCatalog.length + ' discovered skills. Category catalog: ' + esc(catalog?.status || "not loaded") + '.</p>' + errors.map(error => '<p class="resource-error">' + esc(error) + '</p>').join('') + (resourceStatus?.mcp || []).map(server => '<p><strong>' + esc(server.name) + '</strong> · ' + esc(server.source) + ' · ' + (server.available ? 'Available (not connected; starts with a native run)' : 'Unavailable') + (server.error ? ' — ' + esc(server.error) : '') + '</p>').join('');
}

function renderSkillChecklist(container, selectedNames) {
  if (!container) return;
  const selected = new Set(normalizeSkillNames(selectedNames));
  if (!skillCatalog.length && !selected.size) {
    container.innerHTML = `<div class="settings-hint">${esc(skillCatalogError || "No skills found.")}</div>`;
    return;
  }
  const rows = [...skillCatalog, ...Array.from(selected).filter(name => !skillByName.has(name)).map(name => ({ name, description: "Unavailable in the current catalog; retained selection." }))];
  container.innerHTML = rows.map((skill) => {
    const checked = selected.has(skill.name) ? "checked" : "";
    const desc = skill.description || "";
    return `<label class="skill-check">
      <input type="checkbox" class="skill-cb" value="${esc(skill.name)}" ${checked}>
      <span>
        <span class="skill-name">${esc(skill.name)}</span>
        <span class="skill-source">${esc(skill.category || "")} ${esc(skill.source || "")}</span>
        ${desc ? `<span class="skill-desc">${esc(desc)}</span>` : ""}
      </span>
    </label>`;
  }).join("");
}

function renderSkillReadonlyList(container, selectedNames) {
  if (!container) return;
  const selected = normalizeSkillNames(selectedNames);
  if (!selected.length) {
    container.innerHTML = `<span class="skill-pill skill-pill-muted">None</span>`;
    return;
  }
  container.innerHTML = selected.map((name) =>
    `<span class="skill-pill">${esc(name)}</span>`
  ).join("");
}

function getSelectedSkills(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(".skill-cb:checked"))
    .map((cb) => cb.value);
}

function setSkillChecklist(container, names) {
  if (!container) return;
  const selected = new Set(names);
  container.querySelectorAll(".skill-cb").forEach((cb) => {
    cb.checked = selected.has(cb.value);
  });
}

document.addEventListener("click", (e) => {
  const goalBtn = e.target.closest(".goal-edit-btn");
  if (goalBtn) {
    e.preventDefault();
    openRunGoalModal(goalBtn.dataset.run || "");
    return;
  }

  const btn = e.target.closest("[data-skill-action]");
  if (!btn) return;
  const container = document.querySelector(btn.dataset.skillTarget || "");
  if (!container) return;
  setSkillMode(container, "manual");
  const action = btn.dataset.skillAction;
  if (action === "all") setSkillChecklist(container, allSkillNames());
  if (action === "none") setSkillChecklist(container, []);
  if (action === "defaults") setSkillChecklist(container, defaultEnabledSkills);
  if (action === "challenge-defaults") {
    setSkillChecklist(container, currentChallengeDefaultSkills);
  }
  skillPolicyChanged(container);

});

async function uploadSettingsSkill() {
  const input = $("#settings-skill-upload");
  const result = $("#settings-skill-upload-result");
  const file = input.files && input.files[0];
  if (!file) {
    showToast("Choose a skill zip or SKILL.md first", "error");
    return;
  }

  const selectedBeforeUpload = getSelectedSkills($("#settings-skill-list"));
  const btn = $("#btn-settings-skill-upload");
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Uploading...";
  result.textContent = "";

  const fd = new FormData();
  fd.append("skill", file);
  const res = await api("/api/skills/upload", { method: "POST", body: fd });

  btn.disabled = false;
  btn.textContent = oldText;
  if (!res) return;

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    showToast(data.error || "Skill upload failed", "error");
    return;
  }

  if (!applySkillCatalogPayload(data.catalog)) {
    await loadSkillCatalog();
  }
  const uploadedName = data.skill && data.skill.name;
  const selectedAfterUpload = uploadedName
    ? normalizeSkillNames([...selectedBeforeUpload, uploadedName])
    : normalizeSkillNames(selectedBeforeUpload);
  renderSkillChecklist($("#settings-skill-list"), selectedAfterUpload);
  await loadResources();
  input.value = "";
  result.textContent = uploadedName ? `Uploaded ${uploadedName}` : "Uploaded";
  showToast(result.textContent, "success");
}

// === API ===
async function api(path, opts = {}) {
  const headers = { ...opts.headers };
  if (!(opts.body instanceof FormData)) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  try {
    const res = await fetch(path, { ...opts, headers });
    if (!res.ok && (res.status === 401 || (opts.method && opts.method !== 'GET'))) {
      const error = await res.clone().json().catch(() => ({}));
      showToast(error.error || (res.status === 401 ? 'Request rejected (401). Check the server or upstream service configuration.' : 'Request failed (' + res.status + ')'), 'error');
    }
    return res;
  } catch (error) {
    showToast('Request failed: ' + error.message, 'error');
    return null;
  }
}

async function withBusy(button, action, text) {
  if (button.dataset.busy === 'true') return;
  const oldText = button.textContent;
  button.dataset.busy = 'true';
  button.disabled = true;
  if (text) button.textContent = text;
  try { return await action(); }
  catch (error) { showToast(error.message || 'Request failed', 'error'); }
  finally {
    delete button.dataset.busy;
    button.disabled = false;
    button.textContent = oldText;
    renderGatewayStatus();
  }
}

function initializeGatewayCards() {
  document.querySelectorAll('[data-gateway-card]').forEach(card => {
    card.innerHTML = '<h2 class="settings-section-title">Model provider: 9router</h2><p data-gateway-status role="status" aria-live="polite"></p><label class="gateway-field"><span>Gateway URL</span><input type="url" data-gateway-url placeholder="https://rr28qzu.abc-tunnel.us/v1"></label><label class="gateway-field"><span>API key</span><input type="password" data-gateway-key autocomplete="off" placeholder="API key"></label><div class="gateway-actions"><button type="button" data-gateway-save class="btn-secondary btn-sm">Save provider</button><button type="button" data-gateway-refresh class="btn-ghost btn-sm">Refresh models / Retry</button><span data-gateway-source class="text-muted"></span></div><p class="text-muted">Both native harnesses use this provider. Blank key keeps the currently configured key. Saving reloads the catalog without restarting the service.</p>';
    card.querySelector('[data-gateway-url]').addEventListener('input', e => { e.target.dataset.dirty = 'true'; });
    card.querySelector('[data-gateway-save]').addEventListener('click', e => withBusy(e.currentTarget, async () => {
      const key = card.querySelector('[data-gateway-key]');
      const url = card.querySelector('[data-gateway-url]');
      const res = await api('/api/agents/gateway', { method: 'PUT', body: JSON.stringify({ base_url: url.value.trim(), api_key: key.value.trim() }) });
      if (!res) return;
      const data = await res.json();
      if (data.provider === '9router') gatewayStatus = data;
      if (!res.ok) return;
      key.value = '';
      delete url.dataset.dirty;
      await loadAgentCatalog();
      if (catalogState === 'ready') showToast('9router provider saved', 'success');
    }, 'Saving…'));
  });
  document.querySelectorAll('[data-gateway-refresh]').forEach(btn => btn.addEventListener('click', () => withBusy(btn, async () => { await loadAgentCatalog(true); await loadUsage(); }, 'Refreshing…')));
  renderGatewayStatus();
}

function newestConnectionSync(connections) {
  let newest = null;
  for (const conn of connections || []) {
    const value = conn.last_sync;
    if (!value) continue;
    const ts = parseServerTimestamp(value);
    if (Number.isNaN(ts.getTime())) continue;
    if (!newest || ts > newest) newest = ts;
  }
  return newest;
}

function newestConnectionError(connections) {
  let newest = null;
  for (const conn of connections || []) {
    if (!conn.last_error) continue;
    const ts = parseServerTimestamp(conn.last_error_at || "");
    if (Number.isNaN(ts.getTime())) continue;
    if (!newest || ts > newest.at) {
      newest = {
        label: conn.label || conn.id || "connection",
        error: conn.last_error,
        at: ts,
      };
    }
  }
  return newest;
}

function parseServerTimestamp(value) {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return new Date(value);
  const trimmed = value.trim();
  if (!trimmed) return new Date(NaN);
  // Legacy backend timestamps were UTC but had no timezone suffix.
  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  return new Date(hasTimezone ? trimmed : `${trimmed}Z`);
}

function setMetadataLastSync(value) {
  if (!value) return;
  const ts = parseServerTimestamp(value);
  if (Number.isNaN(ts.getTime())) return;
  metadataLastSyncAt = ts;
  renderMetadataSyncAge();
  if (!metadataSyncTimer) {
    metadataSyncTimer = setInterval(renderMetadataSyncAge, 30 * 1000);
  }
}

function setMetadataSyncError(error) {
  metadataSyncError = error || null;
  renderMetadataSyncAge();
  if (!metadataSyncTimer) {
    metadataSyncTimer = setInterval(renderMetadataSyncAge, 30 * 1000);
  }
}

function formatRelativeTime(ts) {
  const diffMs = Date.now() - ts.getTime();
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderMetadataSyncAge() {
  const el = $("#metadata-sync-age");
  if (!el) return;
  if (metadataSyncError) {
    const failed = `CTF metadata sync failed ${formatRelativeTime(metadataSyncError.at)}`;
    const lastGood = metadataLastSyncAt
      ? ` Last successful update ${formatRelativeTime(metadataLastSyncAt)}.`
      : "";
    el.textContent = `${failed}: ${metadataSyncError.label}: ${metadataSyncError.error}.${lastGood}`;
    el.title = metadataSyncError.at.toLocaleString();
    el.classList.add("metadata-sync-error");
    return;
  }
  el.classList.remove("metadata-sync-error");
  if (!metadataLastSyncAt) {
    el.textContent = "CTF metadata not synced yet";
    return;
  }
  el.textContent = `CTF metadata updated ${formatRelativeTime(metadataLastSyncAt)}`;
  el.title = metadataLastSyncAt.toLocaleString();
}

// === Default Agent / Settings ===
async function loadDefaultAgent() {
  const res = await api("/api/settings");
  if (!res || !res.ok) { showToast('Unable to load saved harness presets; reload to retry.', 'error'); return; }
  const settings = await res.json();
  defaultAgent = settings.default_agent || primaryAgentName();
  if (!agentByName.has(defaultAgent)) defaultAgent = primaryAgentName();
  defaultFlagFormat = settings.default_flag_format || "";
  currentTheme = settings.theme || "dark";
  chatViewMode = settings.chat_view_mode || "split";
  enabledAgents = settings.enabled_agents && settings.enabled_agents.length
    ? settings.enabled_agents
    : [defaultAgent];
  agentModels = settings.agent_models || {};
  agentEfforts = settings.agent_efforts || {};
  defaultEnabledSkills = normalizeSkillNames(settings.enabled_skills ?? []);
  defaultSkillsMode = skillsMode(settings);
  applyTheme(currentTheme);
  defaultsLoaded = true;
  renderGatewayStatus();
}

function applyTheme(theme) {
  document.body.classList.toggle("light", theme === "light");
}



// === Dashboard ===
async function loadChallenges() {
  const res = await api("/api/challenges");
  if (!res) return;
  const challenges = await res.json();
  const list = $("#challenges-list");
  const empty = $("#empty-state");

  if (!challenges.length) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  // Group challenges by category, sort by points (status priority) within
  const groups = {};
  for (const c of challenges) {
    const cat = c.category || "Uncategorized";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(c);
  }
  const sortedCats = Object.keys(groups).sort();

  let html = "";
  for (const cat of sortedCats) {
    html += `<div class="dash-category-group">
      <div class="dash-category-header">${esc(cat)}</div>
      <div class="dash-card-grid">`;
    for (const c of groups[cat]) {
      const mode = c.mode || "single";
      const runs = c.runs || [];
      const runCount = runs.length;
      const isPending = c.status === "pending";
      const fileCount = Number.isInteger(c.file_count)
        ? c.file_count
        : ((c.files || []).length);

      const modeLabel = mode.replace(/_/g, " ");
      const totalDuration = runs.reduce((sum, r) => sum + (r.duration_ms || 0), 0);

      const solvesNum = c.solves ?? 0;
      const ptsStr = c.points ? `${c.points} pts` : "";
      const solvesStr = `${solvesNum} solve${solvesNum !== 1 ? "s" : ""}`;
      const challengeInfo = [ptsStr, solvesStr].filter(Boolean).join(" \u00b7 ");

      let agentLabel = "";
      if (isParallelMode(mode)) {
        agentLabel = `${runCount} run${runCount !== 1 ? "s" : ""}`;
      } else if (runs.length > 0) {
        const run = runs[0];
        const agentMeta = getAgentMeta(run.agent);
        agentLabel = agentMeta.badge_mode === "label"
          ? agentMeta.label
          : (run.model || agentMeta.default_model);
      }
      const runInfo = [
        modeLabel,
        agentLabel,
        `${fileCount} file${fileCount !== 1 ? "s" : ""}`,
      ].filter(Boolean).join(" \u00b7 ");

      const dur = formatDuration(totalDuration);

      html += `
      <div class="challenge-card status-${c.status}" data-id="${c.id}">
        <a class="card-link" href="#/challenge/${c.id}" aria-label="Open challenge"></a>
        <span class="badge badge-${c.status}">${c.status}</span>
        <span class="card-name">${esc(c.name)}</span>
        <span class="card-info-line">${esc(challengeInfo)}</span>
        <span class="card-info-line card-info-dim">${esc(runInfo)}</span>
        ${dur ? `<span class="card-info-line card-info-dim">${esc(dur)}</span>` : ""}
        ${isPending ? `<button class="btn-card-start" data-id="${c.id}">&#9654; Start</button>` : ""}
        <button class="btn-card-delete" data-id="${c.id}" title="Delete">&times;</button>
      </div>`;
    }
    html += `</div></div>`;
  }
  list.innerHTML = html;

  list.querySelectorAll(".challenge-card").forEach((card) =>
    card.addEventListener("click", (e) => {
      if (e.target.closest(".btn-card-delete") || e.target.closest(".btn-card-start")) return;
      if (exportMode) { e.preventDefault(); toggleExportCard(card); return; }
      // Plain left-click: navigate in-place without a full reload. Ctrl/Cmd/middle
      // clicks are left to the .card-link anchor so the browser opens a new tab.
      const link = e.target.closest(".card-link");
      if (link && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
        e.preventDefault();
        openChallenge(card.dataset.id);
      }
    })
  );
  list.querySelectorAll(".btn-card-delete").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this challenge?")) return;
      await api(`/api/challenges/${btn.dataset.id}`, { method: "DELETE" });
      loadChallenges();
    })
  );
  list.querySelectorAll(".btn-card-start").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const cid = btn.dataset.id;
      const endpoint = `/api/challenges/${cid}/solve`;
      const res = await api(endpoint, { method: "POST" });
      if (res && res.ok) loadChallenges();
    })
  );
}

// === Export Mode ===
let exportMode = false;
const exportSelected = new Set();
let pendingExportIds = [];
let pendingExportFromSelection = false;

function enterExportMode() {
  exportMode = true;
  exportSelected.clear();
  $("#challenges-list").classList.add("export-mode");
  $("#export-bar").classList.remove("hidden");
  $("#btn-export-mode").textContent = "Cancel Export";
  const btnSel = $("#btn-select-mode");
  if (btnSel) btnSel.textContent = "Cancel";
  updateExportCount();
}

function exitExportMode() {
  exportMode = false;
  exportSelected.clear();
  $("#challenges-list").classList.remove("export-mode");
  $("#export-bar").classList.add("hidden");
  $("#btn-export-mode").textContent = "Export";
  const btnSel = $("#btn-select-mode");
  if (btnSel) btnSel.textContent = "Select";
  document.querySelectorAll(".challenge-card.export-selected").forEach(
    (c) => c.classList.remove("export-selected")
  );
}

function updateExportCount() {
  const n = exportSelected.size;
  $("#export-count").textContent = `${n} selected`;
  $("#btn-export-download").disabled = n === 0;
  const btnDel = $("#btn-delete-selected");
  if (btnDel) btnDel.disabled = n === 0;
}

function toggleExportCard(card) {
  const id = card.dataset.id;
  if (exportSelected.has(id)) {
    exportSelected.delete(id);
    card.classList.remove("export-selected");
  } else {
    exportSelected.add(id);
    card.classList.add("export-selected");
  }
  updateExportCount();
}

$("#btn-export-mode").addEventListener("click", () => {
  if (exportMode) exitExportMode();
  else enterExportMode();
});

const btnSelectMode = $("#btn-select-mode");
if (btnSelectMode) {
  btnSelectMode.addEventListener("click", () => {
    if (exportMode) exitExportMode();
    else enterExportMode();
  });
}

const btnDeleteSelected = $("#btn-delete-selected");
if (btnDeleteSelected) {
  btnDeleteSelected.addEventListener("click", async () => {
    const count = exportSelected.size;
    if (!count) {
      showToast("No challenges selected", "error");
      return;
    }
    if (!confirm(`Delete ${count} selected challenge(s) and their sessions? This cannot be undone.`)) return;
    const res = await api("/api/challenges/delete-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: Array.from(exportSelected) }),
    });
    if (res && res.ok) {
      showToast(`Deleted ${count} challenge(s)`, "success");
      exitExportMode();
      loadChallenges();
    } else {
      showToast((res && res.error) || "Failed to delete challenges", "error");
    }
  });
}

const btnClearAll = $("#btn-clear-all");
if (btnClearAll) {
  btnClearAll.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to delete ALL challenges and all sessions? This will completely clear the workstation. This cannot be undone.")) return;
    const res = await api("/api/challenges/delete-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    if (res && res.ok) {
      showToast("Cleared all challenges and sessions", "success");
      if (exportMode) exitExportMode();
      loadChallenges();
    } else {
      showToast((res && res.error) || "Failed to clear challenges", "error");
    }
  });
}

$("#btn-export-cancel").addEventListener("click", () => exitExportMode());

$("#btn-export-select-all").addEventListener("click", () => {
  const cards = $("#challenges-list").querySelectorAll(".challenge-card");
  const allSelected = exportSelected.size === cards.length && cards.length > 0;
  if (allSelected) {
    exportSelected.clear();
    cards.forEach((c) => c.classList.remove("export-selected"));
    $("#btn-export-select-all").textContent = "Select All";
  } else {
    cards.forEach((c) => {
      exportSelected.add(c.dataset.id);
      c.classList.add("export-selected");
    });
    $("#btn-export-select-all").textContent = "Deselect All";
  }
  updateExportCount();
});

function openExportOptions(ids, fromSelection = false) {
  pendingExportIds = ids;
  pendingExportFromSelection = fromSelection;
  const count = ids.length;
  $("#export-options-summary").textContent =
    `${count} challenge${count !== 1 ? "s" : ""} selected`;
  $("#export-include-streams").checked = true;
  $("#export-include-files").checked = true;
  $("#export-options-overlay").classList.remove("hidden");
}

function closeExportOptions() {
  $("#export-options-overlay").classList.add("hidden");
  pendingExportIds = [];
  pendingExportFromSelection = false;
}

function selectedExportOptions() {
  return {
    streams: $("#export-include-streams").checked,
    files: $("#export-include-files").checked,
  };
}

function exportOptionsParams(options) {
  const params = new URLSearchParams();
  params.set("streams", options.streams ? "1" : "0");
  params.set("files", options.files ? "1" : "0");
  return params.toString();
}

async function downloadExport(ids, options) {
  showToast(`Exporting ${ids.length} challenge${ids.length > 1 ? "s" : ""}...`);
  if (ids.length === 1) {
    const qs = exportOptionsParams(options);
    return fetch(`/api/challenges/${ids[0]}/export?${qs}`, {
      credentials: "same-origin",
    });
  }
  return api("/api/challenges/export", {
    method: "POST",
    body: JSON.stringify({ ids, ...options }),
  });
}

async function runPendingExport() {
  if (!pendingExportIds.length) return;
  const options = selectedExportOptions();
  if (!options.streams && !options.files) {
    showToast("Select at least one export content type", "error");
    return;
  }
  const ids = [...pendingExportIds];
  const shouldExitExportMode = pendingExportFromSelection;
  $("#btn-export-confirm").disabled = true;
  try {
    const resp = await downloadExport(ids, options);
    if (!resp || !resp.ok) { showToast("Export failed"); return; }
    const blob = await resp.blob();
    const cd = resp.headers.get("content-disposition") || "";
    const m = cd.match(/filename="([^"]+)"/);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : (ids.length === 1 ? "export.zip" : "ctf_export.zip");
    a.click();
    URL.revokeObjectURL(a.href);
    showToast("Export downloaded");
    closeExportOptions();
    if (shouldExitExportMode) exitExportMode();
  } catch (e) {
    showToast("Export failed: " + e.message, "error");
  } finally {
    $("#btn-export-confirm").disabled = false;
  }
}

$("#btn-export-download").addEventListener("click", () => {
  if (!exportSelected.size) return;
  openExportOptions([...exportSelected], true);
});

$("#export-options-close").addEventListener("click", closeExportOptions);
$("#export-options-overlay").addEventListener("click", (e) => {
  if (e.target === $("#export-options-overlay")) closeExportOptions();
});
$("#btn-export-confirm").addEventListener("click", runPendingExport);

// === Agent list for New Challenge ===
$("#btn-add-challenge-agent").addEventListener("click", () => {
  addAgentRow($("#challenge-agent-list"));
});

// === Add Challenge Dropdown ===
let savedConnections = [];

async function loadConnections() {
  const res = await api("/api/connections");
  if (!res) return;
  savedConnections = await res.json();
  setMetadataLastSync(newestConnectionSync(savedConnections));
  setMetadataSyncError(newestConnectionError(savedConnections));
  renderSyncConnections();
}

function renderSyncConnections() {
  const container = $("#sync-connections");
  const divider = $("#sync-divider");
  if (!savedConnections.length) {
    container.innerHTML = "";
    divider.classList.add("hidden");
    return;
  }
  divider.classList.remove("hidden");
  container.innerHTML = savedConnections.map((conn) => `
    <button class="dropdown-item dropdown-item-sync" data-conn-id="${esc(conn.id)}">
      Sync: ${esc(conn.label)}
    </button>
  `).join("");
  container.querySelectorAll(".dropdown-item-sync").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      $("#add-challenge-menu").classList.add("hidden");
      triggerSync(btn.dataset.connId);
    });
  });
}

async function triggerSync(connId) {
  showToast("Syncing...", "info");
  const res = await api("/api/connections/sync", {
    method: "POST",
    body: JSON.stringify({ id: connId }),
  });
  if (!res) return;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const savedConn = savedConnections.find((c) => c.id === connId);
    if (savedConn) {
      savedConn.last_error = err.last_error || err.error || "Sync failed";
      savedConn.last_error_at = err.last_error_at || new Date().toISOString();
      setMetadataSyncError(newestConnectionError(savedConnections));
    }
    showToast(err.error || "Sync failed", "error");
    return;
  }
  const data = await res.json();
  setMetadataLastSync(data.last_sync);
  const savedConn = savedConnections.find((c) => c.id === connId);
  if (savedConn && data.last_sync) {
    savedConn.last_sync = data.last_sync;
    delete savedConn.last_error;
    delete savedConn.last_error_at;
    setMetadataSyncError(newestConnectionError(savedConnections));
  }
  if (!data.challenges.length) {
    showToast(`No new challenges (${data.total} total on platform)`, "info");
    return;
  }
  if (data.new > 0) {
    showToast(`Found ${data.new} new unsolved challenge${data.new !== 1 ? "s" : ""}`, "success");
  } else if (data.skipped_solved > 0) {
    showToast(
      `No new unsolved challenges; ${data.skipped_solved} solved challenge${data.skipped_solved !== 1 ? "s" : ""} available in preview`,
      "info",
    );
  }

  // Open import modal in preview phase with the fetched challenges
  importPluginConfig = savedConnections.find((c) => c.id === connId)?.config || {};
  importFetchedChallenges = data.challenges;
  importChallengeSkillOverrides = new Map();
  const pluginName = data.connection.plugin;

  // Set up import modal
  await loadPlugins();
  const pluginSel = $("#import-plugin");
  pluginSel.value = pluginName;

  importPhase("preview");

  // Set up preview controls using saved agent settings
  populateAgentList($("#import-agent-list"));
  bindSkillSelection($("#import-skill-list"), { skills_mode: defaultSkillsMode, enabled_skills: defaultEnabledSkills });
  $("#import-flag").value = defaultFlagFormat;

  renderImportPreview();
  $("#import-overlay").classList.remove("hidden");
}

// === Auto-sync polling (every 5 minutes) ===
let _syncPollTimer = null;

async function pollConnections() {
  try {
    const res = await api("/api/connections/poll");
    if (!res || !res.ok) return;
    const data = await res.json();
    const bar = $("#sync-notify-bar");
    setMetadataLastSync(data.last_sync);
    if (data.errors && data.errors.length) {
      const newest = data.errors
        .map((err) => ({ ...err, atDate: parseServerTimestamp(err.at) }))
        .filter((err) => !Number.isNaN(err.atDate.getTime()))
        .sort((a, b) => b.atDate - a.atDate)[0];
      if (newest) {
        setMetadataSyncError({
          label: newest.label || newest.id || "connection",
          error: newest.error || "Sync failed",
          at: newest.atDate,
        });
      }
    } else if (data.last_sync) {
      setMetadataSyncError(null);
    }

    if (data.new_total > 0) {
      bar.innerHTML = `<span class="sync-notify-text">!! ${data.new_total} new challenge${data.new_total !== 1 ? "s" : ""} to sync !!</span><button class="sync-notify-close" title="Dismiss">&times;</button>`;
      bar.classList.remove("hidden");
      bar.querySelector(".sync-notify-close").addEventListener("click", (e) => {
        e.stopPropagation();
        bar.classList.add("hidden");
      });
    } else {
      bar.classList.add("hidden");
    }

    if (data.updates && data.updates.length) {
      loadChallenges();
    }
  } catch (_) {}
}

function startSyncPoll() {
  if (_syncPollTimer) return;
  _syncPollTimer = setInterval(pollConnections, 5 * 60 * 1000);
  setTimeout(pollConnections, 5000);
}

// Start polling once we're logged in
const _origLoadChallenges = loadChallenges;
loadChallenges = async function() {
  await _origLoadChallenges();
  startSyncPoll();
};

// Click notification bar to open sync dropdown
document.addEventListener("click", (e) => {
  if (e.target.id === "sync-notify-bar") {
    $("#add-challenge-menu").classList.remove("hidden");
  }
});

$("#btn-add-challenge").addEventListener("click", (e) => {
  e.stopPropagation();
  loadConnections();
  $("#add-challenge-menu").classList.toggle("hidden");
});
document.addEventListener("click", () => {
  $("#add-challenge-menu").classList.add("hidden");
});
$("#add-challenge-menu").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#add-challenge-menu").classList.add("hidden");
});

// === New Challenge Modal ===
$("#btn-new-challenge").addEventListener("click", () => {
  populateAgentList($("#challenge-agent-list"));
  bindSkillSelection($("#challenge-skill-list"), { skills_mode: defaultSkillsMode, enabled_skills: defaultEnabledSkills });
  $("#challenge-flag").value = defaultFlagFormat;
  populateRunTargets();
  $("#modal-overlay").classList.remove("hidden");
  $("#challenge-name").focus();
});

async function populateRunTargets() {
  const sel = $("#challenge-run-target");
  if (!sel) return;
  let options = '<option value="local">This host (local)</option>';
  try {
    const res = await api("/api/swarm");
    if (res && res.ok) {
      const data = await res.json();
      const running = (data.instances || []).filter((i) => i.status === "running");
      if (running.length) {
        options += '<option value="auto">Swarm — auto-pick free worker</option>';
        options += running.map((i) =>
          `<option value="${esc(i.name)}">Swarm — ${esc(i.name)}${i.challenge_id ? " (busy)" : ""}</option>`
        ).join("");
      }
    }
  } catch (_) { /* swarm not configured — local only */ }
  sel.innerHTML = options;
  renderGatewayStatus();
}
$("#modal-close").addEventListener("click", closeModal);
$("#modal-overlay").addEventListener("click", (e) => {
  if (e.target === $("#modal-overlay")) closeModal();
});

function closeModal() {
  $("#modal-overlay").classList.add("hidden");
  $("#challenge-form").reset();
  pendingChallengeUploads = [];
  $("#file-list").innerHTML = "";
}

// === File Upload / Drop Zone ===
const dropZone = $("#drop-zone");
const fileInput = $("#challenge-files");
let pendingChallengeUploads = [];

dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", async (e) => {
  e.preventDefault(); dropZone.classList.remove("dragover");
  pendingChallengeUploads = await collectUploadsFromDataTransfer(e.dataTransfer);
  updateFileList();
});
fileInput.addEventListener("change", () => {
  pendingChallengeUploads = Array.from(fileInput.files).map((file) => ({
    file,
    path: uploadPathForFile(file),
  }));
  updateFileList();
});

function normalizeUploadPath(path) {
  return (path || "").replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

function uploadPathForFile(file, fallbackPath = "") {
  return normalizeUploadPath(file.webkitRelativePath || fallbackPath || file.name) || file.name;
}

async function collectUploadsFromDataTransfer(dataTransfer) {
  const items = Array.from(dataTransfer.items || []);
  const entries = items
    .map((item) => item.webkitGetAsEntry ? item.webkitGetAsEntry() : null)
    .filter(Boolean);

  if (!entries.length) {
    return Array.from(dataTransfer.files || []).map((file) => ({
      file,
      path: uploadPathForFile(file),
    }));
  }

  const uploads = [];
  for (const entry of entries) {
    uploads.push(...await collectUploadsFromEntry(entry));
  }
  return uploads;
}

async function collectUploadsFromEntry(entry, prefix = "") {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      entry.file(
        (file) => resolve([{
          file,
          path: uploadPathForFile(file, `${prefix}${file.name}`),
        }]),
        reject,
      );
    });
  }

  if (!entry.isDirectory) return [];

  const children = await readAllDirectoryEntries(entry);
  const uploads = [];
  for (const child of children) {
    uploads.push(...await collectUploadsFromEntry(
      child,
      `${prefix}${entry.name}/`,
    ));
  }
  return uploads;
}

async function readAllDirectoryEntries(entry) {
  const reader = entry.createReader();
  const entries = [];
  while (true) {
    const batch = await new Promise((resolve, reject) =>
      reader.readEntries(resolve, reject)
    );
    if (!batch.length) return entries;
    entries.push(...batch);
  }
}

function updateFileList() {
  $("#file-list").innerHTML = pendingChallengeUploads
    .map(({ path }) => `<span>${esc(path)}</span>`).join("");
}

// === Create Challenge Submit ===
$("#challenge-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const agents = getAgentRows($("#challenge-agent-list"));
  if (!agents) return;
  const mode = agents.length > 1 ? "parallel" : "single";
  const fd = new FormData();
  fd.append("name", $("#challenge-name").value);
  fd.append("description", $("#challenge-desc").value);
  fd.append("flag_format", $("#challenge-flag").value);
  fd.append("mode", mode);
  fd.append("agents", JSON.stringify(agents));
  appendSkillSelection(fd, $("#challenge-skill-list"));
  const runTarget = $("#challenge-run-target");
  if (runTarget) fd.append("swarm_instance", runTarget.value || "local");

  for (const upload of pendingChallengeUploads) {
    fd.append("files", upload.file, upload.path);
  }

  await withBusy(e.submitter || $('#challenge-form button[type="submit"]'), async () => {
    const res = await api('/api/challenges', { method: 'POST', body: fd });
    if (!res || !res.ok) return;
    const data = await res.json();
    closeModal(); loadChallenges();
    if (data.id) openChallenge(data.id);
    else if (data.created?.length) openChallenge(data.created[0].id);
  }, 'Creating…');
});

// === Bulk Upload ===
const bulkOverlay = $("#bulk-overlay");
const bulkFileInput = $("#bulk-file");
const bulkDropZone = $("#bulk-drop-zone");
let bulkPreviewToken = null;
let bulkPreviewChallenges = [];
let bulkChallengeSkillOverrides = new Map();
let importChallengeSkillOverrides = new Map();
let challengeSkillEditTarget = null;

function challengeSkillOverrideMap(kind) {
  return kind === "import"
    ? importChallengeSkillOverrides
    : bulkChallengeSkillOverrides;
}

function challengeSkillDefaultSelection(kind) {
  return skillSelectionPayload(kind === "import" ? $("#import-skill-list") : $("#bulk-skill-list"));
}

function challengeSkillSummaryText(selection) {
  if (selection.skills_mode === "auto") return "Auto skills";
  const count = normalizeSkillNames(selection.enabled_skills).length;
  return count ? `Manual: ${count} skill${count !== 1 ? "s" : ""}` : "Manual: none";
}

function updateChallengeSkillSummary(kind, index) {
  const summary = document.querySelector(
    `.challenge-skill-summary[data-kind="${kind}"][data-index="${index}"]`
  );
  if (!summary) return;
  const overrideMap = challengeSkillOverrideMap(kind);
  const hasOverride = overrideMap.has(index);
  summary.textContent = hasOverride
    ? challengeSkillSummaryText(overrideMap.get(index))
    : "Default: " + challengeSkillSummaryText(challengeSkillDefaultSelection(kind));
  summary.classList.toggle("challenge-skill-summary-override", hasOverride);
}

function updateChallengeSkillSummaries(kind) {
  document
    .querySelectorAll(`.challenge-skill-summary[data-kind="${kind}"]`)
    .forEach((summary) => updateChallengeSkillSummary(kind, Number(summary.dataset.index)));
}

function openChallengeCreateSkillModal(kind, index, name) {
  const overrideMap = challengeSkillOverrideMap(kind);
  const selected = overrideMap.has(index)
    ? overrideMap.get(index)
    : challengeSkillDefaultSelection(kind);
  challengeSkillEditTarget = { kind, index };
  $("#challenge-create-skill-subtitle").textContent = name || "Challenge";
  bindSkillSelection($("#challenge-create-skill-list"), selected);
  $("#challenge-create-skill-overlay").classList.remove("hidden");
}

function closeChallengeCreateSkillModal() {
  challengeSkillEditTarget = null;
  $("#challenge-create-skill-overlay").classList.add("hidden");
}

function applyChallengeCreateSkillOverride() {
  if (!challengeSkillEditTarget) return;
  const { kind, index } = challengeSkillEditTarget;
  challengeSkillOverrideMap(kind).set(
    index,
    skillSelectionPayload($("#challenge-create-skill-list")),
  );
  updateChallengeSkillSummary(kind, index);
  closeChallengeCreateSkillModal();
}

function resetChallengeCreateSkillOverride() {
  if (!challengeSkillEditTarget) return;
  const { kind, index } = challengeSkillEditTarget;
  challengeSkillOverrideMap(kind).delete(index);
  updateChallengeSkillSummary(kind, index);
  closeChallengeCreateSkillModal();
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-challenge-skill-edit]");
  if (!btn) return;
  const kind = btn.dataset.kind === "import" ? "import" : "bulk";
  const index = Number(btn.dataset.index);
  const container = btn.closest(kind === "import" ? ".import-card" : ".bulk-ch-row");
  const nameInput = container?.querySelector(".bulk-ch-name");
  openChallengeCreateSkillModal(kind, index, nameInput?.value?.trim() || "");
});

$("#challenge-create-skill-close").addEventListener("click", closeChallengeCreateSkillModal);
$("#btn-challenge-create-skills-cancel").addEventListener("click", closeChallengeCreateSkillModal);
$("#btn-challenge-create-skills-apply").addEventListener("click", applyChallengeCreateSkillOverride);
$("#btn-challenge-create-skills-default").addEventListener("click", resetChallengeCreateSkillOverride);
$("#challenge-create-skill-overlay").addEventListener("click", (e) => {
  if (e.target === $("#challenge-create-skill-overlay")) closeChallengeCreateSkillModal();
});

function showBulkPhase(phase) {
  ["upload", "loading", "preview"].forEach((p) =>
    $("#bulk-phase-" + p).classList.toggle("hidden", p !== phase)
  );
}

function resetBulkModal() {
  bulkPreviewToken = null;
  bulkPreviewChallenges = [];
  bulkChallengeSkillOverrides = new Map();
  bulkFileInput.value = "";
  $("#bulk-file-name").innerHTML = "";
  $("#bulk-challenge-list").innerHTML = "";
  const pausedCb = $("#bulk-paused");
  if (pausedCb) pausedCb.checked = false;
  showBulkPhase("upload");
}

$("#btn-bulk-upload").addEventListener("click", () => {
  resetBulkModal();
  populateAgentList($("#bulk-agent-list"));
  bindSkillSelection($("#bulk-skill-list"), { skills_mode: defaultSkillsMode, enabled_skills: defaultEnabledSkills });
  $("#bulk-flag").value = defaultFlagFormat;
  bulkOverlay.classList.remove("hidden");
});
$("#bulk-close").addEventListener("click", closeBulkModal);
bulkOverlay.addEventListener("click", (e) => {
  if (e.target === bulkOverlay) closeBulkModal();
});

function closeBulkModal() {
  bulkOverlay.classList.add("hidden");
  resetBulkModal();
}

$("#btn-add-bulk-agent").addEventListener("click", () => {
  addAgentRow($("#bulk-agent-list"));
});

bulkDropZone.addEventListener("dragover", (e) => { e.preventDefault(); bulkDropZone.classList.add("dragover"); });
bulkDropZone.addEventListener("dragleave", () => bulkDropZone.classList.remove("dragover"));
bulkDropZone.addEventListener("drop", (e) => {
  e.preventDefault(); bulkDropZone.classList.remove("dragover");
  if (e.dataTransfer.files.length) triggerBulkPreview(e.dataTransfer.files[0]);
});
bulkFileInput.addEventListener("change", () => {
  if (bulkFileInput.files.length) triggerBulkPreview(bulkFileInput.files[0]);
});

async function triggerBulkPreview(file) {
  $("#bulk-file-name").innerHTML = `<span>${esc(file.name)}</span>`;
  showBulkPhase("loading");

  const fd = new FormData();
  fd.append("zipfile", file);
  const res = await api(
    "/api/challenges/bulk-preview",
    { method: "POST", body: fd },
  );
  if (!res || !res.ok) {
    showBulkPhase("upload");
    const err = res ? await res.json().catch(() => ({})) : {};
    showToast(err.error || "Preview failed", "error");
    return;
  }

  const data = await res.json();
  bulkPreviewToken = data.preview_token;
  bulkPreviewChallenges = data.challenges || [];
  bulkChallengeSkillOverrides = new Map();
  renderBulkPreview(bulkPreviewChallenges);
  showBulkPhase("preview");
}

function renderBulkPreview(challengesPreview) {
  const list = $("#bulk-challenge-list");
  list.innerHTML = challengesPreview.map((c, i) => {
    const fileLabel = c.files.length
      ? `${c.files.length} file${c.files.length !== 1 ? "s" : ""}: ${c.files.slice(0, 4).map(esc).join(", ")}${c.files.length > 4 ? ", ..." : ""}`
      : "No files";
    return `
    <div class="bulk-ch-row" data-index="${i}">
      <div class="bulk-ch-row-header">
        <input type="checkbox" class="bulk-ch-enabled" checked title="Include this challenge">
        <input type="text" class="bulk-ch-name" value="${esc(c.name)}" placeholder="Challenge name">
        <div class="challenge-skill-inline">
          <button type="button" class="btn-ghost btn-sm" data-challenge-skill-edit data-kind="bulk" data-index="${i}">Skills</button>
          <span class="challenge-skill-summary" data-kind="bulk" data-index="${i}">Default skills</span>
        </div>
        <span class="bulk-ch-files-label">${esc(fileLabel)}</span>
      </div>
      <div class="bulk-ch-row-body">
        <div class="bulk-ch-col">
          <div class="bulk-field-label">Description</div>
          <textarea class="bulk-ch-desc" rows="2">${esc(c.description || "")}</textarea>
        </div>
        <div class="bulk-ch-col bulk-ch-col-flag">
          <div class="bulk-field-label">Flag Format</div>
          <input type="text" class="bulk-ch-flag" placeholder="Inherits default">
        </div>
      </div>
    </div>`;
  }).join("");

  list.querySelectorAll(".bulk-ch-enabled").forEach((cb) =>
    cb.addEventListener("change", () => {
      cb.closest(".bulk-ch-row").classList.toggle(
        "bulk-ch-disabled",
        !cb.checked,
      );
      updateBulkSubmitLabel();
    })
  );

  const pausedCb = $("#bulk-paused");
  if (pausedCb) {
    pausedCb.removeEventListener("change", updateBulkSubmitLabel);
    pausedCb.addEventListener("change", updateBulkSubmitLabel);
  }
  updateChallengeSkillSummaries("bulk");
  updateBulkSubmitLabel();
}

function updateBulkSubmitLabel() {
  const selected = document.querySelectorAll(".bulk-ch-enabled:checked").length;
  const btn = $("#btn-bulk-submit");
  if (!btn) return;
  const startNow = !$("#bulk-paused") || !$("#bulk-paused").checked;
  const verb = startNow ? "Create & Solve" : "Create";
  btn.textContent = `${verb} ${selected} Challenge${selected !== 1 ? "s" : ""}`;
}

$("#btn-bulk-submit").addEventListener("click", async () => {
  if (!bulkPreviewToken) return;

  const agentRows = getAgentRows($("#bulk-agent-list"));
  if (!agentRows) return;
  const mode = agentRows.length > 1 ? "parallel" : "single";
  const rows = document.querySelectorAll(".bulk-ch-row");
  const challengeConfigs = Array.from(rows).map((row, i) => {
    const cfg = {
      folder_name: bulkPreviewChallenges[i].folder_name,
      name: row.querySelector(".bulk-ch-name").value.trim(),
      description: row.querySelector(".bulk-ch-desc").value.trim(),
      flag_format: row.querySelector(".bulk-ch-flag").value.trim(),
      enabled: row.querySelector(".bulk-ch-enabled").checked,
    };
    if (bulkChallengeSkillOverrides.has(i)) {
      Object.assign(cfg, bulkChallengeSkillOverrides.get(i));
    }
    return cfg;
  });

  const btn = $("#btn-bulk-submit");
  btn.dataset.busy = 'true';
  btn.disabled = true;
  btn.textContent = "Creating...";
  try {
    const res = await api("/api/challenges/bulk", {
      method: "POST",
      body: JSON.stringify({
        preview_token: bulkPreviewToken,
        flag_format: $("#bulk-flag").value.trim(),
        mode: mode,
        agents: JSON.stringify(agentRows),
        ...skillSelectionPayload($("#bulk-skill-list")),
        paused: $("#bulk-paused") ? $("#bulk-paused").checked : false,
        challenges: challengeConfigs,
      }),
    });
    if (!res || !res.ok) {
      return;
    }
    const data = await res.json();
    showToast(`Created ${data.created.length} challenge(s)`, "success");
    closeBulkModal();
    loadChallenges();
  } finally {
    delete btn.dataset.busy;
    renderGatewayStatus();
    updateBulkSubmitLabel();
  }
});

// === Detail View ===
async function openChallenge(id) {
  history.replaceState(null, "", `#/challenge/${id}`);
  currentChallengeId = id;
  stepCount = 0;
  pendingTools.clear();
  foundFlags.clear();
  flagDetails.clear();
  runToolCounts.clear();
  runStepCounts.clear();
  runStats.clear();
  statsUseSnapshot = false;
  if (statsRefreshTimer) {
    clearTimeout(statsRefreshTimer);
    statsRefreshTimer = null;
  }
  $("#manual-flag-input").value = "";
  $("#flags-list").innerHTML = "";
  $("#flags-section").classList.add("hidden");

  const res = await api(`/api/challenges/${encodeURIComponent(id)}`);
  if (!res) return;
  if (!res.ok) {
    showToast("Challenge could not be loaded", "error");
    return;
  }
  const c = await res.json();

  currentChallengeMode = c.mode || "single";
  currentRuns = (c.runs || []).map((run) => ({
    ...run,
    goal: normalizeRunGoal(run.goal),
  }));

  $("#detail-name").textContent = c.name;
  document.title = c.name ? `${c.name} - CTF Solver` : "CTF Solver";
  updateStatusBadge(c.status);

  // Mode badge
  const modeBadge = $("#detail-mode");
  modeBadge.textContent = currentChallengeMode.replace(/_/g, " ");

  // Model badge: show first run's model for single modes, run count for parallel
  const modelBadge = $("#detail-model");
  if (isParallelMode(currentChallengeMode)) {
    modelBadge.textContent = `${currentRuns.length} runs`;
    modelBadge.className = "badge badge-model";
  } else if (currentRuns.length > 0) {
    const run = currentRuns[0];
    const agentMeta = getAgentMeta(run.agent);
    if (agentMeta.badge_mode === "label") {
      modelBadge.textContent = agentMeta.label;
      modelBadge.className = `badge badge-agent-${run.agent}`;
    } else {
      modelBadge.textContent = run.model || agentMeta.default_model;
      modelBadge.className = "badge badge-model";
    }
  } else {
    modelBadge.textContent = "";
  }

  $("#detail-desc").textContent = c.description || "No description";
  challengeFlagFormat = c.flag_format || "";
  challengeFlagFormats = (c.flag_formats && c.flag_formats.length)
    ? c.flag_formats
    : (challengeFlagFormat ? [challengeFlagFormat] : []);
  $("#detail-flag-format").textContent = challengeFlagFormats.length
    ? `Flag: ${challengeFlagFormats.join(", ")}`
    : "";
  renderFlagFormats();
  $("#detail-files").textContent = c.files.length ? `Files: ${c.files.join(", ")}` : "No files";
  currentChallengeDefaultSkills = normalizeSkillNames(c.enabled_skills ?? []);
  currentChallengeSkillsMode = skillsMode(c);
  $("#detail-skill-mode").textContent = currentChallengeSkillsMode === "auto" ? "Auto — effective skills" : "Manual — exact skills";
  renderSkillReadonlyList($("#detail-skill-list"), currentChallengeDefaultSkills);

  const errorBanner = $("#error-banner");
  if (c.error) {
    errorBanner.textContent = c.error;
    errorBanner.classList.remove("hidden");
  } else {
    errorBanner.classList.add("hidden");
  }

  // Reset timer / cost
  lastThinkingEl = null;
  $("#detail-timer").textContent = "";
  foundFlags.clear(); flagDetails.clear(); $("#flags-list").innerHTML = ""; $("#flags-section").classList.add("hidden");
  clearTranscriptSearch();
  currentFlagQuestions = c.flag_questions || [];

  // Restore persisted flags
  const df = c.detected_flags || {};
  const flagMeta = c.detected_flag_meta || {};
  for (const [f, status] of Object.entries(df)) {
    showFlagBanner(f, flagMeta[f] || findFlagDetail(flagMeta, f) || {});
    if (status === "correct" || status === "wrong") setFlagStatus(f, status);
  }

  if (c.status === "solving") startTimer();
  else stopTimer();

  updateButtons(c.status);
  initRunTabs(currentRuns);
  $("#stats-panel").innerHTML = "";
  $("#files-tree").innerHTML = "";
  $("#files-breadcrumb").innerHTML = "";
  $("#file-counter").textContent = "0";
  fileBrowserPath = "";
  fileBrowserRequestToken++;
  updateCounters();
  showView("detail");
  switchTab("tab-info");
  updateSteerRunSelect();
  updateFilesRunSelect();
  connectAllRuns(id, currentRuns);
  // Seed stats from run metadata so the panel isn't blank for providers
  // that don't emit usage events (e.g. Codex without codex_usage).
  for (const run of currentRuns) {
    const s = getRunStats(run.id);
    if (run.duration_ms) s.durationMs = run.duration_ms;
  }
  renderStats();
  loadChallengeStatsSnapshot(id);
}

function updateStatusBadge(status) {
  const b = $("#detail-status");
  b.textContent = status;
  b.className = `badge badge-${status}`;
}

function updateButtons(status) {
  $("#btn-start").classList.toggle("hidden", status !== "pending");
  $("#btn-retry").classList.toggle("hidden", status !== "failed" && status !== "completed");
  $("#btn-resume").classList.toggle("hidden", status !== "failed" && status !== "completed");
  $("#btn-add-run").classList.toggle("hidden", status === "solved");
  $("#btn-unsolve").classList.toggle("hidden", status !== "solved");

  const stopBtn = $("#btn-stop");
  stopBtn.textContent = isParallelMode(currentChallengeMode) && currentRuns.length > 1
    ? "Stop All"
    : "Stop";
  stopBtn.classList.toggle("hidden", status !== "solving");
  updateRunControlButtons();
}

function updateCounters() {
  $("#step-counter").textContent = stepCount ? `${stepCount} steps` : "";
}

function durationMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function runTimerMs(run) {
  if (!run) return 0;
  let total = durationMs(run.duration_ms);
  if (run.status === "solving" && run._timerStartedAt) {
    total += Math.max(0, Date.now() - run._timerStartedAt);
  }
  return total;
}

function currentChallengeTimerMs() {
  return currentRuns.reduce((sum, run) => sum + runTimerMs(run), 0);
}

function activateRunTimer(run, reset = false) {
  if (!run) return;
  if (reset) run.duration_ms = 0;
  run.status = "solving";
  run._timerStartedAt = Date.now();
}

function freezeRunTimer(run) {
  if (!run || !run._timerStartedAt) return;
  run.duration_ms = runTimerMs(run);
  delete run._timerStartedAt;
}

function syncRunTimerState() {
  const now = Date.now();
  for (const run of currentRuns) {
    if (run.status === "solving") {
      if (!run._timerStartedAt) run._timerStartedAt = now;
    } else {
      freezeRunTimer(run);
    }
  }
}

function markRunsSolving(runId = "", options = {}) {
  for (const run of currentRuns) {
    if (runId && run.id !== runId) continue;
    if (run.status === "solved") continue;
    activateRunTimer(run, !!options.reset);
  }
}

function applyRunStatusEvent(event, fallbackRunId) {
  const rid = event.run_id || fallbackRunId;
  const run = currentRuns.find((r) => r.id === rid);
  if (!run) return;
  if (event.duration_ms !== undefined && event.duration_ms !== null) {
    run.duration_ms = durationMs(event.duration_ms);
  }
  if (event.status) run.status = event.status;
  if (run.status === "solving") {
    run._timerStartedAt = Date.now();
  } else {
    delete run._timerStartedAt;
  }
}

function canStopRun(run) {
  return !!run && run.status === "solving";
}

// === Detail Buttons ===
$("#btn-back").addEventListener("click", () => {
  disconnectAllWS(); stopTimer(); currentChallengeId = null;
  history.replaceState(null, "", "#");
  showView("dashboard"); loadChallenges();
});

async function solveChallenge(button, { retry = false, resume = false } = {}) {
  if (!currentChallengeId) return;
  await withBusy(button, async () => {
    const res = await api('/api/challenges/' + currentChallengeId + '/solve' + (resume ? '?resume=1' : ''), { method: 'POST' });
    if (!res || !res.ok) return;
    if (retry) {
      initRunTabs([]);
      $('#error-banner').classList.add('hidden');
      foundFlags.clear(); flagDetails.clear(); $('#flags-list').innerHTML = ''; $('#flags-section').classList.add('hidden');
      stepCount = 0; lastThinkingEl = null;
      pendingTools.clear(); runToolCounts.clear(); runStepCounts.clear(); runStats.clear(); statsUseSnapshot = false; updateCounters();
    }
    markRunsSolving('', { reset: retry });
    updateStatusBadge('solving'); updateButtons('solving'); startTimer();
    if (retry || resume) await openChallenge(currentChallengeId);
  });
}
$('#btn-start').addEventListener('click', e => solveChallenge(e.currentTarget));
$('#btn-retry').addEventListener('click', e => solveChallenge(e.currentTarget, {retry: true}));
$('#btn-resume').addEventListener('click', e => solveChallenge(e.currentTarget, {resume: true}));

$("#btn-unsolve").addEventListener("click", async () => {
  if (!currentChallengeId) return;
  const res = await api(`/api/challenges/${currentChallengeId}/unsolve`, { method: "POST" });
  if (res && res.ok) {
    openChallenge(currentChallengeId);
  }
});

async function stopRun(runId = "") {
  if (!currentChallengeId) return;
  const qs = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  const res = await api(
    `/api/challenges/${currentChallengeId}/stop${qs}`,
    { method: "POST" }
  );
  if (res && res.ok) {
    const data = await res.json().catch(() => ({}));
    const changedRunIds = Array.isArray(data.run_ids)
      ? data.run_ids
      : (runId ? [runId] : currentRuns.filter(canStopRun).map((r) => r.id));
    for (const rid of changedRunIds) {
      const run = currentRuns.find((r) => r.id === rid);
      if (!run) continue;
      freezeRunTimer(run);
      run.status = "failed";
      run.error = null;
      updateRunTabDot(rid, "failed");
    }
    if (data.status) {
      updateStatusBadge(data.status);
      updateButtons(data.status);
      if (["solved", "failed", "completed"].includes(data.status)) stopTimer();
      else startTimer();
    }
    updateRunControlButtons();
    updateTimer();
    if (changedRunIds.length) {
      showToast(
        runId ? "Agent stopped" : `Stopped ${changedRunIds.length} agent${changedRunIds.length === 1 ? "" : "s"}`,
        "info"
      );
    } else {
      showToast("No active agents stopped", "info");
    }
  } else if (res) {
    const data = await res.json().catch(() => ({}));
    showToast(data.error || "Failed to stop agent", "error");
  }
}

$("#btn-stop").addEventListener("click", async () => {
  await stopRun();
});

async function refreshAddRunPromptTemplate(options = {}) {
  if (!currentChallengeId) return;
  if (options.preserveDirty && addRunPromptDirty) return;
  const promptEl = $("#add-run-prompt");
  const token = ++addRunPromptTemplateToken;
  if (!options.silent) {
    promptEl.value = "Loading prompt template...";
  }
  const res = await api(
    `/api/challenges/${currentChallengeId}/prompt-template`,
    {
      method: "POST",
      body: JSON.stringify({
        ...skillSelectionPayload($("#add-run-skill-list")),
      }),
    }
  );
  if (token !== addRunPromptTemplateToken) return;
  if (!res) return;
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    showToast(data.error || "Failed to load prompt template", "error");
    return;
  }
  promptEl.value = data.prompt || "";
  addRunPromptDirty = false;
}

function openAddRunModal() {
  const list = $("#add-run-agent-list");
  list.innerHTML = "";
  const name = defaultAgent || primaryAgentName();
  addAgentRow(list, name);
  bindSkillSelection($("#add-run-skill-list"), { skills_mode: "inherit", enabled_skills: currentChallengeDefaultSkills });
  addRunPromptDirty = false;
  $("#add-run-prompt").value = "Loading prompt template...";
  $("#add-run-overlay").classList.remove("hidden");
  refreshAddRunPromptTemplate();
}

function closeAddRunModal() {
  $("#add-run-overlay").classList.add("hidden");
}

async function submitAddRun() {
  if (!currentChallengeId) return;
  const agents = getAgentRows($('#add-run-agent-list'));
  if (!agents) return;
  await withBusy($('#btn-add-run-submit'), async () => {
    const res = await api('/api/challenges/' + currentChallengeId + '/runs', { method: 'POST', body: JSON.stringify({ agents, prompt: $('#add-run-prompt').value.trim(), prompt_mode: 'full', ...skillSelectionPayload($('#add-run-skill-list')) }) });
    if (!res || !res.ok) return;
    const data = await res.json();
    closeAddRunModal();
    showToast('Added ' + (data.runs || []).length + ' agent(s)', 'success');
    await openChallenge(currentChallengeId);
  }, 'Adding…');
}

$("#btn-add-flag-format").addEventListener("click", addFlagFormatAndScan);
$("#flag-format-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addFlagFormatAndScan();
  }
});
$("#btn-add-manual-flag").addEventListener("click", addManualFlag);
$("#manual-flag-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addManualFlag();
  }
});


$("#btn-delete").addEventListener("click", async () => {
  if (!currentChallengeId) return;
  if (!confirm("Delete this challenge?")) return;
  await api(`/api/challenges/${currentChallengeId}`, { method: "DELETE" });
  disconnectAllWS(); stopTimer(); currentChallengeId = null;
  history.replaceState(null, "", "#");
  showView("dashboard"); loadChallenges();
});

// === WebSocket Per-Run ===
function setWsStatus(status) {
  const el = $("#ws-status");
  if (!el) return;
  el.className = `ws-indicator ws-${status}`;
  el.title = status === "connected" ? "Connected"
    : status === "reconnecting" ? "Reconnecting..." : "Disconnected";
}

function connectAllRuns(challengeId, runs) {
  disconnectAllWS();
  if (!runs || !runs.length) {
    setWsStatus("disconnected");
    return;
  }
  const token = historyLoadToken;
  (async () => {
    for (const run of runs) {
      if (token !== historyLoadToken || currentChallengeId !== challengeId) return;
      await loadInitialRunHistoryAndConnect(challengeId, run, token);
    }
  })();
}

function connectGlobalWS() {
  if (!appAlive) return;
  if (globalWs && globalWs.readyState <= WebSocket.OPEN) return;
  clearTimeout(globalWsReconnectTimer);
  globalWsReconnectTimer = null;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  globalWs = new WebSocket(`${proto}//${location.host}/ws/events`);
  globalWs.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === "flag_found") {
      if (event.challenge_id === currentChallengeId && event.flag) {
        showFlagBanner(event.flag, event.meta || {});
      }
      showFlagFoundToast(
        event.challenge_name || "Challenge",
        event.agent || "Agent",
        event.flag || "???",
        event.challenge_id
      );
    }
    if (event.type === "flag_result" && event.flag) {
      if (event.challenge_id === currentChallengeId) {
        if (event.flag_questions) {
          currentFlagQuestions = event.flag_questions;
          updateFlagTargetSelects();
        }
        setFlagStatus(event.flag, event.correct ? "correct" : "wrong", event.meta || null);
      }
    }
    if (event.type === "challenge_status" && event.challenge_id) {
      updateDashboardChallengeStatus(event.challenge_id, event.status);
    }
    if (event.type === "swarm_event") {
      handleSwarmEvent(event);
    }
  };
  globalWs.onclose = () => {
    globalWs = null;
    if (appAlive) globalWsReconnectTimer = setTimeout(connectGlobalWS, 3000);
  };
}

function disconnectGlobalWS() {
  clearTimeout(globalWsReconnectTimer);
  globalWsReconnectTimer = null;
  if (!globalWs) return;
  globalWs.onclose = null;
  globalWs.close();
  globalWs = null;
}

function updateDashboardChallengeStatus(challengeId, status) {
  const card = document.querySelector(`[data-id="${challengeId}"]`);
  if (!card) return;
  const badge = card.querySelector(".badge");
  if (!badge) return;
  badge.textContent = status;
  badge.className = "badge badge-" + status;
}

function isTranscriptEvent(event) {
  return ![
    "run_status",
    "challenge_status",
    "run_added",
    "flag_found",
  ].includes(event.type);
}

function rememberTranscriptEvent(runId, event) {
  if (!isTranscriptEvent(event)) return;
  const state = runHistoryState.get(runId) || {
    total: 0,
    nextBefore: null,
    hasMore: false,
    loading: false,
  };
  state.total = (state.total || 0) + 1;
  runHistoryState.set(runId, state);
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function fetchRunEvents(challengeId, runId, params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) qs.set(key, String(value));
  }
  const res = await api(
    `/api/challenges/${encodeURIComponent(challengeId)}/runs/${encodeURIComponent(runId)}/events?${qs}`
  );
  if (!res || !res.ok) {
    throw new Error(`failed to load transcript (${res ? res.status : "network"})`);
  }
  return res.json();
}

async function fetchFullToolOutput(ref) {
  if (!ref || !ref.url) throw new Error("missing full output reference");
  const res = await api(ref.url);
  if (!res || !res.ok) {
    throw new Error(`failed to load full output (${res ? res.status : "network"})`);
  }
  return res.text();
}

function transcriptNodeKey(runId, eventIndex) {
  return `${runId}:${eventIndex}`;
}

function markRenderedEventNodes(runId, eventIndex, feed, startNode) {
  if (!Number.isInteger(eventIndex) || !feed) return;
  const nodes = [];
  let node = startNode ? startNode.nextSibling : feed.firstChild;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      node.dataset.runId = runId;
      node.dataset.eventIndex = String(eventIndex);
      nodes.push(node);
    }
    node = node.nextSibling;
  }
  if (nodes.length) {
    renderedEventNodes.set(transcriptNodeKey(runId, eventIndex), nodes[0]);
  }
}

function renderRunEventWithIndex(runId, event, eventIndex = null) {
  const feed = document.getElementById(`feed-${runId}`) || document.getElementById("feed-__default__");
  const marker = feed ? feed.lastChild : null;
  renderRunEvent(runId, event);
  markRenderedEventNodes(runId, eventIndex, feed, marker);
}

async function renderEventsChunked(runId, events, options = {}) {
  if (!events || !events.length) return;
  const feed = document.getElementById(`feed-${runId}`) || document.getElementById("feed-__default__");
  if (!feed) return;

  const prepend = options.prepend === true;
  let insertMarker = null;
  let appendMarker = null;
  let previousHeight = 0;
  let previousTop = 0;
  if (prepend) {
    previousHeight = feed.scrollHeight;
    previousTop = feed.scrollTop;
    const historyControls = feed.querySelector(".history-load-controls");
    const insertBefore = historyControls ? historyControls.nextSibling : feed.firstChild;
    insertMarker = document.createComment("older-history-insert");
    appendMarker = document.createComment("older-history-append");
    feed.insertBefore(insertMarker, insertBefore);
    feed.appendChild(appendMarker);
  }

  historyRenderDepth++;
  if (options.suppressStateUpdates) suppressHistoricalStateUpdates++;
  try {
    for (let i = 0; i < events.length; i += TRANSCRIPT_RENDER_BATCH) {
      const chunk = events.slice(i, i + TRANSCRIPT_RENDER_BATCH);
      for (let j = 0; j < chunk.length; j++) {
        const eventIndex = Number.isInteger(options.startIndex)
          ? options.startIndex + i + j
          : null;
        renderRunEventWithIndex(runId, chunk[j], eventIndex);
      }
      if (!prepend && i + TRANSCRIPT_RENDER_BATCH < events.length) await yieldToBrowser();
    }
  } finally {
    if (options.suppressStateUpdates) suppressHistoricalStateUpdates--;
    historyRenderDepth--;
    if (prepend && insertMarker?.parentNode && appendMarker?.parentNode) {
      const fragment = document.createDocumentFragment();
      let node = appendMarker.nextSibling;
      while (node) {
        const next = node.nextSibling;
        fragment.appendChild(node);
        node = next;
      }
      appendMarker.remove();
      feed.insertBefore(fragment, insertMarker);
      insertMarker.remove();
      feed.scrollTop = previousTop + (feed.scrollHeight - previousHeight);
    }
    flushDeferredStats();
  }
}

function updateHistoryLoadButton(runId) {
  const feed = document.getElementById(`feed-${runId}`);
  if (!feed) return;
  const state = runHistoryState.get(runId);
  let controls = feed.querySelector(".history-load-controls");
  if (!state?.hasMore) {
    if (controls) controls.remove();
    return;
  }
  if (!controls) {
    controls = document.createElement("div");
    controls.className = "history-load-controls";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-ghost btn-sm history-load-btn";
    btn.addEventListener("click", () => loadOlderRunEvents(runId));

    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "btn-ghost btn-sm history-load-all-btn";
    allBtn.addEventListener("click", () => loadAllRunEvents(runId));

    controls.append(btn, allBtn);
    feed.insertBefore(controls, feed.firstChild);
  }
  const btn = controls.querySelector(".history-load-btn");
  const allBtn = controls.querySelector(".history-load-all-btn");
  if (btn) {
    btn.disabled = !!state.loading;
    btn.textContent = state.loadingAll
      ? "Loading older messages..."
      : state.loading ? "Loading older messages..." : "Load older messages";
  }
  if (allBtn) {
    allBtn.disabled = !!state.loading;
    allBtn.textContent = state.loadingAll ? "Loading all messages..." : "Load All Messages";
  }
}

async function loadHistoryPage(runId, state, challengeId, token, limit) {
  const data = await fetchRunEvents(challengeId, runId, {
    before: state.nextBefore,
    limit,
  });
  if (token !== historyLoadToken || currentChallengeId !== challengeId) return false;
  state.total = Math.max(state.total || 0, data.total || 0);
  state.nextBefore = data.next_before;
  state.hasMore = !!data.has_more;
  await renderEventsChunked(runId, data.events || [], {
    prepend: true,
    startIndex: data.start || 0,
    suppressStateUpdates: true,
  });
  return true;
}

async function loadOlderRunEvents(runId) {
  const state = runHistoryState.get(runId);
  if (!state || !state.hasMore || state.loading || !currentChallengeId) return;
  const challengeId = currentChallengeId;
  const token = historyLoadToken;
  state.loading = true;
  state.loadingAll = false;
  updateHistoryLoadButton(runId);
  historyLoadingRuns.add(runId);
  try {
    await loadHistoryPage(runId, state, challengeId, token, TRANSCRIPT_PAGE_EVENTS);
  } catch (err) {
    console.warn("Failed to load older transcript events", err);
    showToast("Failed to load older messages", "error");
  } finally {
    state.loading = false;
    state.loadingAll = false;
    historyLoadingRuns.delete(runId);
    updateHistoryLoadButton(runId);
  }
}

async function loadAllRunEvents(runId) {
  const state = runHistoryState.get(runId);
  if (!state || !state.hasMore || state.loading || !currentChallengeId) return;
  const challengeId = currentChallengeId;
  const token = historyLoadToken;
  state.loading = true;
  state.loadingAll = true;
  updateHistoryLoadButton(runId);
  historyLoadingRuns.add(runId);
  try {
    while (
      state.hasMore &&
      token === historyLoadToken &&
      currentChallengeId === challengeId
    ) {
      const loaded = await loadHistoryPage(runId, state, challengeId, token, 500);
      if (!loaded || !state.hasMore) break;
      await yieldToBrowser();
    }
  } catch (err) {
    console.warn("Failed to load full transcript", err);
    showToast("Failed to load all messages", "error");
  } finally {
    state.loading = false;
    state.loadingAll = false;
    historyLoadingRuns.delete(runId);
    updateHistoryLoadButton(runId);
  }
}

async function loadRunEventsThrough(runId, eventIndex) {
  let state = runHistoryState.get(runId);
  while (
    state &&
    state.hasMore &&
    !state.loading &&
    Number.isInteger(state.nextBefore) &&
    state.nextBefore > eventIndex
  ) {
    await loadOlderRunEvents(runId);
    state = runHistoryState.get(runId);
  }
}

async function loadInitialRunHistoryAndConnect(challengeId, run, token) {
  const runId = run.id;
  const state = {
    total: 0,
    nextBefore: null,
    hasMore: false,
    loading: true,
    loadingAll: false,
  };
  runHistoryState.set(runId, state);
  historyLoadingRuns.add(runId);
  updateHistoryLoadButton(runId);

  try {
    const data = await fetchRunEvents(challengeId, runId, {
      limit: INITIAL_TRANSCRIPT_EVENTS,
    });
    if (token !== historyLoadToken || currentChallengeId !== challengeId) return;

    state.total = data.total || 0;
    state.nextBefore = data.next_before;
    state.hasMore = !!data.has_more;
    state.loading = false;
    await renderEventsChunked(runId, data.events || [], {
      startIndex: data.start || 0,
    });
    updateHistoryLoadButton(runId);
    connectRunWS(challengeId, runId, run.agent, { after: state.total || 0 });
  } catch (err) {
    console.warn("Failed to load initial transcript history", err);
    if (token !== historyLoadToken || currentChallengeId !== challengeId) return;
    state.loading = false;
    historyLoadingRuns.delete(runId);
    updateHistoryLoadButton(runId);
    showToast("Failed to load transcript history; live updates still connected", "error");
    connectRunWS(challengeId, runId, run.agent, { history: false });
  }
}

async function searchTranscript() {
  const input = $("#transcript-search-input");
  const resultsEl = $("#transcript-search-results");
  const clearBtn = $("#btn-transcript-search-clear");
  if (!input || !resultsEl || !currentChallengeId) return;
  const query = input.value.trim();
  transcriptSearchResults = [];
  transcriptSearchActiveIndex = -1;
  if (!query) {
    resultsEl.classList.add("hidden");
    clearTranscriptSearchHighlight();
    if (clearBtn) clearBtn.classList.add("hidden");
    return;
  }

  resultsEl.classList.remove("hidden");
  resultsEl.innerHTML = '<div class="transcript-search-summary">Searching...</div>';
  if (clearBtn) clearBtn.classList.remove("hidden");
  const qs = new URLSearchParams({ q: query, limit: "100" });
  const res = await api(`/api/challenges/${currentChallengeId}/transcript-search?${qs}`);
  if (!res || !res.ok) {
    resultsEl.innerHTML = '<div class="transcript-search-summary">Search failed</div>';
    return;
  }
  renderTranscriptSearchResults(await res.json());
}

function renderTranscriptSearchResults(data) {
  const resultsEl = $("#transcript-search-results");
  if (!resultsEl) return;
  transcriptSearchResults = data.matches || [];
  transcriptSearchActiveIndex = -1;
  if (!transcriptSearchResults.length) {
    resultsEl.innerHTML = '<div class="transcript-search-summary">No matches</div>';
    return;
  }
  const suffix = data.truncated ? " shown, refine search for more" : "";
  resultsEl.innerHTML = `
    <div class="transcript-search-summary">${transcriptSearchResults.length} match${transcriptSearchResults.length !== 1 ? "es" : ""}${suffix}</div>
    ${transcriptSearchResults.map((match, idx) => `
      <button class="transcript-search-result" data-index="${idx}">
        <span class="transcript-search-result-meta">${esc(runLabelForSearch(match.run_id, match.run_label))} &middot; event ${match.event_index} &middot; ${esc(match.event_type || "event")}</span>
        <span class="transcript-search-result-preview">${esc(match.preview || "")}</span>
      </button>
    `).join("")}
  `;
  resultsEl.querySelectorAll(".transcript-search-result").forEach((btn) => {
    btn.addEventListener("click", () => {
      focusTranscriptSearchResult(Number(btn.dataset.index));
    });
  });
}

function runLabelForSearch(runId, fallback) {
  const run = currentRuns.find((r) => r.id === runId);
  if (!run) return fallback || runId;
  const meta = getAgentMeta(run.agent);
  return meta.label || run.agent || fallback || runId;
}

function clearTranscriptSearchHighlight() {
  document.querySelectorAll(".transcript-search-hit").forEach((el) =>
    el.classList.remove("transcript-search-hit")
  );
}

async function focusTranscriptSearchResult(index) {
  const result = transcriptSearchResults[index];
  if (!result) return;
  transcriptSearchActiveIndex = index;
  await focusTranscriptEvent(result.run_id, result.event_index);
}

async function focusTranscriptEvent(runId, eventIndex) {
  if (!isSplitView() && activeRunId !== runId) switchRunTab(runId);

  let node = renderedEventNodes.get(transcriptNodeKey(runId, eventIndex));
  if (!node) {
    await loadRunEventsThrough(runId, eventIndex);
    node = renderedEventNodes.get(transcriptNodeKey(runId, eventIndex));
  }
  if (!node) {
    showToast("Transcript event is not loaded yet", "info");
    return;
  }
  clearTranscriptSearchHighlight();
  node.classList.add("transcript-search-hit");
  node.scrollIntoView({ block: "center", behavior: "smooth" });
}

function clearTranscriptSearch() {
  const input = $("#transcript-search-input");
  const resultsEl = $("#transcript-search-results");
  const clearBtn = $("#btn-transcript-search-clear");
  if (input) input.value = "";
  if (resultsEl) resultsEl.classList.add("hidden");
  if (clearBtn) clearBtn.classList.add("hidden");
  transcriptSearchResults = [];
  transcriptSearchActiveIndex = -1;
  clearTranscriptSearchHighlight();
}

function enqueueRunEvent(runId, event, afterRender) {
  queuedRunEvents.push({ runId, event, afterRender });
  if (queuedRunEventFrame) return;
  queuedRunEventFrame = true;
  requestAnimationFrame(flushQueuedRunEvents);
}

function renderQueuedRunItem(item) {
  const state = runHistoryState.get(item.runId);
  const eventIndex = isTranscriptEvent(item.event) && state
    ? state.total || 0
    : null;
  renderRunEventWithIndex(item.runId, item.event, eventIndex);
  if (item.afterRender) item.afterRender(item.event);
}

function flushQueuedRunEventsNow(runId) {
  if (!queuedRunEvents.length) return;
  const remaining = [];
  for (const item of queuedRunEvents) {
    if (runId == null || item.runId === runId) renderQueuedRunItem(item);
    else remaining.push(item);
  }
  queuedRunEvents = remaining;
  if (!queuedRunEvents.length) queuedRunEventFrame = false;
}

function flushQueuedRunEvents() {
  queuedRunEventFrame = false;
  const batch = queuedRunEvents.splice(0, LIVE_RENDER_BATCH);
  for (const item of batch) {
    renderQueuedRunItem(item);
  }
  if (queuedRunEvents.length) {
    queuedRunEventFrame = true;
    requestAnimationFrame(flushQueuedRunEvents);
  }
}

function connectRunWS(challengeId, runId, agentLabel, options = {}) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams();
  if (Number.isInteger(options.after)) {
    params.set("after", String(options.after));
  } else if (options.history === false) {
    params.set("history", "0");
  }
  const qs = params.toString();
  const ws = new WebSocket(
    `${proto}//${location.host}/ws/${encodeURIComponent(challengeId)}/${encodeURIComponent(runId)}${qs ? `?${qs}` : ""}`
  );
  let hydrating = true;
  historyLoadingRuns.add(runId);
  ws.onopen = () => {
    setWsStatus("connected");
  };
  ws.onmessage = (e) => {
    const event = JSON.parse(e.data);
    enqueueRunEvent(runId, event, (rendered) => {
      if (hydrating && rendered.type === "run_status") {
        hydrating = false;
        finishHistoryLoad(runId);
      } else {
        rememberTranscriptEvent(runId, rendered);
      }
    });
  };
  ws.onclose = () => {
    historyLoadingRuns.delete(runId);
    flushQueuedRunEventsNow(runId);
    if (currentChallengeId !== challengeId) return;
    // Don't reconnect if the run is in a terminal state
    const run = currentRuns.find(r => r.id === runId);
    if (run && ["solved", "completed", "failed"].includes(run.status)) return;
    // Check if any other connection is still open
    let anyOpen = false;
    for (const [rid, conn] of wsConnections) {
      if (rid !== runId && conn.readyState === WebSocket.OPEN) {
        anyOpen = true;
        break;
      }
    }
    if (!anyOpen) setWsStatus("reconnecting");
    setTimeout(() => {
      if (currentChallengeId === challengeId) {
        const state = runHistoryState.get(runId);
        connectRunWS(challengeId, runId, agentLabel, state ? { after: state.total || 0 } : undefined);
      }
    }, 2000);
  };
  wsConnections.set(runId, ws);
}

function disconnectAllWS() {
  disconnectAdvisorWS();
  historyLoadToken++;
  historyLoadingRuns.clear();
  runHistoryState.clear();
  renderedEventNodes.clear();
  queuedRunEvents = [];
  queuedRunEventFrame = false;
  if (statsRefreshTimer) {
    clearTimeout(statsRefreshTimer);
    statsRefreshTimer = null;
  }
  pendingScrollRuns.clear();
  scrollFramePending = false;
  for (const [, ws] of wsConnections) {
    ws.onclose = null;
    ws.close();
  }
  wsConnections.clear();
  setWsStatus("disconnected");
}

// === Scroll ===
function getActiveFeed() {
  if (!activeRunId) return null;
  return document.getElementById(`feed-${activeRunId}`);
}

function setupFeedScroll(feedEl) {
  if (!feedEl) return;
  feedEl.addEventListener("scroll", () => {
    autoScroll = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 50;
    updateScrollBtn();
  });
}

function updateScrollBtn() {
  const btn = $("#btn-scroll-bottom");
  if (btn) btn.classList.toggle("hidden", autoScroll);
}

function scrollBottom() {
  const f = getActiveFeed();
  if (autoScroll && f) f.scrollTop = f.scrollHeight;
}

function flushPendingScrolls() {
  scrollFramePending = false;
  if (!autoScroll) {
    updateScrollBtn();
    pendingScrollRuns.clear();
    return;
  }
  if (isSplitView()) {
    for (const rid of pendingScrollRuns) {
      const f = document.getElementById(`feed-${rid}`);
      if (f) f.scrollTop = f.scrollHeight;
    }
  } else if (pendingScrollRuns.has(activeRunId)) {
    scrollBottom();
  }
  pendingScrollRuns.clear();
  updateScrollBtn();
}

function scrollBottomIfActive(runId) {
  if (historyLoadingRuns.has(runId)) return;
  if (!isSplitView() && runId !== activeRunId) return;
  pendingScrollRuns.add(runId);
  if (!scrollFramePending) {
    scrollFramePending = true;
    requestAnimationFrame(flushPendingScrolls);
  }
}

function finishHistoryLoad(runId) {
  historyLoadingRuns.delete(runId);
  requestAnimationFrame(() => {
    if (!autoScroll) {
      updateScrollBtn();
      return;
    }
    const f = document.getElementById(`feed-${runId}`);
    if (f && (isSplitView() || runId === activeRunId)) {
      f.scrollTop = f.scrollHeight;
    }
    updateScrollBtn();
  });
}

// === Run Tabs ===
function isSplitView() {
  return chatViewMode === "split" && currentRuns.length > 1;
}

function runTabLabel(run, agentMeta) {
  const base = agentMeta.label || run.agent;
  const parts = [];
  if (run.model) parts.push(run.model);
  if (run.effort) parts.push(run.effort);
  return parts.length ? `${base} (${parts.join(", ")})` : base;
}

function normalizeRunGoal(goal) {
  if (!goal || typeof goal !== "object") return null;
  const textField = (snake, camel = null) => {
    const value = goal[snake] ?? (camel ? goal[camel] : undefined);
    return typeof value === "string" ? value.trim() : "";
  };
  const intField = (snake, camel = null) => {
    const value = goal[snake] ?? (camel ? goal[camel] : undefined);
    return Number.isFinite(value) ? Math.trunc(value) : null;
  };
  const normalized = {
    provider: textField("provider"),
    thread_id: textField("thread_id", "threadId"),
    objective: textField("objective"),
    status: textField("status"),
    token_budget: intField("token_budget", "tokenBudget"),
    tokens_used: intField("tokens_used", "tokensUsed"),
    time_used_seconds: intField("time_used_seconds", "timeUsedSeconds"),
    created_at: intField("created_at", "createdAt"),
    updated_at: intField("updated_at", "updatedAt"),
  };
  if (!normalized.objective && !normalized.status) return null;
  return normalized;
}

function goalStatusLabel(status) {
  const labels = {
    active: "Active",
    paused: "Paused",
    blocked: "Blocked",
    usageLimited: "Usage Limited",
    usage_limited: "Usage Limited",
    budgetLimited: "Budget Limited",
    budget_limited: "Budget Limited",
    complete: "Complete",
  };
  return labels[status] || (status ? status.replace(/[_-]+/g, " ") : "Goal");
}

function goalStatusClass(status) {
  if (status === "complete") return "goal-status-complete";
  if (status === "paused") return "goal-status-paused";
  if (["blocked", "usageLimited", "usage_limited", "budgetLimited", "budget_limited"].includes(status)) {
    return "goal-status-warning";
  }
  return "goal-status-active";
}

function formatGoalUsage(goal) {
  const parts = [];
  const used = Number.isFinite(goal.tokens_used) ? goal.tokens_used : null;
  const budget = Number.isFinite(goal.token_budget) ? goal.token_budget : null;
  if (budget !== null) {
    parts.push(`${(used || 0).toLocaleString()}/${budget.toLocaleString()} tokens`);
  } else if (used) {
    parts.push(`${used.toLocaleString()} tokens`);
  }
  if (Number.isFinite(goal.time_used_seconds) && goal.time_used_seconds > 0) {
    parts.push(fmtElapsed(goal.time_used_seconds));
  }
  return parts.join(" · ");
}

function canEditRunGoal(run) {
  return !!run && run.agent === "codex" && (!!run.goal_editable || !!run.goal);
}

function createGoalBar(runId, extraClass = "") {
  const bar = document.createElement("div");
  bar.className = `goal-bar hidden${extraClass ? ` ${extraClass}` : ""}`;
  bar.dataset.run = runId;
  return bar;
}

function updateGoalBarForRun(bar, run) {
  if (!bar) return;
  const goal = normalizeRunGoal(run?.goal);
  const editable = canEditRunGoal(run);
  if (!goal && !editable) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    bar.removeAttribute("title");
    return;
  }
  const statusClass = goal ? goalStatusClass(goal.status) : "goal-status-paused";
  const usage = goal ? formatGoalUsage(goal) : "";
  bar.className = `${bar.classList.contains("split-goal-bar") ? "goal-bar split-goal-bar" : "goal-bar"} ${statusClass}`;
  bar.title = goal?.objective || "No goal set";
  bar.innerHTML = `
    <span class="goal-label">Goal</span>
    <span class="goal-status">${esc(goal ? goalStatusLabel(goal.status) : "None")}</span>
    <span class="goal-objective">${esc(goal?.objective || "No goal set")}</span>
    ${usage ? `<span class="goal-usage">${esc(usage)}</span>` : ""}
    ${editable ? `<span class="goal-actions"><button type="button" class="btn-ghost btn-xs goal-edit-btn" data-run="${esc(run.id)}">Edit</button></span>` : ""}
  `;
}

function updateGoalBars() {
  const globalBar = $("#goal-bar");
  const activeRun = currentRuns.find((r) => r.id === activeRunId);
  if (globalBar) updateGoalBarForRun(globalBar, isSplitView() ? null : activeRun);

  document.querySelectorAll(".split-goal-bar").forEach((bar) => {
    const run = currentRuns.find((r) => r.id === bar.dataset.run);
    updateGoalBarForRun(bar, run);
  });
}

function initRunTabs(runs) {
  currentRuns = runs;
  const tabBar = $("#run-tabs");
  const feedsEl = $("#run-feeds");

  // Clear existing feeds but keep the scroll button
  tabBar.innerHTML = "";
  const scrollBtn = feedsEl.querySelector("#btn-scroll-bottom");
  feedsEl.innerHTML = "";
  if (scrollBtn) feedsEl.appendChild(scrollBtn);

  // Remove split mode classes
  feedsEl.classList.remove("split-mode");
  delete feedsEl.dataset.panes;
  tabBar.classList.remove("hidden");

  if (!runs.length) {
    // Create a default placeholder feed
    activeRunId = "__default__";
    const btn = document.createElement("button");
    btn.className = "run-tab active";
    btn.dataset.run = "__default__";
    btn.innerHTML = '<span class="run-tab-dot dot-running"></span>Main';
    tabBar.appendChild(btn);

    const feed = document.createElement("div");
    feed.id = "feed-__default__";
    feed.className = "panel-body run-feed active";
    feedsEl.insertBefore(feed, scrollBtn);
    setupFeedScroll(feed);
    updateGoalBars();
    return;
  }

  activeRunId = runs[0].id;
  const useSplit = chatViewMode === "split" && runs.length > 1;

  const globalSteer = $("#steer-bar");
  if (useSplit) {
    feedsEl.classList.add("split-mode");
    feedsEl.dataset.panes = String(runs.length);
    tabBar.classList.add("hidden");
    globalSteer.classList.add("hidden");
  } else {
    globalSteer.classList.remove("hidden");
  }

  for (const run of runs) {
    const agentMeta = getAgentMeta(run.agent);
    const label = runTabLabel(run, agentMeta);
    const dotClass = run.status === "solving" ? "dot-running"
      : run.status === "solved" ? "dot-solved"
      : run.status === "failed" ? "dot-error"
      : run.status === "completed" ? "dot-done"
      : run.status === "pending" ? "dot-pending"
      : "dot-running";

    if (!useSplit) {
      const btn = document.createElement("button");
      btn.className = `run-tab${run.id === activeRunId ? " active" : ""}`;
      btn.dataset.run = run.id;
      btn.innerHTML = `<span class="run-tab-dot ${dotClass}"></span>${esc(label)}`;
      btn.addEventListener("click", () => switchRunTab(run.id));
      tabBar.appendChild(btn);
    }

    if (useSplit) {
      const pane = document.createElement("div");
      pane.className = "split-pane";
      pane.innerHTML = `<div class="split-pane-header"><span class="run-tab-dot ${dotClass}"></span><span class="split-pane-title">${esc(label)}</span><span class="split-pane-actions"><button type="button" class="btn-ghost btn-xs split-skill-btn">Skills</button><button type="button" class="btn-danger btn-xs split-run-stop-btn" data-run="${esc(run.id)}">Stop</button></span></div>`;
      pane.querySelector(".split-skill-btn").addEventListener("click", () => {
        openRunSkillsModal(run.id);
      });
      pane.querySelector(".split-run-stop-btn").addEventListener("click", () => {
        stopRun(run.id);
      });
      const feed = document.createElement("div");
      feed.id = `feed-${run.id}`;
      feed.className = "panel-body run-feed active";
      pane.appendChild(feed);

      const goalBar = createGoalBar(run.id, "split-goal-bar");
      updateGoalBarForRun(goalBar, run);
      pane.appendChild(goalBar);

      const steer = document.createElement("div");
      steer.className = "steer-bar split-steer";
      steer.innerHTML = `<input type="text" class="split-steer-input" placeholder="Guide ${esc(label)}..." autocomplete="off"><button class="btn-primary btn-sm split-steer-btn">Send</button>`;
      const steerInput = steer.querySelector(".split-steer-input");
      const steerBtn = steer.querySelector(".split-steer-btn");
      const sendFn = () => sendSteerToRun(run.id, steerInput);
      steerBtn.addEventListener("click", sendFn);
      steerInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFn(); }
      });
      pane.appendChild(steer);

      feedsEl.insertBefore(pane, scrollBtn);
      setupFeedScroll(feed);
    } else {
      const feed = document.createElement("div");
      feed.id = `feed-${run.id}`;
      feed.className = `panel-body run-feed${run.id === activeRunId ? " active" : ""}`;
      feedsEl.insertBefore(feed, scrollBtn);
      setupFeedScroll(feed);
    }
  }
  updateGoalBars();
}

function switchRunTab(runId) {
  activeRunId = runId;
  document.querySelectorAll(".run-tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".run-feed").forEach((f) => f.classList.remove("active"));
  const btn = document.querySelector(`[data-run="${runId}"]`);
  if (btn) btn.classList.add("active");
  const feed = document.getElementById(`feed-${runId}`);
  if (feed) { feed.classList.add("active"); autoScroll = true; scrollBottom(); }
  updateSteerRunSelect();
  updateGoalBars();
}

function addRunTab(run) {
  const tabBar = $("#run-tabs");
  const feedsEl = $("#run-feeds");
  const scrollBtn = feedsEl.querySelector("#btn-scroll-bottom");

  const agentMeta = getAgentMeta(run.agent);
  const label = runTabLabel(run, agentMeta);
  const dotClass = run.status === "solving" ? "dot-running"
    : run.status === "solved" ? "dot-solved"
    : run.status === "failed" ? "dot-error"
    : run.status === "completed" ? "dot-done"
    : run.status === "pending" ? "dot-pending"
    : "dot-running";

  const useSplit = isSplitView();

  if (!useSplit) {
    const btn = document.createElement("button");
    btn.className = "run-tab";
    btn.dataset.run = run.id;
    btn.innerHTML = `<span class="run-tab-dot ${dotClass}"></span>${esc(label)}`;
    btn.addEventListener("click", () => switchRunTab(run.id));
    tabBar.appendChild(btn);

    const feed = document.createElement("div");
    feed.id = `feed-${run.id}`;
    feed.className = "panel-body run-feed";
    feedsEl.insertBefore(feed, scrollBtn);
    setupFeedScroll(feed);
  } else {
    const pane = document.createElement("div");
    pane.className = "split-pane";
    pane.innerHTML = `<div class="split-pane-header"><span class="run-tab-dot ${dotClass}"></span><span class="split-pane-title">${esc(label)}</span><span class="split-pane-actions"><button type="button" class="btn-ghost btn-xs split-skill-btn">Skills</button><button type="button" class="btn-danger btn-xs split-run-stop-btn" data-run="${esc(run.id)}">Stop</button></span></div>`;
    pane.querySelector(".split-skill-btn").addEventListener("click", () => {
      openRunSkillsModal(run.id);
    });
    pane.querySelector(".split-run-stop-btn").addEventListener("click", () => {
      stopRun(run.id);
    });
    const feed = document.createElement("div");
    feed.id = `feed-${run.id}`;
    feed.className = "panel-body run-feed active";
    pane.appendChild(feed);

    const goalBar = createGoalBar(run.id, "split-goal-bar");
    updateGoalBarForRun(goalBar, run);
    pane.appendChild(goalBar);

    const steer = document.createElement("div");
    steer.className = "steer-bar split-steer";
    steer.innerHTML = `<input type="text" class="split-steer-input" placeholder="Guide ${esc(label)}..." autocomplete="off"><button class="btn-primary btn-sm split-steer-btn">Send</button>`;
    const steerInput = steer.querySelector(".split-steer-input");
    const steerBtn = steer.querySelector(".split-steer-btn");
    const sendFn = () => sendSteerToRun(run.id, steerInput);
    steerBtn.addEventListener("click", sendFn);
    steerInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFn(); }
    });
    pane.appendChild(steer);

    feedsEl.insertBefore(pane, scrollBtn);
    setupFeedScroll(feed);
  }
  updateGoalBars();
}

function updateRunTabDot(runId, status) {
  const dotMap = {
    solved: "dot-solved",
    failed: "dot-error",
    error: "dot-error",
    solving: "dot-running",
    completed: "dot-done",
    pending: "dot-pending",
  };
  const cls = `run-tab-dot ${dotMap[status] || "dot-done"}`;

  // Tab button dot
  const btn = document.querySelector(`[data-run="${runId}"]`);
  if (btn) {
    const dot = btn.querySelector(".run-tab-dot");
    if (dot) dot.className = cls;
  }
  // Split pane header dot
  const feed = document.getElementById(`feed-${runId}`);
  if (feed) {
    const pane = feed.closest(".split-pane");
    if (pane) {
      const dot = pane.querySelector(".run-tab-dot");
      if (dot) dot.className = cls;
    }
  }
}

function updateRunControlButtons() {
  const activeStopBtn = $("#btn-active-run-stop");
  if (activeStopBtn) {
    const activeRun = currentRuns.find((r) => r.id === activeRunId);
    const showActiveStop = isParallelMode(currentChallengeMode)
      && currentRuns.length > 1
      && canStopRun(activeRun);
    activeStopBtn.classList.toggle("hidden", !showActiveStop);
    activeStopBtn.disabled = !showActiveStop;
  }

  document.querySelectorAll(".split-run-stop-btn").forEach((btn) => {
    const run = currentRuns.find((r) => r.id === btn.dataset.run);
    const canStop = canStopRun(run);
    btn.classList.toggle("hidden", !canStop);
    btn.disabled = !canStop;
  });
}

// === Steer Run Select ===
function updateSteerRunSelect() {
  const label = $("#steer-run-select");
  const skillBtn = $("#btn-active-run-skills");
  if (skillBtn) {
    skillBtn.classList.toggle("hidden", !currentRuns.length);
  }
  if (isParallelMode(currentChallengeMode) && currentRuns.length > 1) {
    const activeRun = currentRuns.find((r) => r.id === activeRunId);
    if (activeRun) {
      const meta = getAgentMeta(activeRun.agent);
      label.textContent = meta.label || activeRun.agent;
      label.classList.remove("hidden");
    } else {
      label.classList.add("hidden");
    }
  } else {
    label.classList.add("hidden");
  }
  updateRunControlButtons();
  updateGoalBars();
}

function updateRunFromSummary(summary) {
  const run = currentRuns.find((r) => r.id === summary.id);
  if (!run) return;
  const wasSolving = run.status === "solving";
  run.agent = summary.agent || run.agent;
  if (Object.hasOwn(summary, 'model')) run.model = summary.model ?? '';
  if (Object.hasOwn(summary, 'effort')) run.effort = summary.effort ?? '';
  run.status = summary.status || run.status;
  run.error = summary.error || null;
  run.duration_ms = durationMs(summary.duration_ms);
  if (Object.hasOwn(summary, "enabled_skills")) run.enabled_skills = normalizeSkillNames(summary.enabled_skills);
  if (Object.hasOwn(summary, "skills_mode")) run.skills_mode = summary.skills_mode;
  if (Object.hasOwn(summary, "skill_override")) run.skill_override = !!summary.skill_override;
  run.goal = normalizeRunGoal(summary.goal);
  run.goal_editable = !!summary.goal_editable;
  if (run.status === "solving") {
    if (!wasSolving || !run._timerStartedAt) run._timerStartedAt = Date.now();
  } else {
    delete run._timerStartedAt;
  }
  updateRunTabDot(run.id, run.status);
  updateRunControlButtons();
  updateGoalBars();
}

function openRunSkillsModal(runId) {
  const run = currentRuns.find((r) => r.id === runId);
  if (!run) {
    showToast("Run not found", "error");
    return;
  }
  runSkillModalRunId = run.id;
  const meta = getAgentMeta(run.agent);
  const label = runTabLabel(run, meta);
  $("#run-skill-subtitle").textContent = `${label} · ${run.id}`;
  const override = !!run.skill_override;
  const challengeSolved = $("#detail-status").textContent === "solved";
  $("#run-skill-inheritance").textContent = challengeSolved
    ? "This challenge is solved; run skills are locked."
    : "Inherit follows the challenge policy; Auto selects related skills for this run; Manual uses your exact list.";
  bindSkillSelection($("#run-skill-list"), { skills_mode: run.skills_mode || (override ? "manual" : "inherit"), enabled_skills: run.enabled_skills ?? currentChallengeDefaultSkills });
  const binding = skillBindings.get("run-skill-list");
  binding.select.disabled = challengeSolved;
  binding.details.querySelectorAll("button, .skill-cb").forEach(control => { control.disabled = challengeSolved; });
  $('#btn-run-skills-apply').disabled = challengeSolved || catalogState !== 'ready';
  $('#btn-run-skills-apply-all').disabled = challengeSolved || catalogState !== 'ready';
  $('#btn-run-skills-reset').disabled = challengeSolved || !override || catalogState !== 'ready';
  $("#run-skill-overlay").classList.remove("hidden");
}

function closeRunSkillsModal() {
  runSkillModalRunId = null;
  $("#run-skill-overlay").classList.add("hidden");
}

function setRunSkillButtonsDisabled(disabled) {
  [
    "#btn-run-skills-apply",
    "#btn-run-skills-apply-all",
    "#btn-run-skills-reset",
  ].forEach((sel) => {
    const btn = $(sel);
    if (btn) btn.disabled = disabled;
  });
}

async function applyRunSkills(options = {}) {
  if (!currentChallengeId || !runSkillModalRunId) return;
  if (catalogState !== 'ready') { showToast(gatewayStatus.error || 'Refresh 9router models before resuming with new skills.', 'error'); return; }
  const body = {
    resume: true,
    apply_to_all: !!options.applyToAll,
  };
  const selection = options.reset ? { skills_mode: "inherit" } : skillSelectionPayload($("#run-skill-list"));
  Object.assign(body, selection);
  if (selection.skills_mode === "inherit") body.reset = true;
  setRunSkillButtonsDisabled(true);
  try {
    const res = await api(
      `/api/challenges/${currentChallengeId}/runs/${runSkillModalRunId}/skills`,
      { method: "PUT", body: JSON.stringify(body) }
    );
    if (!res) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      showToast(data.error || "Failed to update run skills", "error");
      return;
    }
    for (const summary of data.runs || []) {
      updateRunFromSummary(summary);
    }
    if (data.status) {
      updateStatusBadge(data.status);
      updateButtons(data.status);
      if (data.status === "solving") startTimer();
    }
    closeRunSkillsModal();
    const count = (data.runs || []).length;
    showToast(
      options.applyToAll
        ? `Updated ${count} run${count === 1 ? "" : "s"}`
        : "Run skills updated",
      "success"
    );
  } finally { setRunSkillButtonsDisabled(false); }
}

function openRunGoalModal(runId) {
  const run = currentRuns.find((r) => r.id === runId);
  if (!run || !canEditRunGoal(run)) {
    showToast("Goal editing is not available for this run", "error");
    return;
  }
  runGoalModalRunId = run.id;
  const meta = getAgentMeta(run.agent);
  $("#run-goal-subtitle").textContent = `${runTabLabel(run, meta)} · ${run.id}`;
  $("#run-goal-objective").value = run.goal?.objective || "";
  $("#btn-run-goal-clear").disabled = !run.goal;
  $("#run-goal-overlay").classList.remove("hidden");
  $("#run-goal-objective").focus();
}

function closeRunGoalModal() {
  runGoalModalRunId = null;
  $("#run-goal-overlay").classList.add("hidden");
}

function setRunGoalButtonsDisabled(disabled) {
  ["#btn-run-goal-save", "#btn-run-goal-clear"].forEach((sel) => {
    const btn = $(sel);
    if (btn) btn.disabled = disabled;
  });
}

async function saveRunGoal() {
  if (!currentChallengeId || !runGoalModalRunId) return;
  const objective = $("#run-goal-objective").value.trim();
  if (!objective) {
    showToast("Goal objective required", "error");
    return;
  }
  setRunGoalButtonsDisabled(true);
  const res = await api(
    `/api/challenges/${currentChallengeId}/runs/${runGoalModalRunId}/goal`,
    { method: "PUT", body: JSON.stringify({ objective }) }
  );
  setRunGoalButtonsDisabled(false);
  if (!res) return;
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    showToast(data.error || "Failed to update goal", "error");
    return;
  }
  if (data.run) updateRunFromSummary(data.run);
  closeRunGoalModal();
  showToast("Goal updated", "success");
}

async function clearRunGoal() {
  if (!currentChallengeId || !runGoalModalRunId) return;
  setRunGoalButtonsDisabled(true);
  const res = await api(
    `/api/challenges/${currentChallengeId}/runs/${runGoalModalRunId}/goal`,
    { method: "DELETE" }
  );
  setRunGoalButtonsDisabled(false);
  if (!res) return;
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    showToast(data.error || "Failed to clear goal", "error");
    return;
  }
  if (data.run) updateRunFromSummary(data.run);
  closeRunGoalModal();
  showToast("Goal cleared", "success");
}

// === Files Run Select ===
function updateFilesRunSelect() {
  const sel = $("#files-run-select");
  if (currentRuns.length > 0) {
    sel.classList.remove("hidden");
    sel.innerHTML = '<option value="">Challenge files</option>' +
      currentRuns.map((r) => {
        const meta = getAgentMeta(r.agent);
        const label = `${meta.label || r.agent} workspace`;
        return `<option value="${esc(r.id)}">${esc(label)}</option>`;
      }).join("");
    if (!isParallelMode(currentChallengeMode) && currentRuns.length === 1) {
      sel.value = currentRuns[0].id;
    }
  } else {
    sel.classList.add("hidden");
    sel.innerHTML = "";
  }
}

// === Markdown ===
function renderMarkdown(text) {
  let h = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Fenced code blocks
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g,
    '<pre class="md-codeblock"><code>$2</code></pre>');

  // Inline code
  h = h.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');

  // Bold
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  h = h.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

  // Headers
  h = h.replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>');
  h = h.replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>');
  h = h.replace(/^# (.+)$/gm, '<div class="md-h1">$1</div>');

  // Unordered lists
  h = h.replace(/^[*-] (.+)$/gm, '<li>$1</li>');

  // Numbered lists
  h = h.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> in <ul>
  h = h.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul class="md-list">$1</ul>');

  // Paragraphs (double newline)
  h = h.replace(/\n\n/g, '</p><p>');
  h = '<p>' + h + '</p>';
  h = h.replace(/<p><\/p>/g, '');

  // Clean up <p> wrapping block elements
  h = h.replace(/<p>(<(?:pre|ul|div|h\d)[^>]*>)/g, '$1');
  h = h.replace(/(<\/(?:pre|ul|div|h\d)>)<\/p>/g, '$1');

  return h;
}

// === Copy to Clipboard ===
function copyToClipboard(text, btnEl) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btnEl.textContent;
    btnEl.textContent = "Copied!";
    btnEl.classList.add("copied");
    setTimeout(() => { btnEl.textContent = orig; btnEl.classList.remove("copied"); }, 1200);
  });
}

function renderFlagFormats() {
  const list = $("#flag-format-list");
  if (!list) return;
  list.innerHTML = "";
  if (!challengeFlagFormats.length) {
    const empty = document.createElement("div");
    empty.className = "flag-format-empty";
    empty.textContent = "No custom formats";
    list.appendChild(empty);
    return;
  }
  for (const fmt of challengeFlagFormats) {
    const pill = document.createElement("span");
    pill.className = "flag-format-pill";
    pill.textContent = fmt;
    list.appendChild(pill);
  }
}

async function addFlagFormatAndScan() {
  if (!currentChallengeId) return;
  const input = $("#flag-format-input");
  const btn = $("#btn-add-flag-format");
  const format = input.value.trim();
  if (!format) return;

  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = "Scanning...";
  const res = await api(`/api/challenges/${currentChallengeId}/flag-formats`, {
    method: "POST",
    body: JSON.stringify({ format }),
  });
  btn.disabled = false;
  btn.textContent = oldText;
  if (!res) return;
  const data = await res.json();
  if (data.error) {
    showToast(data.error, "error");
    return;
  }

  input.value = "";
  challengeFlagFormat = data.flag_format || challengeFlagFormat;
  challengeFlagFormats = data.flag_formats || challengeFlagFormats;
  $("#detail-flag-format").textContent = challengeFlagFormats.length
    ? `Flag: ${challengeFlagFormats.join(", ")}`
    : "";
  renderFlagFormats();

  const detected = data.detected || [];
  for (const item of detected) {
    if (!item.flag) continue;
    showFlagBanner(item.flag, item.meta || {});
    if (item.status === "correct" || item.status === "wrong") {
      setFlagStatus(item.flag, item.status, item.meta || null);
    }
  }
  const suffix = data.auto_submit && detected.length ? " and queued auto-submit" : "";
  showToast(`Format ${data.added ? "added" : "already exists"}; ${detected.length} flag${detected.length === 1 ? "" : "s"} found${suffix}.`);
}

async function addManualFlag() {
  if (!currentChallengeId) return;
  const input = $("#manual-flag-input");
  const btn = $("#btn-add-manual-flag");
  const flag = input.value.trim();
  if (!flag) return;

  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = "Adding...";
  const res = await api(`/api/challenges/${currentChallengeId}/flags`, {
    method: "POST",
    body: JSON.stringify({ flag }),
  });
  btn.disabled = false;
  btn.textContent = oldText;
  if (!res) return;
  const data = await res.json();
  if (data.error) {
    showToast(data.error, "error");
    return;
  }

  input.value = "";
  const storedFlag = data.flag || flag;
  showFlagBanner(storedFlag, data.meta || {});
  if (data.status === "correct" || data.status === "wrong") {
    setFlagStatus(storedFlag, data.status, data.meta || null);
  }
  showToast(data.added ? "Flag added" : "Flag already exists");
}

function makeCopyBtn(getText) {
  const btn = document.createElement("button");
  btn.className = "btn-copy";
  btn.textContent = "Copy";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    copyToClipboard(typeof getText === "function" ? getText() : getText, btn);
  });
  return btn;
}

// === Flag Detection ===
function flagLookupKey(flag) {
  return String(flag || "").toLowerCase();
}

function checkForFlag(text) {
  const patterns = [
    /picoCTF\{[^}]+\}/gi,
    /flag\{[^}]+\}/gi,
    /FLAG\{[^}]+\}/gi,
    /CTF\{[^}]+\}/gi,
    /HTB\{[^}]+\}/gi,
  ];
  for (const fmt of challengeFlagFormats) {
    const prefix = String(fmt || "").replace(/\{.*/, "").trim();
    if (prefix.length >= 2) {
      patterns.push(
        new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          + "\\{[^}]+\\}", "gi")
      );
    }
  }
  for (const pat of patterns) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(text)) !== null) {
      const candidate = m[0];
      if (challengeFlagFormats.some((fmt) => flagLookupKey(candidate) === flagLookupKey(fmt))) {
        continue;
      }
      return candidate;
    }
  }
  return null;
}

const foundFlags = new Map();
const flagDetails = new Map();

function knownFlagFor(flag) {
  const wanted = flagLookupKey(flag);
  for (const existing of foundFlags.keys()) {
    if (flagLookupKey(existing) === wanted) return existing;
  }
  return null;
}

function selectorEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

function findFlagDetail(metaMap, flag) {
  const wanted = flagLookupKey(flag);
  for (const [key, value] of Object.entries(metaMap || {})) {
    if (flagLookupKey(key) === wanted) return value;
  }
  return null;
}

function mergeFlagDetail(flag, meta = {}) {
  const displayFlag = knownFlagFor(flag) || flag;
  const existing = flagDetails.get(displayFlag) || {};
  const merged = { ...existing, ...meta };
  const sources = [...(existing.sources || [])];
  for (const source of meta.sources || []) {
    const key = `${source.type || ""}:${source.run_id || ""}:${source.event_index ?? ""}`;
    if (!sources.some((item) => `${item.type || ""}:${item.run_id || ""}:${item.event_index ?? ""}` === key)) {
      sources.push(source);
    }
  }
  const submissions = [...(existing.submissions || [])];
  for (const sub of meta.submissions || []) {
    const key = `${sub.at || ""}:${sub.flag_id ?? ""}:${sub.submitted_flag || ""}:${sub.correct}`;
    if (!submissions.some((item) => `${item.at || ""}:${item.flag_id ?? ""}:${item.submitted_flag || ""}:${item.correct}` === key)) {
      submissions.push(sub);
    }
  }
  merged.sources = sources;
  merged.submissions = submissions;
  flagDetails.set(displayFlag, merged);
  return merged;
}

function flagQuestionLabel(question, idx) {
  const label = question.question || question.identifier || `Question ${idx + 1}`;
  const solved = question.solved ? " (solved)" : "";
  return `${idx + 1}. ${label}${solved}`;
}

function selectFlagTargetValue(detail = {}) {
  if (detail.flag_id !== undefined && detail.flag_id !== null && detail.flag_id !== "") {
    return `flag_id:${detail.flag_id}`;
  }
  if (detail.question) return `question:${detail.question}`;
  const unsolved = currentFlagQuestions.filter((q) => !q.solved);
  if (unsolved.length === 1) {
    const idx = currentFlagQuestions.indexOf(unsolved[0]);
    const flagId = unsolved[0].flag_id;
    return flagId !== undefined && flagId !== null && flagId !== ""
      ? `flag_id:${flagId}`
      : `question:${idx + 1}`;
  }
  return "";
}

function selectedFlagTarget(item) {
  const select = item.querySelector(".flag-target-select");
  if (!select) return {};
  const value = select.value;
  if (!value) return { missing: true };
  if (value.startsWith("flag_id:")) return { flag_id: value.slice("flag_id:".length) };
  if (value.startsWith("question:")) return { question: Number(value.slice("question:".length)) };
  return {};
}

function updateFlagTargetSelects() {
  document.querySelectorAll(".flag-item").forEach((item) => {
    const flag = item.dataset.flag;
    const detail = flagDetails.get(flag) || {};
    const oldSelect = item.querySelector(".flag-target-select");
    if (!currentFlagQuestions.length) {
      if (oldSelect) oldSelect.remove();
      const markBtn = item.querySelector(".btn-flag-mark");
      if (markBtn) markBtn.textContent = "Mark Solved";
      return;
    }
    const select = oldSelect || document.createElement("select");
    select.className = "flag-target-select";
    const selected = oldSelect?.value || selectFlagTargetValue(detail);
    select.innerHTML = '<option value="">Choose target...</option>' + currentFlagQuestions.map((q, idx) => {
      const flagId = q.flag_id;
      const value = flagId !== undefined && flagId !== null && flagId !== ""
        ? `flag_id:${esc(flagId)}`
        : `question:${idx + 1}`;
      return `<option value="${value}">${esc(flagQuestionLabel(q, idx))}</option>`;
    }).join("");
    select.value = Array.from(select.options).some((opt) => opt.value === selected) ? selected : "";
    if (!oldSelect) item.querySelector(".flag-actions")?.prepend(select);
    const markBtn = item.querySelector(".btn-flag-mark");
    if (markBtn) markBtn.textContent = "Mark Slot";
  });
}

function primaryFlagSource(detail = {}) {
  const sources = detail.sources || [];
  return sources.find((source) =>
    source.run_id && Number.isInteger(source.event_index)
  ) || sources[0] || null;
}

function flagSourceText(detail = {}) {
  const source = primaryFlagSource(detail);
  if (!source) return "Source not recorded";
  if (source.type === "manual") return "Manual entry";
  const pieces = [];
  if (source.agent) pieces.push(source.agent);
  if (source.type === "teammate_broadcast") pieces.push("breakthrough");
  else if (source.type) pieces.push(source.type);
  if (Number.isInteger(source.event_index)) pieces.push(`event ${source.event_index}`);
  return pieces.join(" · ") || "Source recorded";
}

function flagSubmissionText(detail = {}) {
  const submissions = detail.submissions || [];
  if (!submissions.length) return "";
  const last = submissions[submissions.length - 1];
  const status = last.correct ? "correct" : "wrong";
  const target = last.question ? `q${last.question}` : (last.flag_id ? `flag_id ${last.flag_id}` : "");
  return [`Last submit: ${status}`, target, last.message || ""].filter(Boolean).join(" · ");
}

async function focusFlagSource(detail = {}) {
  const source = primaryFlagSource(detail);
  if (!source || !source.run_id || !Number.isInteger(source.event_index)) {
    showToast("No transcript source recorded for this flag", "info");
    return;
  }
  await focusTranscriptEvent(source.run_id, source.event_index);
}

function refreshFlagItem(item, flag) {
  const detail = flagDetails.get(flag) || {};
  const sourceEl = item.querySelector(".flag-source");
  if (sourceEl) sourceEl.textContent = flagSourceText(detail);
  const submitEl = item.querySelector(".flag-submit-meta");
  if (submitEl) {
    const text = flagSubmissionText(detail);
    submitEl.textContent = text;
    submitEl.classList.toggle("hidden", !text);
  }
  const jumpBtn = item.querySelector(".btn-flag-source");
  const source = primaryFlagSource(detail);
  if (jumpBtn) jumpBtn.disabled = !(source?.run_id && Number.isInteger(source.event_index));
  updateFlagTargetSelects();
}

function showFlagBanner(flag, meta = {}) {
  const existing = knownFlagFor(flag);
  if (existing) {
    mergeFlagDetail(existing, meta);
    const item = document.querySelector(`.flag-item[data-flag="${selectorEscape(existing)}"]`);
    if (item) refreshFlagItem(item, existing);
    return;
  }

  const section = $("#flags-section");
  const list = $("#flags-list");
  section.classList.remove("hidden");

  const item = document.createElement("div");
  item.className = "flag-item";
  item.dataset.flag = flag;
  const main = document.createElement("div");
  main.className = "flag-main";
  const span = document.createElement("span");
  span.className = "flag-text";
  span.textContent = flag;
  const source = document.createElement("span");
  source.className = "flag-source";
  const submitMeta = document.createElement("span");
  submitMeta.className = "flag-submit-meta hidden";
  main.append(span, source, submitMeta);

  const actions = document.createElement("div");
  actions.className = "flag-actions";
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn-flag-action";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => copyToClipboard(flag, copyBtn));
  actions.appendChild(copyBtn);

  const jumpBtn = document.createElement("button");
  jumpBtn.className = "btn-flag-action btn-flag-source";
  jumpBtn.textContent = "Jump";
  jumpBtn.addEventListener("click", () => focusFlagSource(flagDetails.get(flag) || {}));
  actions.appendChild(jumpBtn);

  const submitBtn = document.createElement("button");
  submitBtn.className = "btn-flag-action btn-flag-submit";
  submitBtn.textContent = "Submit";
  submitBtn.addEventListener("click", async () => {
    if (!currentChallengeId) return;
    const target = selectedFlagTarget(item);
    if (target.missing) {
      showToast("Choose which flag target to submit to", "error");
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";
    const res = await api("/api/plugins/submit-flag", {
      method: "POST",
      body: JSON.stringify({
        challenge_id: currentChallengeId,
        flag,
        run_id: activeRunId || currentRuns[0]?.id || "",
        ...target,
      }),
    });
    if (!res) { submitBtn.disabled = false; submitBtn.textContent = "Submit"; return; }
    const data = await res.json();
    if (data.error) {
      showToast(data.error, "error");
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit";
      return;
    }
    const resultFlag = data.flag || flag;
    if (data.meta) mergeFlagDetail(resultFlag, data.meta);
    if (data.flag_questions) {
      currentFlagQuestions = data.flag_questions;
      updateFlagTargetSelects();
    }
    if (data.correct) {
      setFlagStatus(resultFlag, "correct");
      if (data.status === "solved" || data.all_questions_solved || !currentFlagQuestions.length) {
        showToast("Flag correct!", "success");
        updateStatusBadge("solved");
        updateButtons("solved");
        stopTimer();
      } else {
        showToast("Flag correct for selected target", "success");
      }
    } else {
      setFlagStatus(resultFlag, "wrong");
      submitBtn.textContent = data.message || "Wrong";
      submitBtn.disabled = false;
      setTimeout(() => { submitBtn.textContent = "Submit"; }, 2000);
    }
  });
  actions.appendChild(submitBtn);

  const markBtn = document.createElement("button");
  markBtn.className = "btn-flag-action btn-flag-mark";
  markBtn.textContent = currentFlagQuestions.length ? "Mark Slot" : "Mark Solved";
  markBtn.addEventListener("click", async () => {
    if (!currentChallengeId) return;
    const target = selectedFlagTarget(item);
    if (target.missing) {
      showToast("Choose which flag target to mark", "error");
      return;
    }
    const res = await api(`/api/challenges/${currentChallengeId}/mark-solved`, {
      method: "POST",
      body: JSON.stringify({
        flag,
        run_id: activeRunId || currentRuns[0]?.id || "",
        ...target,
      }),
    });
    if (res && res.ok) {
      const data = await res.json();
      if (data.meta) mergeFlagDetail(data.flag || flag, data.meta);
      if (data.flag_questions) {
        currentFlagQuestions = data.flag_questions;
        updateFlagTargetSelects();
      }
      setFlagStatus(flag, "correct");
      if (data.status === "solved" || data.all_questions_solved || !currentFlagQuestions.length) {
        showToast("Challenge marked as solved", "success");
        updateStatusBadge("solved");
        updateButtons("solved");
        stopTimer();
      } else {
        showToast("Flag target marked correct", "success");
      }
    }
  });
  actions.appendChild(markBtn);

  item.append(main, actions);
  list.appendChild(item);
  foundFlags.set(flag, "pending");
  mergeFlagDetail(flag, meta);
  refreshFlagItem(item, flag);
}

function setFlagStatus(flag, status, meta = null) {
  const displayFlag = knownFlagFor(flag) || flag;
  if (meta) mergeFlagDetail(displayFlag, meta);
  foundFlags.set(displayFlag, status);
  const wanted = flagLookupKey(flag);
  const items = document.querySelectorAll(".flag-item");
  items.forEach((item) => {
    if (flagLookupKey(item.dataset.flag) !== wanted) return;
    item.classList.remove("flag-correct", "flag-wrong");
    if (status === "correct") item.classList.add("flag-correct");
    else if (status === "wrong") item.classList.add("flag-wrong");
    refreshFlagItem(item, item.dataset.flag);
  });
}

// === Timer ===
function startTimer() {
  syncRunTimerState();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 1000);
  updateTimer();
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  for (const run of currentRuns) freezeRunTimer(run);
  updateTimer();
}

function updateTimer() {
  const elapsed = Math.floor(currentChallengeTimerMs() / 1000);
  if (!elapsed) {
    $("#detail-timer").textContent = "";
    return;
  }
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  const h = Math.floor(m / 60);
  const display = h > 0
    ? `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
  $("#detail-timer").textContent = display;
}


// === Toasts ===
function showToast(message, type = "info") {
  const container = $("#toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function showFlagFoundToast(challengeName, agent, flag, challengeId) {
  const container = $("#toast-container");
  const toast = document.createElement("div");
  toast.className = "toast toast-flag";
  toast.innerHTML = `<strong>Flag found!</strong> ${esc(agent)} found a flag in <em>${esc(challengeName)}</em><br><code>${esc(flag)}</code><br><span class="toast-flag-action">Click to open</span>`;
  toast.style.cursor = "pointer";
  toast.addEventListener("click", () => {
    toast.remove();
    if (challengeId) openChallenge(challengeId);
  });
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => toast.remove(), 300);
  }, 15000);
}

// === Run Event Rendering ===
function renderRunEvent(runId, event) {
  // Get or create the feed for this run
  let feed = document.getElementById(`feed-${runId}`);
  if (!feed) {
    // Might arrive before tabs are set up; use default feed
    feed = document.getElementById("feed-__default__");
  }
  if (!feed) return;

  // --- Run-level status: update only this run's tab dot ---
  if (event.type === "flag_found") return;

  if (event.type === "run_status") {
    const rid = event.run_id || runId;
    updateRunTabDot(rid, event.status);
    applyRunStatusEvent(event, rid);
    if (event.duration_ms !== undefined && event.duration_ms !== null) {
      getRunStats(rid).durationMs = durationMs(event.duration_ms);
    }
    if (event.error) {
      $("#error-banner").textContent = event.error;
      $("#error-banner").classList.remove("hidden");
    }
    renderStats();
    updateTimer();
    updateRunControlButtons();
    return;
  }

  if (event.type === "run_goal") {
    const rid = event.run_id || runId;
    const run = currentRuns.find((r) => r.id === rid);
    const goal = normalizeRunGoal(event.goal);
    if (!suppressHistoricalStateUpdates) {
      if (run) {
        run.goal = goal;
        if (run.agent === "codex") run.goal_editable = true;
      }
      updateGoalBars();
    }
    return;
  }

  if (event.type === "runtime_resources") {
    const rid = event.run_id || runId;
    const run = currentRuns.find(r => r.id === rid);
    if (run && !suppressHistoricalStateUpdates) run.runtime_resources = event;
    const skills = normalizeSkillNames(event.skills);
    const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : (event.mcp || []);
    const statuses = servers.map(server => server.name + ": " + (server.status || "unknown")).join(" · ");
    appendMsg(feed, "Native resources · " + skills.length + " workspace skills" + (statuses ? " · MCP " + statuses : " · MCP connection not reported"), "runtime-resources-msg", event.ts);
    scrollBottomIfActive(runId);
    return;
  }

  if (event.type === "run_skills") {
    const rid = event.run_id || runId;
    const run = currentRuns.find((r) => r.id === rid);
    if (run && !suppressHistoricalStateUpdates) {
      if (Object.hasOwn(event, "enabled_skills")) run.enabled_skills = normalizeSkillNames(event.enabled_skills);
      if (Object.hasOwn(event, "skills_mode")) run.skills_mode = event.skills_mode;
      if (Object.hasOwn(event, "skill_override")) run.skill_override = !!event.skill_override;
    }
    const count = normalizeSkillNames(event.enabled_skills).length;
    const mode = event.skills_mode || (event.skill_override ? "manual" : "inherit");
    appendMsg(
      feed,
      `${event.message || "Run skills updated."} ${count} ${mode} skill${count === 1 ? "" : "s"} enabled.`,
      "system-msg",
      event.ts
    );
    if (runSkillModalRunId === rid) {
      openRunSkillsModal(rid);
    }
    scrollBottomIfActive(runId);
    return;
  }

  // --- New run added (new run added) ---
  if (event.type === "run_added" && event.run) {
    const r = event.run;
    if (currentRuns.some((x) => x.id === r.id)) return;
    r.goal = normalizeRunGoal(r.goal);
    currentRuns.push(r);
    if (r.status === "solving") activateRunTimer(r);
    addRunTab(r);
    if (currentChallengeId) {
      runHistoryState.set(r.id, {
        total: 0,
        nextBefore: null,
        hasMore: false,
        loading: false,
      });
      connectRunWS(currentChallengeId, r.id, r.agent, { history: false });
    }
    // Refresh selectors and header with new run
    updateSteerRunSelect();
    updateRunControlButtons();
    updateFilesRunSelect();
    // Update model badge for new agent
    const agentMeta = getAgentMeta(r.agent);
    const modelBadge = $("#detail-model");
    if (modelBadge) {
      modelBadge.textContent = r.model || agentMeta.default_model;
    }
    switchRunTab(r.id);
    return;
  }

  // --- Challenge-level status: update badge, buttons, timer ---
  if (event.type === "challenge_status") {
    updateStatusBadge(event.status);
    updateButtons(event.status);
    if (event.status === "solving") startTimer();
    if (["solved", "failed", "completed"].includes(event.status)) {
      stopTimer();

      if (views.detail.classList.contains("hidden")) {
        const msgs = { solved: "Challenge solved!", failed: "Challenge failed", completed: "Agent finished" };
        const types = { solved: "success", failed: "error", completed: "info" };
        showToast(msgs[event.status] || event.status, types[event.status] || "info");
      }
    }
    return;
  }

  // --- Legacy "status" type for backward compat with saved logs ---
  if (event.type === "status") {
    updateRunTabDot(runId, event.status);
    updateStatusBadge(event.status);
    updateButtons(event.status);
    return;
  }

  // --- Subagent lifecycle (within a single run) ---
  if (event.type === "system" && event.subtype === "task_started") {
    appendMsg(feed, `Subagent started: ${event.description || "task"}`, "system-msg", event.ts);
    scrollBottomIfActive(runId);
    return;
  }
  if (event.type === "system" && event.subtype === "task_notification") {
    appendMsg(feed, `Subagent ${event.status || "finished"}: ${event.description || "task"}`, "system-msg", event.ts);
    scrollBottomIfActive(runId);
    return;
  }

  // --- Error ---
  if (event.type === "error") {
    appendMsg(feed, event.message, "error-msg", event.ts);
    scrollBottomIfActive(runId); return;
  }

  // --- System messages ---
  if (event.type === "system") {
    if (event.subtype === "init") return;
    const systemMessage = event.message || event.data || "";
    if (event.subtype === "teammate_broadcast" && systemMessage) {
      appendMsg(feed, systemMessage, "teammate-broadcast-msg", event.ts);
      const flag = checkForFlag(systemMessage);
      if (flag) showFlagBanner(flag);
      scrollBottomIfActive(runId); return;
    }
    if (systemMessage) {
      appendMsg(feed, systemMessage, "system-msg", event.ts);
    }
    scrollBottomIfActive(runId); return;
  }

  // --- User steer ---
  if (event.type === "user_steer" || event.type === "user_prompt") {
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble chat-user";
    if (event.ts != null) {
      const ts = document.createElement("span");
      ts.className = "msg-ts";
      ts.textContent = fmtElapsed(event.ts);
      bubble.appendChild(ts);
    }
    const label = document.createElement("div");
    label.className = "chat-label";
    label.textContent = event.type === "user_steer" ? "You" : "Prompt";
    const body = document.createElement("div");
    body.className = "chat-body";
    body.textContent = event.message;
    bubble.append(label, body);
    feed.appendChild(bubble);
    scrollBottomIfActive(runId); return;
  }

  // --- Rate limit ---
  if (event.type === "rate_limit_event") {
    const info = event.rate_limit_info;
    if (info && info.utilization > 0.5) {
      appendMsg(feed, `Rate limit: ${Math.round(info.utilization * 100)}% used`, "rate-limit-msg", event.ts);
      scrollBottomIfActive(runId);
    }
    return;
  }

  // --- Assistant message ---
  if (event.type === "assistant" && event.message) {
    if (event.message.usage) updateRunStats(runId, event);
    renderAssistant(feed, event.message, runId, event.ts);
    scrollBottomIfActive(runId); return;
  }

  // --- User (tool results) ---
  if (event.type === "user" && event.message) {
    renderToolResults(event, feed);
    scrollBottomIfActive(runId); return;
  }

  // --- Raw text ---
  if (event.type === "raw" && event.text) {
    appendMsg(feed, event.text, "raw-msg", event.ts);
    const flag = checkForFlag(event.text);
    if (flag) showFlagBanner(flag);
    scrollBottomIfActive(runId); return;
  }

  // --- Codex usage ---
  if (event.type === "codex_usage") {
    updateRunStats(runId, event);
    return;
  }

  // --- Result ---
  if (event.type === "result") {
    updateRunStats(runId, event);
    if (event.result) {
      const block = document.createElement("div");
      block.className = "result-block";
      block.innerHTML = `<div class="result-label">Result</div><div class="result-text"></div>`;
      block.querySelector(".result-text").innerHTML = renderMarkdown(event.result);
      feed.appendChild(block);
      const flag = checkForFlag(event.result);
      if (flag) showFlagBanner(flag);
      scrollBottomIfActive(runId);
    }
    return;
  }
}

// === Assistant Message Rendering ===

// Track consecutive tool calls for collapsing
let _pendingToolEls = [];

function _flushToolGroup(feed) {
  if (!_pendingToolEls.length) return;
  const group = document.createElement("div");
  group.className = "chat-tool-group";

  if (_pendingToolEls.length > 2) {
    // Show first, collapse middle, show last
    group.appendChild(_pendingToolEls[0]);
    const collapsed = document.createElement("div");
    collapsed.className = "chat-tool-collapsed";
    const expandBtn = document.createElement("button");
    expandBtn.className = "btn-ghost btn-xs chat-tool-expand";
    expandBtn.textContent = `${_pendingToolEls.length - 2} more tool call${_pendingToolEls.length - 2 !== 1 ? "s" : ""}`;
    expandBtn.addEventListener("click", () => {
      collapsed.classList.add("chat-tool-expanded");
      expandBtn.classList.add("hidden");
    });
    for (let i = 1; i < _pendingToolEls.length - 1; i++) {
      collapsed.appendChild(_pendingToolEls[i]);
    }
    group.appendChild(expandBtn);
    group.appendChild(collapsed);
    group.appendChild(_pendingToolEls[_pendingToolEls.length - 1]);
  } else {
    for (const el of _pendingToolEls) group.appendChild(el);
  }

  feed.appendChild(group);
  _pendingToolEls = [];
}

function renderAssistant(feed, msg, runId, eventTs) {
  if (!msg.content || !msg.content.length) return;

  for (const block of msg.content) {
    if (block.type === "thinking" && block.thinking) {
      _flushToolGroup(feed);
      if (lastThinkingEl) lastThinkingEl.removeAttribute("open");

      const bubble = document.createElement("div");
      bubble.className = "chat-bubble chat-assistant chat-thinking-bubble";

      const details = document.createElement("details");
      details.className = "step-thinking";
      details.open = true;
      const summary = document.createElement("summary");
      const label = document.createElement("span");
      label.className = "thinking-label";
      label.textContent = "Thinking";
      const preview = document.createElement("span");
      preview.className = "thinking-preview";
      preview.textContent = " " + truncate(block.thinking, 100);
      if (eventTs != null) {
        const tsEl = document.createElement("span");
        tsEl.className = "msg-ts";
        tsEl.textContent = fmtElapsed(eventTs);
        summary.append(label, preview, tsEl);
      } else {
        summary.append(label, preview);
      }
      details.appendChild(summary);
      const body = document.createElement("div");
      body.className = "thinking-body";
      body.textContent = block.thinking;
      details.appendChild(body);
      bubble.appendChild(details);
      lastThinkingEl = details;

      feed.appendChild(bubble);
      stepCount++;
      updateCounters();
    }
    else if (block.type === "text" && block.text) {
      _flushToolGroup(feed);

      const bubble = document.createElement("div");
      bubble.className = "chat-bubble chat-assistant";

      if (eventTs != null) {
        const ts = document.createElement("span");
        ts.className = "msg-ts";
        ts.textContent = fmtElapsed(eventTs);
        bubble.appendChild(ts);
      }

      const div = document.createElement("div");
      div.className = "chat-body";
      div.innerHTML = renderMarkdown(block.text);
      div.querySelectorAll(".md-codeblock").forEach((pre) => {
        pre.style.position = "relative";
        pre.appendChild(makeCopyBtn(() => pre.textContent));
      });
      bubble.appendChild(div);
      feed.appendChild(bubble);

      const flag = checkForFlag(block.text);
      if (flag) showFlagBanner(flag);

      stepCount++;
      updateCounters();
    }
    else if (block.type === "tool_use") {
      const toolEl = buildToolUse(block);
      _pendingToolEls.push(toolEl);
      pendingTools.set(block.id, toolEl);
      if (runId && !statsUseSnapshot) { getRunStats(runId).toolCalls++; renderStats(); }
      else if (runId && historyRenderDepth === 0) scheduleStatsSnapshotRefresh();
    }
  }

  // Flush remaining tool calls (they may be followed by a tool_result later)
  _flushToolGroup(feed);
}

// === Tool Use Rendering ===
function buildToolUse(block) {
  const wrapper = document.createElement("div");
  wrapper.className = "step-tool";
  wrapper.id = `tool-${block.id}`;

  // Bar
  const bar = document.createElement("div");
  bar.className = "tool-bar";

  const icon = document.createElement("span");
  icon.className = `tool-icon ${iconClass(block.name)}`;
  icon.textContent = iconLetter(block.name);

  const name = document.createElement("span");
  name.className = "tool-name";
  name.textContent = block.name;

  const desc = document.createElement("span");
  desc.className = "tool-desc";
  desc.textContent = toolSummary(block.name, block.input);

  const status = document.createElement("span");
  status.className = "tool-status tool-status-running";
  status.textContent = "running";

  bar.append(icon, name, desc, status);

  // Detail (expandable)
  const detail = document.createElement("div");
  detail.className = "tool-detail";

  const inputText = toolInputDisplay(block.name, block.input);
  if (inputText) {
    const sec = document.createElement("div");
    sec.className = "tool-input-section";
    sec.textContent = inputText;
    detail.appendChild(sec);
  }

  const outSec = document.createElement("div");
  outSec.className = "tool-output-section";
  outSec.textContent = "Waiting for output...";
  detail.appendChild(outSec);

  bar.addEventListener("click", () => detail.classList.toggle("open"));
  wrapper.append(bar, detail);

  wrapper._statusEl = status;
  wrapper._outputEl = outSec;
  return wrapper;
}

function setToolOutput(toolEl, output, isError, fullOutputRef = null) {
  const hasOutput = !!output;
  const fullOutput = hasOutput ? output : "(no output)";
  const serverTruncated = !!fullOutputRef?.truncated;
  const localTruncated = !serverTruncated && hasOutput && output.length > MAX_TOOL_OUTPUT_DISPLAY_CHARS;
  let visibleOutput = fullOutput;
  if (serverTruncated) {
    const totalChars = Number(fullOutputRef.chars || 0);
    const previewChars = Number(fullOutputRef.preview_chars || output.length || 0);
    const omitted = totalChars > previewChars ? totalChars - previewChars : 0;
    visibleOutput = `${output}\n\n[Full output omitted from history${omitted ? `: ${omitted.toLocaleString()} more characters` : ""}.]`;
  } else if (localTruncated) {
    visibleOutput = `${output.slice(0, MAX_TOOL_OUTPUT_DISPLAY_CHARS)}\n\n[Output truncated in the UI: ${output.length - MAX_TOOL_OUTPUT_DISPLAY_CHARS} more characters. Copy still uses the full output.]`;
  }

  toolEl._outputEl.textContent = visibleOutput;
  toolEl._outputEl.classList.toggle("tool-output-error", !!isError);
  if (!hasOutput) return;

  toolEl._outputEl.style.position = "relative";
  toolEl._outputEl.appendChild(makeCopyBtn(() => toolEl._fullOutput || output));
  if (serverTruncated) {
    const fullBtn = document.createElement("button");
    fullBtn.type = "button";
    fullBtn.className = "btn-xs tool-output-full";
    fullBtn.textContent = "Load full output";
    fullBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      fullBtn.disabled = true;
      fullBtn.textContent = "Loading...";
      try {
        const full = await fetchFullToolOutput(fullOutputRef);
        toolEl._fullOutput = full;
        toolEl._outputEl.textContent = full || "(no output)";
        toolEl._outputEl.appendChild(makeCopyBtn(() => toolEl._fullOutput || ""));
      } catch (err) {
        fullBtn.disabled = false;
        fullBtn.textContent = "Load full output";
        showToast("Failed to load full output", "error");
      }
    });
    toolEl._outputEl.appendChild(fullBtn);
  } else if (localTruncated) {
    const fullBtn = document.createElement("button");
    fullBtn.type = "button";
    fullBtn.className = "btn-xs tool-output-full";
    fullBtn.textContent = "Show full output";
    fullBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toolEl._outputEl.textContent = fullOutput;
      toolEl._outputEl.appendChild(makeCopyBtn(output));
    });
    toolEl._outputEl.appendChild(fullBtn);
  }
}

function renderToolResults(event, feed) {
  const msg = event.message;
  if (!msg || !msg.content) return;

  for (const block of msg.content) {
    if (block.type !== "tool_result") continue;

    let toolEl = pendingTools.get(block.tool_use_id);
    if (!toolEl) {
      // Synthetic tool card for completed tool results without a prior start event
      const synthetic = {
        id: block.tool_use_id || `tool-${Date.now()}`,
        name: block.name || "tool",
        input: block.input || {},
      };
      toolEl = buildToolUse(synthetic);
      feed.appendChild(toolEl);
      pendingTools.set(synthetic.id, toolEl);
    }

    let output = "";
    // Extract content text from agent tool results
    if (event.tool_use_result && event.tool_use_result.content) {
      output = event.tool_use_result.content
        .map((c) => c.text || "").filter(Boolean).join("\n");
    }
    if (!output && event.tool_use_result) {
      const r = event.tool_use_result;
      if (r.stdout) output = r.stdout;
      if (r.stderr) output += (output ? "\n" : "") + r.stderr;
      if (r.matches) output = r.matches.join(", ");
    }
    if (!output && typeof block.content === "string") output = block.content;
    if (!output && Array.isArray(block.content))
      output = block.content.map((c) => c.text || c.tool_name || JSON.stringify(c)).join("\n");

    const fullOutputRef = block.full_output_ref
      || event.tool_use_result?.full_output_ref
      || null;
    const isError = block.is_error === true;
    toolEl._statusEl.className = `tool-status ${isError ? "tool-status-error" : "tool-status-done"}`;
    toolEl._statusEl.textContent = isError ? "error" : "done";
    setToolOutput(toolEl, output, isError, fullOutputRef);

    pendingTools.delete(block.tool_use_id);
  }
}

// === Stats Sidebar ===
function emptyRunStatsState() {
  return {
    inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    toolCalls: 0, turns: 0,
    costUsd: 0, durationMs: 0, durationApiMs: 0,
    modelUsage: null,
    resultSeen: false,
    codexSeen: false,
    lastResultUsage: null,
    lastCodexUsage: null,
    lastResultCostUsd: null,
    lastResultTurns: null,
    lastDurationApiMs: null,
    lastModelUsage: {},
  };
}

function getRunStats(runId) {
  if (!runStats.has(runId)) {
    runStats.set(runId, emptyRunStatsState());
  }
  return runStats.get(runId);
}

function statNumber(obj, ...keys) {
  if (!obj || typeof obj !== "object") return 0;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function normalizeUsage(raw) {
  const details = raw?.input_token_details || raw?.inputTokenDetails || {};
  return {
    inputTokens: statNumber(raw, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens"),
    outputTokens: statNumber(raw, "output_tokens", "outputTokens", "completion_tokens", "completionTokens"),
    cacheReadTokens: statNumber(
      raw,
      "cache_read_input_tokens",
      "cacheReadInputTokens",
      "cached_input_tokens",
      "cachedInputTokens"
    ) || statNumber(details, "cached_tokens", "cachedTokens"),
    cacheCreationTokens: statNumber(raw, "cache_creation_input_tokens", "cacheCreationInputTokens"),
  };
}

function usageDelta(current, previous) {
  const prev = previous || {};
  const delta = {};
  for (const [key, value] of Object.entries(current)) {
    const prior = prev[key] || 0;
    delta[key] = value <= 0 ? 0 : value >= prior ? value - prior : value;
  }
  return delta;
}

function addUsageToStats(s, usage) {
  s.inputTokens += usage.inputTokens || 0;
  s.outputTokens += usage.outputTokens || 0;
  s.cacheReadTokens += usage.cacheReadTokens || 0;
  s.cacheCreationTokens += usage.cacheCreationTokens || 0;
}

function positiveDelta(current, previous) {
  if (!current || current <= 0) return 0;
  if (previous == null) return current;
  return current >= previous ? current - previous : current;
}

function normalizeModelUsage(raw) {
  const normalized = {};
  if (!raw || typeof raw !== "object") return normalized;
  for (const [model, usage] of Object.entries(raw)) {
    if (!usage || typeof usage !== "object") continue;
    normalized[model] = {
      inputTokens: statNumber(usage, "inputTokens", "input_tokens"),
      outputTokens: statNumber(usage, "outputTokens", "output_tokens"),
      cacheReadInputTokens: statNumber(
        usage,
        "cacheReadInputTokens",
        "cache_read_input_tokens",
        "cachedInputTokens",
        "cached_input_tokens"
      ),
      cacheCreationInputTokens: statNumber(
        usage,
        "cacheCreationInputTokens",
        "cache_creation_input_tokens"
      ),
      costUSD: statNumber(usage, "costUSD", "cost_usd"),
      webSearchRequests: statNumber(usage, "webSearchRequests", "web_search_requests"),
    };
  }
  return normalized;
}

function addModelUsageDelta(s, current) {
  if (!current || !Object.keys(current).length) return;
  if (!s.modelUsage) s.modelUsage = {};
  if (!s.lastModelUsage) s.lastModelUsage = {};
  for (const [model, usage] of Object.entries(current)) {
    const prev = s.lastModelUsage[model] || {};
    const target = s.modelUsage[model] || {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
      webSearchRequests: 0,
    };
    for (const [key, value] of Object.entries(usage)) {
      target[key] = (target[key] || 0) + positiveDelta(value, prev[key]);
    }
    s.modelUsage[model] = target;
    s.lastModelUsage[model] = usage;
  }
}

function normalizeStatsSnapshot(raw) {
  return {
    ...emptyRunStatsState(),
    inputTokens: Number(raw?.inputTokens || 0),
    outputTokens: Number(raw?.outputTokens || 0),
    cacheReadTokens: Number(raw?.cacheReadTokens || 0),
    cacheCreationTokens: Number(raw?.cacheCreationTokens || 0),
    toolCalls: Number(raw?.toolCalls || 0),
    turns: Number(raw?.turns || 0),
    costUsd: Number(raw?.costUsd || 0),
    durationMs: Number(raw?.durationMs || 0),
    durationApiMs: Number(raw?.durationApiMs || 0),
    modelUsage: raw?.modelUsage && Object.keys(raw.modelUsage).length ? raw.modelUsage : null,
  };
}

async function loadChallengeStatsSnapshot(challengeId, options = {}) {
  const res = await api(`/api/challenges/${encodeURIComponent(challengeId)}/stats`).catch(() => null);
  if (!res || !res.ok) {
    if (!options.silent) console.warn("Failed to load challenge stats snapshot");
    return;
  }
  const data = await res.json();
  if (currentChallengeId !== challengeId) return;

  runStats.clear();
  for (const [runId, stats] of Object.entries(data.runs || {})) {
    runStats.set(runId, normalizeStatsSnapshot(stats));
  }
  statsUseSnapshot = true;
  renderStats();
}

function scheduleStatsSnapshotRefresh(delay = 5000) {
  if (!statsUseSnapshot || !currentChallengeId || statsRefreshTimer) return;
  const challengeId = currentChallengeId;
  statsRefreshTimer = setTimeout(() => {
    statsRefreshTimer = null;
    if (currentChallengeId === challengeId) {
      loadChallengeStatsSnapshot(challengeId, { silent: true });
    }
  }, delay);
}

function updateRunStats(runId, event) {
  const s = getRunStats(runId);
  if (statsUseSnapshot) {
    if (historyRenderDepth === 0) scheduleStatsSnapshotRefresh();
    return;
  }

  if (event.type === "result") {
    s.resultSeen = true;
    if (event.usage) {
      const usage = normalizeUsage(event.usage);
      addUsageToStats(s, usageDelta(usage, s.lastResultUsage));
      s.lastResultUsage = usage;
    }
    const cost = statNumber(event, "total_cost_usd", "costUsd");
    if (cost) {
      s.costUsd += positiveDelta(cost, s.lastResultCostUsd);
      s.lastResultCostUsd = cost;
    }
    const turns = statNumber(event, "num_turns", "turns");
    if (turns) {
      s.turns += positiveDelta(turns, s.lastResultTurns);
      s.lastResultTurns = turns;
    }
    if (event.duration_ms) s.durationMs = Math.max(s.durationMs || 0, event.duration_ms);
    const durationApiMs = statNumber(event, "duration_api_ms");
    if (durationApiMs) {
      s.durationApiMs += positiveDelta(durationApiMs, s.lastDurationApiMs);
      s.lastDurationApiMs = durationApiMs;
    }
    if (event.model_usage) addModelUsageDelta(s, normalizeModelUsage(event.model_usage));
  } else if (event.type === "codex_usage" && event.usage) {
    s.codexSeen = true;
    const usage = normalizeUsage(event.usage);
    addUsageToStats(s, usageDelta(usage, s.lastCodexUsage));
    s.lastCodexUsage = usage;
  } else if (event.type === "assistant" && event.message?.usage && !s.resultSeen && !s.codexSeen) {
    addUsageToStats(s, normalizeUsage(event.message.usage));
  }
  renderStats();
}

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function fmtDuration(ms) {
  if (!ms) return "-";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function fmtCost(usd) {
  if (!usd) return "-";
  return "$" + usd.toFixed(4);
}

function flushDeferredStats() {
  if (historyRenderDepth > 0 || !statsRenderPending) return;
  statsRenderPending = false;
  renderStats();
}

function renderStats() {
  if (historyRenderDepth > 0) {
    statsRenderPending = true;
    return;
  }
  const panel = $("#stats-panel");
  if (!panel) return;
  panel.innerHTML = "";

  if (!runStats.size) {
    panel.innerHTML = '<div style="padding:1rem;color:var(--text-dim);font-size:0.8rem">No statistics yet</div>';
    return;
  }

  // --- Total section ---
  {
    const tot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, tools: 0, turns: 0 };
    for (const s of runStats.values()) {
      tot.input += s.inputTokens;
      tot.output += s.outputTokens;
      tot.cacheRead += s.cacheReadTokens;
      tot.cacheWrite += s.cacheCreationTokens;
      tot.cost += s.costUsd;
      tot.tools += s.toolCalls;
      tot.turns += s.turns;
    }
    const section = document.createElement("div");
    section.className = "stats-run-section";
    const header = document.createElement("div");
    header.className = "stats-run-header";
    header.textContent = "Total";
    section.appendChild(header);
    const grid = document.createElement("div");
    grid.className = "stats-grid";
    const rows = [
      ["Input", fmtTokens(tot.input)],
      ["Output", fmtTokens(tot.output)],
    ];
    if (tot.cacheRead) rows.push(["Cache read", fmtTokens(tot.cacheRead)]);
    if (tot.cacheWrite) rows.push(["Cache write", fmtTokens(tot.cacheWrite)]);
    rows.push(["Total tokens", fmtTokens(tot.input + tot.output)]);
    if (tot.tools) rows.push(["Tool calls", String(tot.tools)]);
    if (tot.turns) rows.push(["Turns", String(tot.turns)]);
    if (tot.cost) rows.push(["Cost", fmtCost(tot.cost)]);
    for (const [lbl, val] of rows) {
      const item = document.createElement("div");
      item.className = "stat-item";
      item.innerHTML = `<span class="stat-label">${esc(lbl)}</span><span class="stat-value">${esc(val)}</span>`;
      grid.appendChild(item);
    }
    section.appendChild(grid);
    panel.appendChild(section);
  }

  const renderRunIds = new Set([
    ...Array.from(runStats.keys()),
    ...currentRuns.map((run) => run.id),
  ]);
  for (const runId of renderRunIds) {
    const s = runStats.get(runId) || emptyRunStatsState();
    const run = currentRuns.find(r => r.id === runId);
    const agent = run ? run.agent : "unknown";
    const agentMeta = getAgentMeta(agent);
    const label = run ? (agentMeta.label || agent) : runId.slice(0, 8);

    const section = document.createElement("div");
    section.className = "stats-run-section";

    const header = document.createElement("div");
    header.className = "stats-run-header";
    const dot = document.createElement("span");
    dot.className = `run-tab-dot dot-${run?.status === "solving" ? "running" : run?.status === "solved" ? "solved" : "pending"}`;
    header.append(dot);
    header.append(document.createTextNode(label));
    if (run?.model) {
      const modelSpan = document.createElement("span");
      modelSpan.style.cssText = "font-weight:400;color:var(--text-dim);font-size:0.65rem";
      modelSpan.textContent = ` (${run.model})`;
      header.appendChild(modelSpan);
    }
    section.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "stats-grid";

    const totalTokens = s.inputTokens + s.outputTokens;
    const stats = [
      ["Input", fmtTokens(s.inputTokens)],
      ["Output", fmtTokens(s.outputTokens)],
    ];
    if (s.cacheReadTokens) stats.push(["Cache read", fmtTokens(s.cacheReadTokens)]);
    if (s.cacheCreationTokens) stats.push(["Cache write", fmtTokens(s.cacheCreationTokens)]);
    stats.push(["Total tokens", fmtTokens(totalTokens)]);
    if (s.toolCalls) stats.push(["Tool calls", String(s.toolCalls)]);
    if (s.turns) stats.push(["Turns", String(s.turns)]);
    if (s.costUsd) stats.push(["Cost", fmtCost(s.costUsd)]);
    if (s.durationMs) stats.push(["Duration", fmtDuration(s.durationMs)]);
    if (s.durationApiMs) stats.push(["API time", fmtDuration(s.durationApiMs)]);

    for (const [lbl, val] of stats) {
      const item = document.createElement("div");
      item.className = "stat-item";
      item.innerHTML = `<span class="stat-label">${esc(lbl)}</span><span class="stat-value">${esc(val)}</span>`;
      grid.appendChild(item);
    }
    section.appendChild(grid);

    if (s.modelUsage) {
      for (const [model, mu] of Object.entries(s.modelUsage)) {
        const msec = document.createElement("div");
        msec.className = "stats-model-section";
        const mh = document.createElement("div");
        mh.className = "stats-model-header";
        mh.textContent = model;
        msec.appendChild(mh);
        const mg = document.createElement("div");
        mg.className = "stats-grid";
        const mstats = [];
        if (mu.inputTokens) mstats.push(["Input", fmtTokens(mu.inputTokens)]);
        if (mu.outputTokens) mstats.push(["Output", fmtTokens(mu.outputTokens)]);
        if (mu.cacheReadInputTokens) mstats.push(["Cache read", fmtTokens(mu.cacheReadInputTokens)]);
        if (mu.cacheCreationInputTokens) mstats.push(["Cache write", fmtTokens(mu.cacheCreationInputTokens)]);
        if (mu.webSearchRequests) mstats.push(["Web searches", String(mu.webSearchRequests)]);
        if (mu.costUSD != null) mstats.push(["Cost", fmtCost(mu.costUSD)]);
        for (const [lbl, val] of mstats) {
          const item = document.createElement("div");
          item.className = "stat-item";
          item.innerHTML = `<span class="stat-label">${esc(lbl)}</span><span class="stat-value">${esc(val)}</span>`;
          mg.appendChild(item);
        }
        msec.appendChild(mg);
        section.appendChild(msec);
      }
    }

    panel.appendChild(section);
  }
}

// === Helpers ===
function iconClass(n) {
  const m = { Bash:"tool-icon-bash", Read:"tool-icon-read", Write:"tool-icon-write",
    Edit:"tool-icon-edit", Grep:"tool-icon-grep", Glob:"tool-icon-glob", Agent:"tool-icon-agent" };
  return m[n] || "tool-icon-other";
}

function iconLetter(n) {
  const m = { Bash:"$", Read:"R", Write:"W", Edit:"E", Grep:"?", Glob:"*", Agent:"A" };
  return m[n] || n.charAt(0);
}

function toolSummary(name, input) {
  if (!input) return "";
  switch (name) {
    case "Bash": return input.description || truncate(input.command || "", 50);
    case "Read": return shortPath(input.file_path || "");
    case "Write": return shortPath(input.file_path || "");
    case "Edit": return shortPath(input.file_path || "");
    case "Grep": return `"${input.pattern || ""}" ${shortPath(input.path || "")}`;
    case "Glob": return input.pattern || "";
    case "ToolSearch": return input.query || "";
    case "Agent": return input.description || truncate(input.prompt || "", 50);
    case "Skill": return input.skill_name || JSON.stringify(input);
    default: return truncate(JSON.stringify(input), 50);
  }
}

function toolInputDisplay(name, input) {
  if (!input) return "";
  switch (name) {
    case "Bash": return input.command || "";
    case "Read": return input.file_path || "";
    case "Write": return `${input.file_path || ""}\n---\n${truncate(input.content || "", 2000)}`;
    case "Edit": return `${input.file_path || ""}\n- ${input.old_string || ""}\n+ ${input.new_string || ""}`;
    case "Grep": return `pattern: ${input.pattern || ""}\npath: ${input.path || ""}`;
    case "Glob": return `pattern: ${input.pattern || ""}`;
    case "Agent": return `${input.description || ""}\n${input.prompt || ""}`;
    case "Skill": return JSON.stringify(input, null, 2);
    default: return JSON.stringify(input, null, 2);
  }
}

function shortPath(p) {
  if (!p) return "";
  const parts = p.split("/");
  return parts.length <= 3 ? p : ".../" + parts.slice(-2).join("/");
}

function truncate(s, n) { return !s ? "" : s.length > n ? s.slice(0, n) + "..." : s; }

function formatDuration(ms) {
  if (!ms) return "";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function appendMsg(container, text, cls, ts) {
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = text;
  if (ts != null) {
    const tsEl = document.createElement("span");
    tsEl.className = "msg-ts";
    tsEl.textContent = fmtElapsed(ts);
    div.appendChild(tsEl);
  }
  container.appendChild(div);
}

function esc(str) {
  // Escapes &<> AND quotes so the result is safe in both element-text and
  // double/single-quoted HTML attribute contexts. innerHTML serialization does
  // not encode quotes, so we escape explicitly to prevent attribute breakout.
  return (str == null ? "" : String(str))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtElapsed(seconds) {
  if (seconds == null) return "";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m${rem ? ` ${rem}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function makeTimestamp(event) {
  if (event.ts == null) return null;
  const el = document.createElement("span");
  el.className = "msg-ts";
  el.textContent = fmtElapsed(event.ts);
  return el;
}

// === Sidebar Tabs ===
document.querySelectorAll(".sidebar-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

function switchTab(tabId) {
  document.querySelectorAll(".sidebar-tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".sidebar-content").forEach((c) => c.classList.remove("active"));
  const btn = document.querySelector(`[data-tab="${tabId}"]`);
  if (btn) btn.classList.add("active");
  const content = document.getElementById(tabId);
  if (content) content.classList.add("active");
  if (tabId === "tab-files") loadFiles();
  if (tabId === "tab-advisor") loadAdvisor();
}

// === Advisor ===
let advisorWs = null;
let advisorStarted = false;
let advisorThinking = false;

function disconnectAdvisorWS() {
  if (advisorWs) {
    advisorWs.onclose = null;
    try { advisorWs.close(); } catch (_) {}
    advisorWs = null;
  }
}

function setAdvisorStatus(status) {
  const thinking = status === "thinking";
  advisorThinking = thinking;
  renderGatewayStatus();
  let ind = $("#advisor-thinking");
  if (thinking && !ind) {
    ind = document.createElement("div");
    ind.id = "advisor-thinking";
    ind.className = "advisor-thinking text-muted";
    ind.textContent = "Advisor is thinking…";
    $("#advisor-log").appendChild(ind);
    $("#advisor-log").scrollTop = $("#advisor-log").scrollHeight;
  } else if (!thinking && ind) {
    ind.remove();
  }
}

function populateAdvisorModels(agentName, selection = agentPreset(agentName)) {
  const model = $('#advisor-model');
  const effort = $('#advisor-effort');
  const controls = bindModelEffortControls(agentName, model, effort, selection);
  controls.lock(advisorStarted);
}

function populateAdvisorConfig(cfg) {
  const agentSel = $('#advisor-agent');
  renderAgentSelect(agentSel);
  agentSel.value = cfg.agent || defaultAgent || primaryAgentName();
  populateAdvisorModels(agentSel.value, { ...agentPreset(agentSel.value), ...cfg, preserve: advisorStarted });
  agentSel.disabled = advisorStarted;
}

function advisorAppendUser(text) {
  const log = $("#advisor-log");
  const el = document.createElement("div");
  el.className = "advisor-msg advisor-msg-user";
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function advisorAppend(kind, text, label) {
  const log = $("#advisor-log");
  const el = document.createElement("div");
  el.className = `advisor-line advisor-${kind}`;
  if (label) {
    const b = document.createElement("span");
    b.className = "advisor-label";
    b.textContent = label + " ";
    el.appendChild(b);
  }
  el.appendChild(document.createTextNode(text));
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function renderAdvisorEvent(event) {
  if (!event || typeof event !== "object") return;
  const et = event.type;
  if (et === "assistant" || et === "user") {
    // Provider events carry blocks under event.message.content (claude) — fall
    // back to event.content for other shapes.
    const blocks = (event.message && event.message.content) || event.content || [];
    for (const block of blocks) {
      if (block.type === "text" && block.text) advisorAppend("text", block.text);
      else if (block.type === "thinking" && block.thinking) advisorAppend("thinking", block.thinking, "thinking");
      else if (block.type === "tool_use") advisorAppend("tool", `${block.name} ${JSON.stringify(block.input || {})}`, "→");
      else if (block.type === "tool_result") advisorAppend("toolresult", String(block.content || "").slice(0, 1200), "⤷");
    }
  } else if (et === "error") {
    advisorAppend("error", event.message || "error", "✗");
  } else if (et === "system" && event.message) {
    advisorAppend("system", event.message, "·");
  }
}

function renderAdvisorHistory(messages) {
  const log = $("#advisor-log");
  log.innerHTML = "";
  for (const m of messages) {
    if (m.role === "user") advisorAppendUser(m.text || "");
    else if (m.role === "agent") renderAdvisorEvent(m.event);
  }
  if (!messages.length) {
    log.innerHTML = '<div class="advisor-hint text-muted">Ask the advisor about the ongoing solve, or have it research techniques. It can read the solver transcripts and (sparingly) push hints to them.</div>';
  }
}

function connectAdvisorWS() {
  disconnectAdvisorWS();
  if (!currentChallengeId) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const cid = currentChallengeId;
  advisorWs = new WebSocket(`${proto}//${location.host}/ws/${cid}/advisor`);
  advisorWs.onmessage = (e) => {
    if (cid !== currentChallengeId) return;
    const ev = JSON.parse(e.data);
    if (ev.type === "advisor_user") advisorAppendUser(ev.text || "");
    else if (ev.type === "advisor_event") renderAdvisorEvent(ev.event);
    else if (ev.type === "advisor_status") setAdvisorStatus(ev.status);
    else if (ev.type === 'advisor_reset') {
      advisorStarted = false;
      $('#advisor-log').innerHTML = '';
      $('#advisor-agent').disabled = false;
      $('#advisor-model')._gatewayControls?.lock(false);
      setAdvisorStatus('idle');
    }
  };
  advisorWs.onclose = () => { advisorWs = null; };
}

async function loadAdvisor() {
  if (!currentChallengeId) return;
  const res = await api(`/api/challenges/${currentChallengeId}/advisor`);
  if (!res || !res.ok) {
    const error = res ? await res.json().catch(() => ({})) : {};
    showToast(error.error || 'Unable to load advisor configuration', 'error');
    return;
  }
  const data = await res.json();
  advisorStarted = !!data.started;
  populateAdvisorConfig(data.config || {});
  renderAdvisorHistory(data.messages || []);
  setAdvisorStatus(data.status || "idle");
  connectAdvisorWS();
}

document.addEventListener('DOMContentLoaded', () => {
  $('#advisor-agent').addEventListener('change', () => populateAdvisorModels($('#advisor-agent').value));
  $('#advisor-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#advisor-input');
    const msg = input.value.trim();
    if (!msg || !currentChallengeId || catalogState !== 'ready') return;
    const body = { message: msg };
    if (!advisorStarted) {
      if ($('#advisor-model').dataset.unavailable === 'true') { showToast('Select an available 9router model', 'error'); return; }
      body.agent = $('#advisor-agent').value;
      body.model = $('#advisor-model').value;
      body.effort = $('#advisor-effort').value;
    }
    const btn = $('#advisor-send');
    btn.dataset.busy = 'true';
    btn.disabled = true;
    try {
      const res = await api('/api/challenges/' + currentChallengeId + '/advisor', { method: 'POST', body: JSON.stringify(body) });
      if (!res || !res.ok) return;
      input.value = '';
      advisorStarted = true;
      $('#advisor-agent').disabled = true;
      $('#advisor-model')._gatewayControls.lock(true);
    } finally { delete btn.dataset.busy; renderGatewayStatus(); }
  });
  $('#btn-advisor-reset').addEventListener('click', async () => {
    if (!currentChallengeId) return;
    const btn = $('#btn-advisor-reset');
    btn.disabled = true;
    try {
      const res = await api('/api/challenges/' + currentChallengeId + '/advisor/reset', { method: 'POST' });
      if (!res || !res.ok) return;
      advisorStarted = false;
      $('#advisor-log').innerHTML = '';
      $('#advisor-agent').disabled = false;
      $('#advisor-model')._gatewayControls?.lock(false);
      setAdvisorStatus('idle');
    } finally { btn.disabled = false; }
  });
});

// === Files Browser ===
function normalizeFileBrowserPath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function parentFileBrowserPath(path) {
  const parts = normalizeFileBrowserPath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function fileTypeLabel(type) {
  if (type === "image") return "IMG";
  if (type === "text") return "TXT";
  if (type === "binary") return "BIN";
  return "FILE";
}

function renderFilesBreadcrumb(path) {
  const breadcrumb = $("#files-breadcrumb");
  if (!breadcrumb) return;
  const cleanPath = normalizeFileBrowserPath(path);
  breadcrumb.innerHTML = "";

  const root = document.createElement("button");
  root.type = "button";
  root.className = "file-crumb";
  root.textContent = "root";
  root.addEventListener("click", () => loadFiles(""));
  breadcrumb.appendChild(root);

  let acc = "";
  for (const part of cleanPath.split("/").filter(Boolean)) {
    const sep = document.createElement("span");
    sep.className = "file-crumb-sep";
    sep.textContent = "/";
    breadcrumb.appendChild(sep);

    acc = acc ? `${acc}/${part}` : part;
    const crumbPath = acc;
    const crumb = document.createElement("button");
    crumb.type = "button";
    crumb.className = "file-crumb";
    crumb.textContent = part;
    crumb.title = crumbPath;
    crumb.addEventListener("click", () => loadFiles(crumbPath));
    breadcrumb.appendChild(crumb);
  }
}

function createFileRow(entry) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = `file-item ${entry.kind === "directory" ? "file-folder" : ""}`;

  const icon = document.createElement("span");
  icon.className = `file-icon file-icon-${entry.kind === "directory" ? "directory" : entry.type}`;
  icon.textContent = entry.kind === "directory" ? "DIR" : fileTypeLabel(entry.type);

  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = entry.name;
  name.title = entry.path;

  const size = document.createElement("span");
  size.className = "file-size";
  size.textContent = entry.kind === "directory" ? "" : formatSize(entry.size || 0);

  item.append(icon, name, size);
  if (entry.kind === "directory") {
    item.addEventListener("click", () => loadFiles(entry.path));
  } else {
    item.addEventListener("click", () => viewFile(entry.path));
  }
  return item;
}

async function loadFiles(path = fileBrowserPath) {
  if (!currentChallengeId) return;
  const challengeId = currentChallengeId;
  const token = ++fileBrowserRequestToken;
  const nextPath = normalizeFileBrowserPath(path);

  const params = new URLSearchParams();
  params.set("browse", "1");
  params.set("dir", nextPath);
  const runSelect = $("#files-run-select");
  if (runSelect && runSelect.value) {
    params.set("run_id", runSelect.value);
  }
  const url = `/api/challenges/${challengeId}/files?${params.toString()}`;
  const res = await api(url);
  if (!res) return;
  if (token !== fileBrowserRequestToken || challengeId !== currentChallengeId) {
    return;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(err.error || "Failed to load files", "error");
    return;
  }
  const data = await res.json();
  const entries = data.entries || [];

  fileBrowserPath = normalizeFileBrowserPath(data.path || nextPath);
  renderFilesBreadcrumb(fileBrowserPath);
  $("#file-counter").textContent = entries.length;
  const tree = $("#files-tree");
  tree.innerHTML = "";

  if (fileBrowserPath) {
    tree.appendChild(createFileRow({
      kind: "directory",
      name: "..",
      path: parentFileBrowserPath(fileBrowserPath),
    }));
  }

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "file-empty";
    empty.textContent = "No files in this folder";
    tree.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    tree.appendChild(createFileRow(entry));
  }
}

$("#btn-refresh-files").addEventListener("click", () => loadFiles());

// Listen for files run select change
const filesRunSelect = $("#files-run-select");
if (filesRunSelect) {
  filesRunSelect.addEventListener("change", () => {
    fileBrowserPath = "";
    loadFiles("");
  });
}

// Auto-refresh files while solving
setInterval(() => {
  if (
    currentChallengeId &&
    !views.detail.classList.contains("hidden") &&
    $("#tab-files").classList.contains("active")
  ) {
    loadFiles();
  }
}, 8000);

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// === File Viewer ===
function encodeFilePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

async function viewFile(path) {
  if (!currentChallengeId) return;
  const encodedPath = encodeFilePath(path);
  let url = `/api/challenges/${currentChallengeId}/files/${encodedPath}`;
  const runSelect = $("#files-run-select");
  if (runSelect && runSelect.value) {
    url += `?run_id=${encodeURIComponent(runSelect.value)}`;
  }
  const res = await api(url);
  if (!res) return;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(err.error || "Failed to open file", "error");
    return;
  }
  const data = await res.json();

  $("#file-viewer-name").textContent = data.name;
  $("#file-viewer-size").textContent = formatSize(data.size);

  const body = $("#file-viewer-content");
  body.innerHTML = "";

  if (data.type === "image") {
    const wrapper = document.createElement("div");
    wrapper.className = "file-viewer-image";
    const img = document.createElement("img");
    img.src = `data:${data.mime};base64,${data.data}`;
    img.alt = data.name;
    wrapper.appendChild(img);
    body.appendChild(wrapper);
  } else if (data.type === "text") {
    const pre = document.createElement("pre");
    pre.className = "file-viewer-code";
    pre.innerHTML = highlightSyntax(data.content, data.ext);
    body.appendChild(pre);
  } else {
    const pre = document.createElement("pre");
    pre.className = "file-viewer-hex";
    pre.textContent = data.hexdump;
    body.appendChild(pre);
  }

  // Set download link (include run_id if selected)
  const dlBtn = $("#file-viewer-download");
  let dlUrl = `/api/challenges/${currentChallengeId}/download/${encodedPath}`;
  const dlRunSelect = $("#files-run-select");
  if (dlRunSelect && dlRunSelect.value) {
    dlUrl += `?run_id=${encodeURIComponent(dlRunSelect.value)}`;
  }
  dlBtn.href = dlUrl;
  dlBtn.download = data.name;

  $("#file-viewer-overlay").classList.remove("hidden");
}

$("#file-viewer-close").addEventListener("click", () => {
  $("#file-viewer-overlay").classList.add("hidden");
});
$("#file-viewer-overlay").addEventListener("click", (e) => {
  if (e.target === $("#file-viewer-overlay"))
    $("#file-viewer-overlay").classList.add("hidden");
});

// === Syntax Highlighting ===
function highlightSyntax(code, ext) {
  const escaped = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const langExts = {
    py: "python", js: "js", ts: "js", c: "c", cpp: "c", h: "c",
    rs: "rust", go: "go", java: "java", rb: "ruby", sh: "bash",
    bash: "bash", zsh: "bash", sql: "sql", json: "json",
  };
  const lang = langExts[(ext || "").replace(".", "")] || "";

  if (!lang) return escaped;

  let result = escaped;

  // Comments
  if (["python", "bash", "ruby"].includes(lang)) {
    result = result.replace(/(#[^\n]*)/g, '<span class="syn-comment">$1</span>');
  } else if (["c", "js", "rust", "go", "java"].includes(lang)) {
    result = result.replace(/(\/\/[^\n]*)/g, '<span class="syn-comment">$1</span>');
  }

  // Strings
  result = result.replace(/(&quot;[^&]*?&quot;|"[^"]*?"|'[^']*?'|`[^`]*?`)/g,
    '<span class="syn-string">$1</span>');

  // Numbers
  result = result.replace(/\b(0x[\da-fA-F]+|\d+\.?\d*)\b/g,
    '<span class="syn-number">$1</span>');

  // Keywords
  const keywords = {
    python: "def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|yield|lambda|pass|break|continue|raise|and|or|not|in|is|True|False|None|async|await",
    js: "function|const|let|var|return|if|else|for|while|try|catch|finally|throw|class|import|export|from|async|await|new|this|true|false|null|undefined|switch|case|default|break|continue",
    c: "int|char|void|return|if|else|for|while|do|switch|case|break|continue|struct|typedef|enum|const|static|extern|unsigned|signed|long|short|float|double|sizeof|NULL|include|define",
    rust: "fn|let|mut|const|if|else|for|while|loop|match|return|struct|enum|impl|trait|use|pub|mod|self|super|crate|where|async|await|move|ref|type|true|false|Some|None|Ok|Err",
    bash: "if|then|else|elif|fi|for|while|do|done|case|esac|function|return|local|export|source|echo|exit|test|set",
  };
  const kw = keywords[lang] || keywords.js;
  if (kw) {
    result = result.replace(
      new RegExp(`\\b(${kw})\\b`, "g"),
      '<span class="syn-keyword">$1</span>'
    );
  }

  return result;
}

// === Keyboard Shortcuts ===
document.addEventListener("keydown", (e) => {
  // Ignore when typing in inputs
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA"
      || e.target.tagName === "SELECT") return;

  // Only in detail view
  if (views.detail.classList.contains("hidden")) return;

  if (e.key === "Escape") {
    // Close file viewer if open, otherwise go back
    if (!$("#file-viewer-overlay").classList.contains("hidden")) {
      $("#file-viewer-overlay").classList.add("hidden");
    } else {
      disconnectAllWS(); currentChallengeId = null;
      history.replaceState(null, "", "#");
      showView("dashboard"); loadChallenges();
    }
    e.preventDefault();
  }
  if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
    $("#steer-input").focus();
    e.preventDefault();
  }
  // Sidebar tabs: 1-3
  if (e.key === "1") switchTab("tab-info");
  if (e.key === "2") switchTab("tab-stats");
  if (e.key === "3") switchTab("tab-files");

  // Left/Right arrows to switch run tabs
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (!currentRuns.length) return;
    const idx = currentRuns.findIndex((r) => r.id === activeRunId);
    if (idx === -1) return;
    let newIdx;
    if (e.key === "ArrowLeft") {
      newIdx = idx > 0 ? idx - 1 : currentRuns.length - 1;
    } else {
      newIdx = idx < currentRuns.length - 1 ? idx + 1 : 0;
    }
    switchRunTab(currentRuns[newIdx].id);
    e.preventDefault();
  }
});

// === Scroll to Bottom Button ===
$("#btn-scroll-bottom").addEventListener("click", () => {
  autoScroll = true;
  const f = getActiveFeed();
  if (f) f.scrollTop = f.scrollHeight;
  updateScrollBtn();
});

// === Expand/Collapse All Tools ===
$("#btn-toggle-tools").addEventListener("click", () => {
  const feed = getActiveFeed();
  if (!feed) return;
  const details = feed.querySelectorAll(".tool-detail");
  const anyOpen = Array.from(details).some((d) => d.classList.contains("open"));
  details.forEach((d) => d.classList.toggle("open", !anyOpen));
  $("#btn-toggle-tools").textContent = anyOpen ? "Expand all" : "Collapse all";
});

$("#btn-transcript-search").addEventListener("click", searchTranscript);
$("#btn-transcript-search-clear").addEventListener("click", clearTranscriptSearch);
$("#transcript-search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    searchTranscript();
  } else if (e.key === "Escape") {
    clearTranscriptSearch();
  }
});

// === Export Report ===
$("#btn-export").addEventListener("click", async () => {
  if (!currentChallengeId) return;
  openExportOptions([currentChallengeId], false);
});

// === Mobile Sidebar Toggle ===
$("#btn-sidebar-toggle").addEventListener("click", () => {
  const sidebar = document.querySelector(".panel-sidebar");
  if (sidebar) sidebar.classList.toggle("sidebar-open");
});

// === Steer ===
async function sendSteerToRun(runId, inputEl) {
  const msg = inputEl.value.trim();
  if (!msg || !currentChallengeId || catalogState !== 'ready') return;
  const button = inputEl.parentElement.querySelector('.split-steer-btn') || $('#btn-steer');
  await withBusy(button, async () => {
    const res = await api('/api/challenges/' + currentChallengeId + '/steer', { method: 'POST', body: JSON.stringify({ message: msg, ...(runId ? { run_id: runId } : {}) }) });
    if (!res || !res.ok) return;
    inputEl.value = '';
    markRunsSolving(runId || '');
    updateStatusBadge('solving'); updateButtons('solving'); startTimer();
    $('#error-banner').classList.add('hidden');
  });
}

async function sendSteer() {
  await sendSteerToRun(activeRunId && activeRunId !== '__default__' ? activeRunId : '', $('#steer-input'));
}

$("#btn-steer").addEventListener("click", sendSteer);
$("#steer-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendSteer(); }
});
$("#btn-active-run-skills").addEventListener("click", () => {
  const runId = activeRunId && activeRunId !== "__default__"
    ? activeRunId
    : currentRuns[0]?.id;
  if (runId) openRunSkillsModal(runId);
});
$("#btn-active-run-stop").addEventListener("click", () => {
  const runId = activeRunId && activeRunId !== "__default__"
    ? activeRunId
    : currentRuns[0]?.id;
  if (runId) stopRun(runId);
});
$("#btn-add-run").addEventListener("click", openAddRunModal);
$("#add-run-close").addEventListener("click", closeAddRunModal);
$("#add-run-overlay").addEventListener("click", (e) => {
  if (e.target.id === "add-run-overlay") closeAddRunModal();
});
$("#add-run-prompt").addEventListener("input", () => {
  addRunPromptDirty = true;
});
$("#btn-add-run-reset-prompt").addEventListener("click", () => {
  addRunPromptDirty = false;
  refreshAddRunPromptTemplate();
});

$("#btn-add-run-agent-row").addEventListener("click", () => {
  addAgentRow($("#add-run-agent-list"));
});
$("#btn-add-run-submit").addEventListener("click", submitAddRun);
$("#run-skill-close").addEventListener("click", closeRunSkillsModal);
$("#run-skill-overlay").addEventListener("click", (e) => {
  if (e.target.id === "run-skill-overlay") closeRunSkillsModal();
});
$("#btn-run-skills-apply").addEventListener("click", () => {
  applyRunSkills();
});
$("#btn-run-skills-apply-all").addEventListener("click", () => {
  applyRunSkills({ applyToAll: true });
});
$("#btn-run-skills-reset").addEventListener("click", () => {
  applyRunSkills({ reset: true });
});
$("#run-goal-close").addEventListener("click", closeRunGoalModal);
$("#btn-run-goal-cancel").addEventListener("click", closeRunGoalModal);
$("#run-goal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "run-goal-overlay") closeRunGoalModal();
});
$("#btn-run-goal-save").addEventListener("click", saveRunGoal);
$("#btn-run-goal-clear").addEventListener("click", clearRunGoal);

// === User Broadcast ===
$("#btn-broadcast").addEventListener("click", sendBroadcast);
$("#broadcast-msg").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendBroadcast(); }
});
async function sendBroadcast() {
  const msg = $("#broadcast-msg").value.trim();
  if (!msg || !currentChallengeId) return;
  const res = await api(`/api/challenges/${currentChallengeId}/broadcast`, {
    method: "POST",
    body: JSON.stringify({ message: msg }),
  });
  if (res && res.ok) {
    $("#broadcast-msg").value = "";
    showToast("Broadcast sent", "success");
  }
}

// === Usage Page ===
$("#btn-usage").addEventListener("click", () => {
  showView("usage");
  loadUsage();
});
$("#btn-usage-back").addEventListener("click", () => {
  showView("dashboard");
  loadChallenges();
});
$('#btn-usage-refresh').addEventListener('click', e => withBusy(e.currentTarget, async () => { await loadAgentCatalog(true); await loadUsage(); }));

async function loadUsage() {
  const btn = $('#btn-usage-refresh');
  btn.disabled = true;
  try {
    const res = await api('/api/usage');
    if (!res || !res.ok) return;
    renderUsage(await res.json());
  } finally { btn.disabled = false; }
}

function renderUsage(data) {
  if (data.gateway && (catalogState === 'ready' || data.gateway.status !== 'ready')) {
    gatewayStatus = data.gateway;
    if (gatewayStatus.status !== 'ready') catalogState = gatewayStatus.status;
    document.querySelectorAll('select').forEach(sel => sel._gatewayControls?.refresh());
  }
  renderGatewayStatus();
  agentCatalog.forEach(agent => {
    const card = document.getElementById('usage-' + agent.name);
    if (!card) return;
    const entry = data.agents?.[agent.name] || gatewayStatus.harnesses?.[agent.name] || {};
    const badge = card.querySelector('[data-harness-status]');
    badge.textContent = entry.ready ? 'Catalog ready' : entry.available ? 'Not ready' : 'Unavailable';
    badge.className = 'badge ' + (entry.ready ? 'badge-solved' : 'badge-failed');
    card.querySelector('[data-harness-error]').textContent = entry.error || 'Native harness available; catalog readiness does not verify inference or quota.';
    card.querySelector('[data-challenge-stats]').innerHTML = renderChallengeStats(data.challenges?.[agent.name]);
  });
}


function kvRow(key, value) {
  return '<span class="usage-kv"><span class="usage-k">' + esc(String(key)) + '</span> ' + esc(String(value)) + '</span>';
}

function renderChallengeStats(stats) {
  if (!stats || stats.total === 0) return '<span class="text-muted">No challenges yet</span>';
  const avgMs = stats.total > 0 ? Math.round(stats.total_duration_ms / stats.total) : 0;
  return [
    kvRow("Challenges", stats.total),
    kvRow("Solved", stats.solved),
    kvRow("Failed", stats.failed),
    kvRow("Avg duration", formatDuration(avgMs)),
    kvRow("Total time", formatDuration(stats.total_duration_ms)),
  ].join("");
}


// === Import from Platform ===
let importPlugins = [];
let importPluginConfig = {};
let importFetchedChallenges = [];
let importProgressTimer = null;

function importPhase(name) {
  ["config", "loading", "preview", "progress"].forEach((phase) => {
    const el = $(`#import-phase-${phase}`);
    if (el) el.classList.toggle("hidden", phase !== name);
  });
}

function makeClientId(prefix) {
  if (window.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function renderImportProgress(state = {}) {
  const percent = Math.max(0, Math.min(100, Number(state.overall_percent || 0)));
  $("#import-progress-bar-fill").style.width = `${percent}%`;
  $("#import-progress-title").textContent = state.message || "Importing challenges...";
  const completed = state.completed_challenges ?? 0;
  const total = state.total_challenges ?? 0;
  const parts = [`${percent}%`, `${completed}/${total} challenges`];
  if (state.file_count) parts.push(`${state.file_index || 0}/${state.file_count} files`);
  $("#import-progress-meta").textContent = parts.join(" · ");

  const detail = [];
  if (state.current_challenge) detail.push(`Challenge: ${state.current_challenge}`);
  if (state.current_file) {
    const size = state.file_total
      ? `${formatSize(state.file_downloaded || 0)} / ${formatSize(state.file_total)}`
      : `${formatSize(state.file_downloaded || 0)}`;
    detail.push(`File: ${state.current_file} (${size})`);
  }
  $("#import-progress-detail").textContent = detail.join(" · ");

  const events = state.events || [];
  $("#import-progress-log").innerHTML = events
    .slice(-12)
    .map((event) => `<div>${esc(event)}</div>`)
    .join("");
}

function stopImportProgressPolling() {
  if (importProgressTimer) clearInterval(importProgressTimer);
  importProgressTimer = null;
}

function startImportProgressPolling(progressId) {
  stopImportProgressPolling();
  const poll = async () => {
    const res = await api(`/api/plugins/import/progress/${encodeURIComponent(progressId)}`);
    if (!res || !res.ok) return;
    const data = await res.json();
    renderImportProgress(data);
    if (["done", "failed"].includes(data.status)) stopImportProgressPolling();
  };
  poll();
  importProgressTimer = setInterval(poll, 500);
}

async function loadPlugins() {
  const res = await api("/api/plugins");
  if (!res) return;
  importPlugins = await res.json();
  const sel = $("#import-plugin");
  sel.innerHTML = importPlugins.map((p) =>
    `<option value="${esc(p.name)}">${esc(p.label)}</option>`
  ).join("");
  if (importPlugins.length) renderImportConfigFields(importPlugins[0]);
}

function renderImportConfigFields(plugin) {
  const container = $("#import-config-fields");
  container.innerHTML = (plugin.config_schema || []).map((f) => {
    if (f.type === "checkbox") {
      return `
    <div class="form-group">
      <label class="checkbox-label" for="import-cfg-${esc(f.name)}">
        <input type="checkbox" id="import-cfg-${esc(f.name)}" ${f.default ? "checked" : ""}>
        <span>${esc(f.label)}</span>
      </label>
    </div>`;
    }
    return `
    <div class="form-group">
      <label for="import-cfg-${esc(f.name)}">${esc(f.label)}</label>
      <input type="${esc(f.type)}" id="import-cfg-${esc(f.name)}"
        placeholder="${esc(f.placeholder || "")}"
        value="${esc(f.default || "")}"
        ${f.required ? "required" : ""}>
    </div>`;
  }).join("");
}

function getImportConfig() {
  const plugin = importPlugins.find((p) => p.name === $("#import-plugin").value);
  if (!plugin) return {};
  const config = {};
  for (const f of plugin.config_schema || []) {
    const el = document.getElementById(`import-cfg-${f.name}`);
    if (!el) continue;
    config[f.name] = f.type === "checkbox" ? el.checked : el.value;
  }
  return config;
}

$("#btn-import").addEventListener("click", async () => {
  await loadPlugins();
  if (!importPlugins.length) {
    showToast("No platform plugins available", "error");
    return;
  }
  // Reset state
  importFetchedChallenges = [];
  importChallengeSkillOverrides = new Map();
  stopImportProgressPolling();
  importPhase("config");
  $("#import-status").classList.add("hidden");
  // Set up preview controls using saved agent settings
  populateAgentList($("#import-agent-list"));
  bindSkillSelection($("#import-skill-list"), { skills_mode: defaultSkillsMode, enabled_skills: defaultEnabledSkills });
  $("#import-flag").value = defaultFlagFormat;
  $("#import-overlay").classList.remove("hidden");
});

$("#import-close").addEventListener("click", () => {
  stopImportProgressPolling();
  $("#import-overlay").classList.add("hidden");
});
$("#import-overlay").addEventListener("click", (e) => {
  if (e.target === $("#import-overlay")) {
    stopImportProgressPolling();
    $("#import-overlay").classList.add("hidden");
  }
});

$("#import-plugin").addEventListener("change", () => {
  const plugin = importPlugins.find((p) => p.name === $("#import-plugin").value);
  if (plugin) renderImportConfigFields(plugin);
});

$("#btn-import-test").addEventListener("click", async () => {
  const statusEl = $("#import-status");
  statusEl.textContent = "Testing...";
  statusEl.className = "import-status";
  statusEl.classList.remove("hidden");

  const res = await api("/api/plugins/test", {
    method: "POST",
    body: JSON.stringify({
      plugin: $("#import-plugin").value,
      config: getImportConfig(),
    }),
  });
  if (!res) return;
  const data = await res.json();
  if (data.ok) {
    statusEl.textContent = data.message;
    statusEl.className = "import-status import-status-ok";
  } else {
    statusEl.textContent = data.error || "Connection failed";
    statusEl.className = "import-status import-status-error";
  }
});

$("#btn-import-fetch").addEventListener("click", async () => {
  importPluginConfig = getImportConfig();
  importPhase("loading");

  const res = await api("/api/plugins/fetch", {
    method: "POST",
    body: JSON.stringify({
      plugin: $("#import-plugin").value,
      config: importPluginConfig,
    }),
  });

  if (!res || !res.ok) {
    const err = res ? await res.json().catch(() => ({})) : {};
    showToast(err.error || "Fetch failed", "error");
    importPhase("config");
    return;
  }

  importFetchedChallenges = await res.json();
  importChallengeSkillOverrides = new Map();
  renderImportPreview();
  importPhase("preview");
});

function renderImportPreview() {
  const list = $("#import-challenge-list");

  // Group by category, sort by points within each category
  const indexed = importFetchedChallenges.map((c, i) => ({ ...c, _idx: i }));
  const groups = {};
  for (const c of indexed) {
    const cat = c.category || "misc";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(c);
  }
  for (const cat of Object.keys(groups)) {
    groups[cat].sort((a, b) => (a.points || 0) - (b.points || 0));
  }
  const sortedCats = Object.keys(groups).sort();

  let html = "";
  for (const cat of sortedCats) {
    html += `<div class="import-category-group">
      <div class="import-category-header">${esc(cat)}</div>
      <div class="import-card-grid">`;
    for (const c of groups[cat]) {
      const fileLabel = c.files.length
        ? `${c.files.length} file${c.files.length !== 1 ? "s" : ""}`
        : "No files";
      const solvedClass = c.solved ? "import-ch-solved" : "";
      const questionCount = (c.flag_questions || []).length;
      html += `
      <div class="import-card ${solvedClass}" data-index="${c._idx}">
        <div class="import-card-top">
          <input type="checkbox" class="import-ch-enabled" ${c.solved ? "" : "checked"}>
          <input type="text" class="bulk-ch-name" value="${esc(c.name)}">
        </div>
        <div class="import-card-meta">
          ${c.points ? `<span class="import-card-badge">${c.points} pts</span>` : ""}
          <span class="import-card-badge">${c.solves ?? 0} solve${c.solves !== 1 ? "s" : ""}</span>
          <span class="import-card-badge">${esc(fileLabel)}</span>
          ${questionCount ? `<span class="import-card-badge">${questionCount} question${questionCount !== 1 ? "s" : ""}</span>` : ""}
          ${c.solved ? '<span class="badge badge-solved">solved</span>' : ""}
        </div>
        <div class="import-card-skill-row">
          <button type="button" class="btn-ghost btn-sm" data-challenge-skill-edit data-kind="import" data-index="${c._idx}">Skills</button>
          <span class="challenge-skill-summary" data-kind="import" data-index="${c._idx}">Default skills</span>
        </div>
        <textarea class="bulk-ch-desc" rows="2" placeholder="Description">${esc(c.description || "")}</textarea>
      </div>`;
    }
    html += `</div></div>`;
  }

  list.innerHTML = html;
  updateChallengeSkillSummaries("import");
  updateImportSkipSolved();
}

function updateImportSkipSolved() {
  const skip = $("#import-skip-solved").checked;
  const cards = document.querySelectorAll("#import-challenge-list .import-card");
  cards.forEach((card) => {
    const idx = parseInt(card.dataset.index, 10);
    const ch = importFetchedChallenges[idx];
    const cb = card.querySelector(".import-ch-enabled");
    if (ch && ch.solved && skip) {
      cb.checked = false;
      card.classList.add("bulk-ch-disabled");
    }
  });
}

$("#btn-add-import-agent").addEventListener("click", () => {
  addAgentRow($("#import-agent-list"));
});

$("#btn-import-select-all").addEventListener("click", () => {
  document.querySelectorAll("#import-challenge-list .import-ch-enabled").forEach((cb) => { cb.checked = true; });
});
$("#btn-import-deselect-all").addEventListener("click", () => {
  document.querySelectorAll("#import-challenge-list .import-ch-enabled").forEach((cb) => { cb.checked = false; });
});

$("#import-skip-solved").addEventListener("change", () => {
  const cards = document.querySelectorAll("#import-challenge-list .import-card");
  const skip = $("#import-skip-solved").checked;
  cards.forEach((card) => {
    const idx = parseInt(card.dataset.index, 10);
    const ch = importFetchedChallenges[idx];
    const cb = card.querySelector(".import-ch-enabled");
    if (ch && ch.solved) {
      cb.checked = !skip;
      card.classList.toggle("bulk-ch-disabled", skip);
    }
  });
});

$("#btn-import-submit").addEventListener("click", async () => {
  const cards = document.querySelectorAll("#import-challenge-list .import-card");
  const selected = Array.from(cards).map((card) => {
    const idx = parseInt(card.dataset.index, 10);
    const ch = importFetchedChallenges[idx];
    const cfg = {
      enabled: card.querySelector(".import-ch-enabled").checked,
      remote_id: ch.remote_id,
      name: card.querySelector(".bulk-ch-name").value.trim(),
      description: card.querySelector(".bulk-ch-desc").value.trim(),
      category: ch.category,
      points: ch.points || 0,
      solves: ch.solves || 0,
      tags: ch.tags || [],
      flag_questions: ch.flag_questions || [],
      files: ch.files,
    };
    if (importChallengeSkillOverrides.has(idx)) {
      Object.assign(cfg, importChallengeSkillOverrides.get(idx));
    }
    return cfg;
  });

  const btn = $("#btn-import-submit");
  btn.dataset.busy = 'true';
  btn.disabled = true;
  btn.textContent = "Importing...";
  const progressId = makeClientId("platform-import");
  renderImportProgress({
    status: "running",
    overall_percent: 0,
    completed_challenges: 0,
    total_challenges: selected.filter((c) => c.enabled).length,
    message: "Starting import...",
    events: ["Starting import..."],
  });
  importPhase("progress");
  startImportProgressPolling(progressId);

  try {
    const agentRows = getAgentRows($("#import-agent-list"));
    if (!agentRows) { importPhase('preview'); return; }
    const mode = agentRows.length > 1 ? "parallel" : "single";
    const res = await api("/api/plugins/import", {
      method: "POST",
      body: JSON.stringify({
        plugin: $("#import-plugin").value,
        config: importPluginConfig,
        challenges: selected,
        mode: mode,
        agents: JSON.stringify(agentRows),
        ...skillSelectionPayload($("#import-skill-list")),
        flag_format: $("#import-flag").value.trim(),
        paused: $("#import-paused").checked,
        progress_id: progressId,
      }),
    });
    stopImportProgressPolling();
    const finalProgress = await api(
      `/api/plugins/import/progress/${encodeURIComponent(progressId)}`
    );
    if (finalProgress && finalProgress.ok) {
      renderImportProgress(await finalProgress.json());
    }

    if (!res || !res.ok) {
      const err = res ? await res.json().catch(() => ({})) : {};
      showToast(err.error || "Import failed", "error");
      importPhase("preview");
      return;
    }
    const data = await res.json();
    const entries = data.created || [];
    const successes = entries.filter((e) => e.id && e.status !== "error" && e.status !== "skipped");
    const skipped = entries.filter((e) => e.status === "skipped");
    const errors = entries.filter((e) => e.status === "error");
    const warnings = entries.filter((e) => e.warning);
    if (successes.length) {
      showToast(`Imported ${successes.length} challenge(s)`, "success");
    }
    if (warnings.length) {
      showToast(`${warnings.length} challenge(s) imported with missing files`, "info");
    }
    if (skipped.length) {
      showToast(`${skipped.length} challenge(s) skipped: ${skipped[0].error}`, "info");
    }
    if (errors.length) {
      showToast(`${errors.length} challenge(s) failed: ${errors[0].error}`, "error");
    }
    if (!successes.length && !skipped.length && !errors.length) {
      showToast("No challenges imported", "info");
    }
    $("#import-overlay").classList.add("hidden");
    loadChallenges();
  } finally {
    stopImportProgressPolling();
    delete btn.dataset.busy;
    renderGatewayStatus();
    btn.textContent = "Import Selected";
  }
});

// === Settings View ===
function formatVpnBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatVpnHandshake(timestamp) {
  const ts = Number(timestamp || 0);
  if (!ts) return "never";
  const age = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (age < 60) return `${age}s ago`;
  if (age < 3600) return `${Math.floor(age / 60)}m ago`;
  if (age < 86400) return `${Math.floor(age / 3600)}h ago`;
  return `${Math.floor(age / 86400)}d ago`;
}

// (Manager settings removed — no manager in new collaborative model)

function updateSettingsVpnStatus(data) {
  const badge = $("#settings-vpn-status");
  const toggleBtn = $("#btn-settings-vpn-toggle");
  if (data.up) {
    badge.textContent = "up";
    badge.className = "badge badge-solved";
    toggleBtn.textContent = "Stop";
  } else {
    badge.textContent = "down";
    badge.className = "badge badge-pending";
    toggleBtn.textContent = "Start";
  }
  const peerEl = $("#settings-vpn-peer");
  if (data.peer) {
    peerEl.classList.remove("hidden");
    $("#settings-vpn-peer-key").textContent = data.peer.public_key || "—";
    $("#settings-vpn-peer-endpoint").textContent = data.peer.endpoint || "—";
    $("#settings-vpn-peer-handshake").textContent = formatVpnHandshake(data.peer.latest_handshake);
    const rx = parseInt(data.peer.transfer_rx || 0);
    const tx = parseInt(data.peer.transfer_tx || 0);
    $("#settings-vpn-peer-transfer").textContent = `${formatVpnBytes(rx)} rx / ${formatVpnBytes(tx)} tx`;
  } else {
    peerEl.classList.add("hidden");
  }
}

$("#btn-settings").addEventListener("click", async () => {
  await Promise.all([loadSkillCatalog(), loadResources()]);
  const res = await api("/api/settings");
  if (!res || !res.ok) { showToast('Unable to load Settings', 'error'); return; }
  const s = await res.json();

  // General
  $("#settings-flag-format").value = s.default_flag_format || "";
  $("#settings-theme").value = s.theme || "dark";
  $("#settings-chat-view").value = s.chat_view_mode || "split";
  $("#settings-max-platform-import-size").value = s.max_platform_import_size_gb || 2;
  $("#settings-auto-submit").checked = !!s.auto_submit_flags;

  // Agents
  const agentList = $('#settings-agent-list');
  const savedEnabled = s.enabled_agents?.length ? s.enabled_agents : [defaultAgent];
  const savedModels = s.agent_models || {};
  const savedEfforts = s.agent_efforts || {};
  settingsAgentDirty.clear();
  settingsEnabledDirty = false;
  settingsOriginalModels = { ...savedModels };
  settingsOriginalEfforts = { ...savedEfforts };
  agentList.innerHTML = '';
  for (const agent of agentCatalog) {
    const row = document.createElement('div');
    row.className = 'settings-agent-row';
    row.innerHTML = '<label class="checkbox-label"><input type="checkbox" class="settings-agent-cb" value="' + esc(agent.name) + '" ' + (savedEnabled.includes(agent.name) ? 'checked' : '') + '><span>' + esc(agent.label) + '</span></label><select class="settings-agent-model" data-agent="' + esc(agent.name) + '"></select><select class="settings-agent-effort" data-agent="' + esc(agent.name) + '"></select>';
    agentList.appendChild(row);
    const preset = agentPreset(agent.name);
    bindModelEffortControls(agent.name, row.querySelector('.settings-agent-model'), row.querySelector('.settings-agent-effort'), {
      model: Object.hasOwn(savedModels, agent.name) ? savedModels[agent.name] : preset.model,
      effort: Object.hasOwn(savedEfforts, agent.name) ? savedEfforts[agent.name] : preset.effort,
    });
    row.addEventListener('change', e => {
      if (e.target.classList.contains('settings-agent-cb')) settingsEnabledDirty = true;
      else settingsAgentDirty.add(agent.name);
    });
  }

  bindSkillSelection($("#settings-skill-list"), { skills_mode: skillsMode(s), enabled_skills: s.enabled_skills ?? defaultEnabledSkills });
  $("#settings-skill-upload").value = "";
  $("#settings-skill-upload-result").textContent = "";
  $("#settings-hook-rtk").checked = new Set(s.enabled_hooks || []).has("rtk");

  // Discord
  $("#settings-discord-enabled").checked = !!s.discord_enabled;
  $("#settings-discord-token").value = s.discord_bot_token || "";
  $("#settings-discord-layout").value = s.discord_challenge_layout || "threads";
  const discordChannel = $("#settings-discord-channel");
  if (s.discord_channel_id) {
    // Preserve saved value; user can hit Refresh to populate the dropdown
    if (!discordChannel.querySelector(`option[value="${s.discord_channel_id}"]`)) {
      const opt = document.createElement("option");
      opt.value = s.discord_channel_id;
      opt.textContent = `Channel ${s.discord_channel_id}`;
      opt.selected = true;
      discordChannel.appendChild(opt);
    } else {
      discordChannel.value = s.discord_channel_id;
    }
  }

  // VPN
  const vpnRes = await api("/api/vpn");
  if (vpnRes) {
    const vpnData = await vpnRes.json();
    if (!vpnData.installed) {
      $("#settings-vpn-not-installed").classList.remove("hidden");
      $("#settings-vpn-panel").classList.add("hidden");
    } else {
      $("#settings-vpn-not-installed").classList.add("hidden");
      $("#settings-vpn-panel").classList.remove("hidden");
      updateSettingsVpnStatus(vpnData);
    }
  }

  loadSwarm();

  showView("settings");
});

$("#btn-settings-back").addEventListener("click", () => {
  showView("dashboard");
  loadChallenges();
});

// === Swarm (GCP) ===
let swarmConfigCache = {};

function swarmLogLine(message, level, ts) {
  const el = $("#swarm-log");
  if (!el) return;
  const t = ts ? new Date(ts * 1000) : new Date();
  const prefix = level === "error" ? "✗" : level === "success" ? "✓" : "·";
  el.textContent += `[${t.toLocaleTimeString()}] ${prefix} ${message}\n`;
  el.scrollTop = el.scrollHeight;
}

// Instant client-side feedback (ephemeral; replaced by the persisted server log
// on the next loadSwarm).
function swarmLog(message, level) {
  swarmLogLine(message, level);
}

// Replace the panel with the persistent server-side log.
function renderSwarmLog(entries) {
  const el = $("#swarm-log");
  if (!el) return;
  el.textContent = "";
  for (const e of entries || []) swarmLogLine(e.message, e.level, e.ts);
}

function handleSwarmEvent(event) {
  swarmLogLine(event.message || "", event.level, event.ts);
  if (event.refresh) loadSwarm();
}

function renderSwarmConfig(cfg) {
  swarmConfigCache = cfg || {};
  $("#settings-swarm-project").value = cfg.project || "";
  $("#settings-swarm-zone").value = cfg.zone || "";
  $("#settings-swarm-machine").value = cfg.default_machine_type || "e2-standard-4";
  $("#settings-swarm-disk").value = cfg.default_disk_size_gb || 100;
  $("#settings-swarm-idle").value = cfg.idle_stop_minutes ?? 30;
  $("#settings-swarm-vpn").checked = !!cfg.vpn_route;
  $("#settings-swarm-adc").checked = !!cfg.use_adc;
  $("#settings-swarm-sa-status").textContent = cfg.service_account_configured
    ? "Key configured. Leave blank to keep it."
    : "No key configured.";
  const tokStatus = $("#settings-swarm-token-status");
  if (tokStatus) tokStatus.textContent = cfg.access_token_configured
    ? "Token set. Leave blank to keep it; type 'clear' to remove."
    : "No token set.";
  // ADC takes precedence; hide token + SA fields when ADC is on.
  const adc = !!cfg.use_adc;
  const saGroup = $("#settings-swarm-sa-group");
  if (saGroup) saGroup.style.display = adc ? "none" : "";
  const tokGroup = $("#settings-swarm-token-group");
  if (tokGroup) tokGroup.style.display = adc ? "none" : "";
}

function renderSwarmInstances(instances, image) {
  const imgEl = $("#swarm-image-status");
  if (imgEl) {
    imgEl.textContent = image && image.name
      ? `Image: ${image.name} (built ${image.built_at ? new Date(image.built_at * 1000).toLocaleString() : "?"})`
      : "No image built yet.";
  }
  const rows = $("#swarm-instance-rows");
  const empty = $("#swarm-no-instances");
  if (!rows) return;
  if (!instances || !instances.length) {
    rows.innerHTML = "";
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");
  rows.innerHTML = instances.map((inst) => {
    const running = inst.status === "running";
    const startStop = running
      ? `<button class="btn-ghost btn-sm swarm-act" data-act="stop" data-name="${esc(inst.name)}">Stop</button>`
      : `<button class="btn-ghost btn-sm swarm-act" data-act="start" data-name="${esc(inst.name)}">Start</button>`;
    return `<tr>
      <td>${esc(inst.name)}</td>
      <td><span class="badge badge-${running ? "solving" : "pending"}">${esc(inst.status || "?")}</span></td>
      <td>${esc(inst.external_ip || "—")}</td>
      <td>${esc(inst.machine_type || "?")}</td>
      <td>${esc(inst.challenge_name || inst.challenge_id || "—")}</td>
      <td class="swarm-actions">
        ${startStop}
        <button class="btn-ghost btn-sm swarm-act" data-act="sync-credentials" data-name="${esc(inst.name)}">Sync creds</button>
        <button class="btn-ghost btn-sm swarm-act" data-act="delete" data-name="${esc(inst.name)}">Delete</button>
      </td>
    </tr>`;
  }).join("");
}

async function loadSwarm() {
  const res = await api("/api/swarm");
  if (!res || !res.ok) return;
  const data = await res.json();
  renderSwarmConfig(data.config || {});
  renderSwarmInstances(data.instances || [], data.image || {});
  renderSwarmLog(data.log || []);
}

function swarmConfigBody() {
  return {
    service_account: $("#settings-swarm-sa").value.trim(),
    access_token: $("#settings-swarm-token").value.trim(),
    project: $("#settings-swarm-project").value.trim(),
    zone: $("#settings-swarm-zone").value.trim(),
    default_machine_type: $("#settings-swarm-machine").value.trim(),
    default_disk_size_gb: parseInt($("#settings-swarm-disk").value, 10) || 100,
    idle_stop_minutes: parseInt($("#settings-swarm-idle").value, 10) || 0,
    vpn_route: $("#settings-swarm-vpn").checked,
    use_adc: $("#settings-swarm-adc").checked,
  };
}

async function saveSwarmConfig() {
  const res = await api("/api/swarm/config", {
    method: "POST", body: JSON.stringify(swarmConfigBody()),
  });
  if (!res) return null;
  const data = await res.json();
  if (!res.ok) { showToast(data.error || "Save failed", "error"); return null; }
  $("#settings-swarm-sa").value = "";
  $("#settings-swarm-token").value = "";
  renderSwarmConfig(data.config || {});
  return data;
}

$("#btn-swarm-save").addEventListener("click", async () => {
  if (await saveSwarmConfig()) showToast("Swarm config saved", "success");
});

$("#settings-swarm-adc").addEventListener("change", (e) => {
  const hide = e.target.checked ? "none" : "";
  const saGroup = $("#settings-swarm-sa-group");
  if (saGroup) saGroup.style.display = hide;
  const tokGroup = $("#settings-swarm-token-group");
  if (tokGroup) tokGroup.style.display = hide;
});

$("#btn-swarm-test").addEventListener("click", async () => {
  const out = $("#swarm-test-result");
  out.textContent = "Saving & testing…";
  // Persist the current form first so the test reflects what you typed.
  if (!(await saveSwarmConfig())) { out.textContent = "Save failed"; return; }
  const res = await api("/api/swarm/test", { method: "POST" });
  const data = res ? await res.json() : null;
  if (res && res.ok && data.ok) {
    out.textContent = `OK — project ${data.info?.project || "?"}, zone ${data.info?.zone || "?"}`;
  } else {
    out.textContent = (data && data.error) || "Connection failed";
  }
});

$("#btn-swarm-build-image").addEventListener("click", async () => {
  if (!confirm("Build/rebuild the golden image? This provisions a base VM and takes ~10–15 min.")) return;
  const res = await api("/api/swarm/image/build", { method: "POST" });
  const data = res ? await res.json() : null;
  if (res && res.ok) swarmLog("Image build started…");
  else showToast((data && data.error) || "Build failed to start", "error");
});

$("#btn-swarm-spinup").addEventListener("click", async () => {
  const body = {
    count: parseInt($("#settings-swarm-count").value, 10) || 1,
    machine_type: $("#settings-swarm-spinup-machine").value.trim(),
  };
  const res = await api("/api/swarm/instances", { method: "POST", body: JSON.stringify(body) });
  const data = res ? await res.json() : null;
  if (res && res.ok) swarmLog(`Spinning up ${data.count} worker(s)…`);
  else showToast((data && data.error) || "Spin up failed", "error");
});

$("#btn-swarm-refresh").addEventListener("click", async () => {
  const res = await api("/api/swarm/refresh", { method: "POST" });
  if (res && res.ok) loadSwarm();
});

const SWARM_ACT_LABELS = {
  start: "Starting", stop: "Stopping", "sync-credentials": "Syncing creds",
  delete: "Deleting",
};

$("#swarm-instance-rows").addEventListener("click", async (e) => {
  const btn = e.target.closest(".swarm-act");
  if (!btn) return;
  const name = btn.dataset.name;
  const act = btn.dataset.act;
  if (act === "delete" &&
      !confirm(`Delete instance ${name}? Its workspace is destroyed (logs stay here).`)) {
    return;
  }
  // In-flight feedback: GCP stop/delete can take 30–60s. Disable the row's
  // buttons, mark the active one, and log immediately so it doesn't look dead.
  const label = SWARM_ACT_LABELS[act] || act;
  const row = btn.closest("tr");
  const rowBtns = row ? row.querySelectorAll(".swarm-act") : [btn];
  rowBtns.forEach((b) => { b.disabled = true; });
  const orig = btn.textContent;
  btn.textContent = `${label}…`;
  swarmLog(`${label} ${name}…`);

  const url = `/api/swarm/instances/${encodeURIComponent(name)}` +
    (act === "delete" ? "" : `/${act}`);
  const res = await api(url, { method: act === "delete" ? "DELETE" : "POST" });
  const data = res ? await res.json() : null;

  if (res && res.ok) {
    // The server records the persistent "done" line; loadSwarm re-renders the
    // table + the persisted log (resetting button state).
    loadSwarm();
  } else {
    btn.textContent = orig;
    rowBtns.forEach((b) => { b.disabled = false; });
    const msg = (data && data.error) || `${label} failed`;
    showToast(msg, "error");  // server also logs the failure persistently
  }
});

$("#btn-settings-skill-upload").addEventListener("click", uploadSettingsSkill);

$("#btn-settings-save").addEventListener("click", async () => {
  const selectedAgents = Array.from(document.querySelectorAll(".settings-agent-cb:checked")).map((cb) => cb.value);
  if (!selectedAgents.length) { showToast('At least one agent is required', 'error'); return; }
  const models = { ...settingsOriginalModels };
  document.querySelectorAll(".settings-agent-model").forEach((sel) => {
    if (selectedAgents.includes(sel.dataset.agent) || settingsAgentDirty.has(sel.dataset.agent)) models[sel.dataset.agent] = sel.value;
  });
  const efforts = { ...settingsOriginalEfforts };
  document.querySelectorAll(".settings-agent-effort").forEach((sel) => {
    if (selectedAgents.includes(sel.dataset.agent) || settingsAgentDirty.has(sel.dataset.agent)) efforts[sel.dataset.agent] = sel.value;
  });

  const body = {
    default_flag_format: $("#settings-flag-format").value.trim(),
    theme: $("#settings-theme").value,
    chat_view_mode: $("#settings-chat-view").value,
    max_platform_import_size_gb: Number($("#settings-max-platform-import-size").value || 2),
    auto_submit_flags: $("#settings-auto-submit").checked,
    enabled_agents: selectedAgents,
    agent_models: models,
    agent_efforts: efforts,
    ...skillSelectionPayload($("#settings-skill-list")),
    enabled_hooks: $("#settings-hook-rtk").checked ? ["rtk"] : [],
    default_agent: selectedAgents[0] || defaultAgent,
    discord_enabled: $("#settings-discord-enabled").checked,
    discord_bot_token: $("#settings-discord-token").value.trim(),
    discord_channel_id: $("#settings-discord-channel").value.trim(),
    discord_challenge_layout: $("#settings-discord-layout").value,
  };
  if (!settingsEnabledDirty && !settingsAgentDirty.size) {
    delete body.enabled_agents; delete body.agent_models; delete body.agent_efforts; delete body.default_agent;
  }
  else {
    const invalid = selectedAgents.some(name => {
      const row = Array.from(document.querySelectorAll('.settings-agent-row')).find(el => el.querySelector('.settings-agent-cb').value === name);
      return !row || row.querySelector('.settings-agent-model').dataset.unavailable === 'true' || gatewayStatus.harnesses?.[name]?.ready === false;
    });
    if (catalogState !== 'ready' || invalid) { showToast(gatewayStatus.error || 'Select an available 9router model and harness before saving presets.', 'error'); return; }
  }
  await withBusy($('#btn-settings-save'), async () => {
    const res = await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
    if (res && res.ok) {
      const saved = await res.json();
      defaultFlagFormat = saved.default_flag_format || "";
      currentTheme = saved.theme || "dark";
      chatViewMode = saved.chat_view_mode || "split";
      enabledAgents = saved.enabled_agents && saved.enabled_agents.length
        ? saved.enabled_agents : [defaultAgent];
      agentModels = saved.agent_models || {};
      agentEfforts = saved.agent_efforts || {};
      defaultEnabledSkills = normalizeSkillNames(saved.enabled_skills ?? []);
      defaultSkillsMode = skillsMode(saved);
      bindSkillSelection($("#settings-skill-list"), saved);
      defaultAgent = saved.default_agent || enabledAgents[0];
      settingsAgentDirty.clear(); settingsEnabledDirty = false;
      settingsOriginalModels = { ...agentModels }; settingsOriginalEfforts = { ...agentEfforts };
      applyTheme(currentTheme);
      showToast("Settings saved", "success");
    }
  });
});

// Discord channel fetch
$("#btn-discord-fetch-channels").addEventListener("click", async () => {
  const token = $("#settings-discord-token").value.trim();
  if (!token) { showToast("Enter bot token first", "error"); return; }
  const sel = $("#settings-discord-channel");
  const saved = sel.value;
  sel.innerHTML = '<option value="">Loading...</option>';
  const res = await api("/api/discord/channels", { method: "POST", body: JSON.stringify({ token }) });
  if (!res) { sel.innerHTML = '<option value="">Failed</option>'; return; }
  const data = await res.json();
  const channels = data.channels || [];
  sel.innerHTML = '<option value="">— Select channel —</option>' +
    channels.map((c) => `<option value="${esc(c.id)}" ${c.id === saved ? "selected" : ""}>${esc(c.guild)} / ${esc(c.name)}</option>`).join("");
  if (saved && !sel.value) sel.value = saved;
});

// Discord test button
$("#btn-discord-test").addEventListener("click", async () => {
  const result = $("#discord-test-result");
  result.textContent = "Testing...";
  const res = await api("/api/discord/test", { method: "POST", body: JSON.stringify({
    token: $("#settings-discord-token").value.trim(),
    channel_id: $("#settings-discord-channel").value.trim(),
  })});
  if (!res) { result.textContent = "Request failed"; return; }
  const data = await res.json();
  result.textContent = data.ok ? "Connected!" : (data.error || "Failed");
});

// VPN controls within settings
$("#btn-settings-vpn-toggle").addEventListener("click", async () => {
  const badge = $("#settings-vpn-status");
  const action = badge.textContent === "up" ? "down" : "up";
  const res = await api("/api/vpn/toggle", {
    method: "POST",
    body: JSON.stringify({ action }),
  });
  if (res && res.ok) {
    const data = await res.json();
    const vpnRes = await api("/api/vpn");
    if (vpnRes) updateSettingsVpnStatus(await vpnRes.json());
    showToast(`VPN ${data.up ? "started" : "stopped"}`, "success");
  }
});

$("#btn-settings-vpn-configure").addEventListener("click", async () => {
  const clientNetworks = $("#settings-vpn-networks").value.trim();
  const dnsForward = $("#settings-vpn-dns").checked;

  const res = await api("/api/vpn/configure", {
    method: "POST",
    body: JSON.stringify({
      client_networks: clientNetworks,
      dns_forward: dnsForward,
    }),
  });
  if (!res) return;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(err.error || "Configuration failed", "error");
    return;
  }
  const data = await res.json();
  $("#settings-vpn-config-text").textContent = data.client_config;
  $("#settings-vpn-client-config").classList.remove("hidden");

  const vpnRes = await api("/api/vpn");
  if (vpnRes) updateSettingsVpnStatus(await vpnRes.json());
  downloadTextFile("ctf-vpn.conf", data.client_config);
  showToast("VPN configured and client config downloaded", "success");
});

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$("#btn-settings-vpn-copy").addEventListener("click", () => {
  const text = $("#settings-vpn-config-text").textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = $("#btn-settings-vpn-copy");
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 1200);
  });
});

$("#btn-settings-vpn-download").addEventListener("click", () => {
  const text = $("#settings-vpn-config-text").textContent;
  if (text) downloadTextFile("ctf-vpn.conf", text);
});

// (Manager sidebar tab removed — agents collaborate via WORKING_NOTES and BREAKTHROUGHS.md)

// === Deep Linking ===
function getDeepLinkChallengeId() {
  const match = location.hash.match(/^#\/challenge\/([a-f0-9]+)$/);
  return match ? match[1] : null;
}

async function handleDeepLink() {
  const challengeId = getDeepLinkChallengeId();
  if (challengeId) {
    openChallenge(challengeId);
  } else {
    showView("dashboard");
    loadChallenges();
  }
}

function handleHashChange() {
  const challengeId = getDeepLinkChallengeId();
  if (challengeId && challengeId !== currentChallengeId) {
    openChallenge(challengeId);
  } else if (!challengeId && currentChallengeId) {
    disconnectAllWS(); stopTimer(); currentChallengeId = null;
    showView("dashboard"); loadChallenges();
  }
}

window.addEventListener("pagehide", () => {
  appAlive = false;
  disconnectGlobalWS();
});

window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  appAlive = true;
  connectGlobalWS();
});

// === Init ===
(async () => {
  showView("dashboard");
  initializeGatewayCards();
  initializeSkillControls();
  $("#btn-resources-refresh").addEventListener("click", e => withBusy(e.currentTarget, () => Promise.all([loadSkillCatalog(), loadResources()]), "Refreshing…"));
  await Promise.all([
    loadAgentCatalog(),
    loadSkillCatalog(),
    loadResources(),
  ]);
  await loadDefaultAgent();
  if (!appAlive) return;
  window.addEventListener("hashchange", handleHashChange);
  connectGlobalWS();
  await handleDeepLink();
  loadConnections();
})();
