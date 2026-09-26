const API_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "ads_and_distractions",
  confidenceThreshold: 0.72,
  maxCallsPerPage: 30,
  showIndicator: true,
  allowedHosts: [],
};
const MAX_PARALLEL_REQUESTS = 4;
const classificationQueue = [];
let activeRequestCount = 0;
let statsMutationChain = Promise.resolve();
let diagnosticMutationChain = Promise.resolve();
const DIAGNOSTIC_SCHEMA = 1;
const DIAGNOSTIC_LIMIT = 150;

const DEFAULT_STATS = {
  totalCalls: 0,
  totalRemoved: 0,
  failedCalls: 0,
  lastDecision: null,
  lastConfidence: null,
  lastLatencyMs: null,
  lastModel: null,
  lastError: null,
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(["settings", "stats"]);
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, ...(current.settings || {}) },
    stats: { ...DEFAULT_STATS, ...(current.stats || {}) },
  });
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  updateBadge();
});

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function getStats() {
  const { stats } = await chrome.storage.local.get("stats");
  return { ...DEFAULT_STATS, ...(stats || {}) };
}

function mutateStats(mutator) {
  const job = statsMutationChain.then(async () => {
    const current = await getStats();
    const next = mutator(current);
    await chrome.storage.local.set({ stats: next });
    return next;
  });
  statsMutationChain = job.catch(() => undefined);
  return job;
}

function patchStats(patch) {
  return mutateStats((current) => ({ ...current, ...patch }));
}

async function getDiagnostics() {
  const { diagnostics } = await chrome.storage.local.get("diagnostics");
  return Array.isArray(diagnostics) ? diagnostics.slice(-DIAGNOSTIC_LIMIT) : [];
}

function mutateDiagnostics(mutator) {
  const job = diagnosticMutationChain.then(async () => {
    const current = await getDiagnostics();
    const next = mutator(current).slice(-DIAGNOSTIC_LIMIT);
    await chrome.storage.local.set({ diagnostics: next });
    return next;
  });
  diagnosticMutationChain = job.catch(() => undefined);
  return job;
}

function appendDiagnostic(entry) {
  return mutateDiagnostics((diagnostics) => [...diagnostics, entry]);
}

function updateDiagnostic(requestId, patch) {
  if (!requestId) return Promise.resolve();
  return mutateDiagnostics((diagnostics) => diagnostics.map((entry) =>
    entry.requestId === requestId ? { ...entry, ...patch } : entry
  ));
}

function newRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function hasApiKey() {
  const { jevApiKey } = await chrome.storage.session.get("jevApiKey");
  return Boolean(jevApiKey);
}

function updateBadge(count = 0) {
  const active = activeRequestCount > 0;
  chrome.action.setBadgeBackgroundColor({ color: active ? "#f59e0b" : "#334155" });
  chrome.action.setBadgeText({ text: active ? String(Math.min(activeRequestCount, MAX_PARALLEL_REQUESTS)) : (count ? String(Math.min(count, 999)) : "") });
}

function setRequestActive(delta) {
  activeRequestCount = Math.max(0, activeRequestCount + delta);
  updateBadge();
}

function safeDescriptor(input) {
  if (!input || typeof input !== "object") throw new Error("Missing element descriptor.");
  const pick = (value, max = 20) => String(value || "").slice(0, max);
  const tokens = (value) => Array.isArray(value) ? value.slice(0, 12).map((v) => pick(v, 32)) : [];
  return {
    pageHost: pick(input.pageHost, 180),
    tag: pick(input.tag, 16),
    role: pick(input.role, 32),
    idTokens: tokens(input.idTokens),
    classTokens: tokens(input.classTokens),
    ariaTokens: tokens(input.ariaTokens),
    width: Math.max(0, Math.min(10000, Number(input.width) || 0)),
    height: Math.max(0, Math.min(10000, Number(input.height) || 0)),
    viewportCoverage: Math.max(0, Math.min(1, Number(input.viewportCoverage) || 0)),
    position: pick(input.position, 16),
    zIndex: Math.max(-1, Math.min(2147483647, Number(input.zIndex) || 0)),
    linkHosts: tokens(input.linkHosts),
    resourceHosts: tokens(input.resourceHosts),
    signals: tokens(input.signals),
    protectionSignals: tokens(input.protectionSignals),
    textLength: Math.max(0, Math.min(100000, Number(input.textLength) || 0)),
  };
}
function buildPayload(candidate, mode) {
  return {
    model: "jev-latest",
    state: {
      purpose: "browser_element_triage",
      privacy_note: "No page text, cookies, form values, or full URL are included.",
      blocking_mode: mode,
      page: { hostname: candidate.pageHost },
      candidate: {
        tag: candidate.tag,
        role: candidate.role,
        id_tokens: candidate.idTokens,
        class_tokens: candidate.classTokens,
        aria_tokens: candidate.ariaTokens,
        geometry: {
          width_px: candidate.width,
          height_px: candidate.height,
          viewport_coverage: candidate.viewportCoverage,
          css_position: candidate.position,
          z_index: candidate.zIndex,
        },
        outbound_link_hosts: candidate.linkHosts,
        embedded_resource_hosts: candidate.resourceHosts,
        detected_signals: candidate.signals,
        primary_content_protections: candidate.protectionSignals,
        text_length: candidate.textLength,
      },
    },
    questions: {
      disposition: {
        type: "choice",
        instructions: "Classify this browser element conservatively using the structural signals provided. Choose remove_ad for paid ads, sponsored placements, and their containers. Choose remove_distraction for non-essential overlays, email-capture/newsletter modals, sticky bottom promotions, and floating or sticky video players that detach from article content while scrolling. Always keep recipe instructions, ingredients, article/main content, their ancestor containers, normal in-flow recipe media, navigation, search, comments, account controls, consent/security notices, checkout controls, and anything genuinely ambiguous.",
        criteria: {
          remove_ad: "Paid advertisement, sponsored placement, affiliate promotion, or ad container.",
          remove_distraction: "Non-essential modal or overlay, email-capture/newsletter popup, autoplay or floating/sticky media player, sticky promotion, or attention-grabbing interruption.",
          keep: "Primary content, navigation, utility, user-requested media, safety/consent control, commerce control, or ambiguous element.",
        },
      },
    },
  };
}

function readDecision(data) {
  const answer = data?.answers?.disposition;
  const choice = answer?.choice;
  const confidence = Number(answer?.confidence);
  if (!["remove_ad", "remove_distraction", "keep"].includes(choice)) {
    throw new Error("Jev returned an unexpected decision.");
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Jev returned an invalid confidence value.");
  }
  return { choice, confidence, model: String(data?.model || "jev-latest") };
}

async function classify(rawCandidate) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, error: "Jev Focus Guard is paused." };
  const { jevApiKey } = await chrome.storage.session.get("jevApiKey");
  if (!jevApiKey) return { ok: false, needsKey: true, error: "Add your Jev API key in the extension popup." };

  const candidate = safeDescriptor(rawCandidate);
  const payload = buildPayload(candidate, settings.mode);
  const requestId = newRequestId();
  const statsAfterStart = await mutateStats((current) => ({
    ...current,
    totalCalls: current.totalCalls + 1,
    lastError: null,
  }));
  const callNumber = statsAfterStart.totalCalls;
  const startedAt = performance.now();
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${jevApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    if (response.status === 401 || response.status === 403) {
      await chrome.storage.session.remove("jevApiKey");
      throw new Error("Jev rejected the API key. Add a current key in the popup.");
    }
    if (response.status === 429) {
      await chrome.storage.local.set({ settings: { ...settings, enabled: false } });
      throw new Error("Jev rate-limited requests. The extension has been paused; re-enable it later.");
    }
    if (!response.ok) throw new Error(`Jev request failed (${response.status}).`);
    const parsed = readDecision(await response.json());
    const shouldRemove = parsed.confidence >= settings.confidenceThreshold &&
      (parsed.choice === "remove_ad" ||
       (settings.mode === "ads_and_distractions" && parsed.choice === "remove_distraction"));
    await patchStats({
      lastDecision: parsed.choice,
      lastConfidence: parsed.confidence,
      lastLatencyMs: latencyMs,
      lastModel: parsed.model,
      lastError: null,
    });
    const action = shouldRemove
      ? "remove_requested"
      : parsed.choice === "keep" ? "kept_by_jev" : "kept_by_policy";
    await appendDiagnostic({
      requestId,
      timestamp: new Date().toISOString(),
      pageHost: candidate.pageHost,
      candidate,
      policy: { mode: settings.mode, confidenceThreshold: settings.confidenceThreshold },
      response: { choice: parsed.choice, confidence: parsed.confidence, model: parsed.model },
      action,
      latencyMs,
    });
    return { ok: true, ...parsed, shouldRemove, latencyMs, callNumber, requestId };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    await mutateStats((current) => ({
      ...current,
      failedCalls: current.failedCalls + 1,
      lastLatencyMs: latencyMs,
      lastError: error.message,
    }));
    await appendDiagnostic({
      requestId,
      timestamp: new Date().toISOString(),
      pageHost: candidate.pageHost,
      candidate,
      policy: { mode: settings.mode, confidenceThreshold: settings.confidenceThreshold },
      response: null,
      action: "request_failed",
      latencyMs,
      error: String(error.message || "Jev request failed").slice(0, 300),
    });
    return { ok: false, error: error.message, latencyMs, callNumber, requestId };
  }
}

function pumpClassificationQueue() {
  while (activeRequestCount < MAX_PARALLEL_REQUESTS && classificationQueue.length) {
    const { candidate, resolve, reject } = classificationQueue.shift();
    setRequestActive(1);
    classify(candidate).then(resolve, reject).finally(() => {
      setRequestActive(-1);
      pumpClassificationQueue();
    });
  }
}

function queueClassification(candidate) {
  return new Promise((resolve, reject) => {
    classificationQueue.push({ candidate, resolve, reject });
    pumpClassificationQueue();
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "CLASSIFY":
        sendResponse(await queueClassification(message.candidate));
        break;
      case "GET_STATE": {
        const [settings, stats, keyPresent] = await Promise.all([getSettings(), getStats(), hasApiKey()]);
        sendResponse({ ok: true, settings, stats, keyPresent });
        break;
      }
      case "SET_KEY": {
        const key = String(message.key || "").trim();
        if (key.length < 12) throw new Error("That API key looks incomplete.");
        await chrome.storage.session.set({ jevApiKey: key });
        sendResponse({ ok: true });
        break;
      }
      case "CLEAR_KEY":
        await chrome.storage.session.remove("jevApiKey");
        sendResponse({ ok: true });
        break;
      case "SAVE_SETTINGS": {
        const previous = await getSettings();
        const incoming = message.settings || {};
        const settings = {
          ...previous,
          enabled: Boolean(incoming.enabled),
          mode: incoming.mode === "ads_only" ? "ads_only" : "ads_and_distractions",
          confidenceThreshold: [0.6, 0.72, 0.85].includes(Number(incoming.confidenceThreshold)) ? Number(incoming.confidenceThreshold) : 0.72,
          maxCallsPerPage: [10, 20, 30, 50].includes(Number(incoming.maxCallsPerPage)) ? Number(incoming.maxCallsPerPage) : 30,
          showIndicator: Boolean(incoming.showIndicator),
          allowedHosts: Array.isArray(incoming.allowedHosts)
            ? incoming.allowedHosts.map((host) => String(host).slice(0, 180)).slice(0, 200)
            : previous.allowedHosts,
        };
        await chrome.storage.local.set({ settings });
        sendResponse({ ok: true, settings });
        break;
      }
      case "RECORD_REMOVED": {
        const stats = await mutateStats((current) => ({
          ...current,
          totalRemoved: current.totalRemoved + 1,
        }));
        await updateDiagnostic(message.requestId, { action: "hidden_on_page" });
        updateBadge(stats.totalRemoved);
        sendResponse({ ok: true, totalRemoved: stats.totalRemoved });
        break;
      }
      case "RECORD_ACTION": {
        const patch = { action: String(message.action || "updated").slice(0, 60) };
        if (Array.isArray(message.protections)) patch.protections = message.protections.slice(0, 12);
        await updateDiagnostic(message.requestId, patch);
        sendResponse({ ok: true });
        break;
      }
      case "GET_DIAGNOSTICS": {
        const [settings, stats, entries] = await Promise.all([getSettings(), getStats(), getDiagnostics()]);
        sendResponse({
          ok: true,
          diagnostics: {
            schemaVersion: DIAGNOSTIC_SCHEMA,
            exportedAt: new Date().toISOString(),
            extensionVersion: chrome.runtime.getManifest().version,
            privacy: "No API key, cookies, form values, page text, or full URLs are included.",
            settings,
            stats,
            entries,
          },
        });
        break;
      }
      case "CLEAR_DIAGNOSTICS":
        await mutateDiagnostics(() => []);
        sendResponse({ ok: true });
        break;
      case "RESET_STATS":
        await mutateStats(() => ({ ...DEFAULT_STATS }));
        updateBadge();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "Unknown request." });
    }
  })().catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
