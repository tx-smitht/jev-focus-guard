const $ = (id) => document.getElementById(id);
let appState = null;
let activeTab = null;
let activeHost = "";

function bg(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => {
    resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : response);
  }));
}
function tabMessage(message) {
  if (!activeTab?.id) return Promise.resolve({ ok: false });
  return new Promise((resolve) => chrome.tabs.sendMessage(activeTab.id, message, (response) => {
    resolve(chrome.runtime.lastError ? { ok: false } : response);
  }));
}
function titleCase(value) {
  return String(value || "—").replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function downloadJson(data) {
  const host = (activeHost || "browser").replace(/[^a-z0-9.-]+/gi, "-");
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `jev-focus-guard-${host}-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function render() {
  const { settings, stats, keyPresent } = appState;
  $("enabled").checked = settings.enabled;
  $("mode").value = settings.mode;
  $("confidence").value = String(settings.confidenceThreshold);
  $("maxCalls").value = String(settings.maxCallsPerPage);
  $("indicator").checked = settings.showIndicator;
  $("removedCount").textContent = stats.totalRemoved.toLocaleString();
  $("callCount").textContent = stats.totalCalls.toLocaleString();
  $("latency").textContent = stats.lastLatencyMs == null ? "—" : `${stats.lastLatencyMs} ms`;
  $("lastDecision").textContent = titleCase(stats.lastDecision);
  $("lastConfidence").textContent = stats.lastConfidence == null ? "—" : `${Math.round(stats.lastConfidence * 100)}%`;
  $("lastModel").textContent = stats.lastModel || "—";
  $("lastError").hidden = !stats.lastError;
  $("lastError").textContent = stats.lastError || "";
  $("keyCard").hidden = keyPresent;
  $("clearKey").hidden = !keyPresent;
  const allowed = activeHost && settings.allowedHosts.includes(activeHost);
  $("siteToggle").textContent = allowed ? "Block on this site" : "Allow this site";
  $("siteToggle").disabled = !activeHost;
  $("statusLine").textContent = !keyPresent ? "API key needed" : !settings.enabled ? "Paused" : allowed ? `Allowed on ${activeHost}` : "Connected · watching this page";
}

async function refresh() {
  appState = await bg({ type: "GET_STATE" });
  if (appState?.ok) render();
}

async function saveSettings(patch) {
  const settings = { ...appState.settings, ...patch };
  const result = await bg({ type: "SAVE_SETTINGS", settings });
  if (result?.ok) {
    appState.settings = result.settings;
    await tabMessage({ type: "SETTINGS_CHANGED", settings: result.settings });
    render();
  }
}

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(activeTab?.url || "");
    if (["http:", "https:"].includes(url.protocol)) activeHost = url.hostname;
  } catch { /* Chrome internal pages cannot be scanned */ }
  await refresh();

  $("saveKey").addEventListener("click", async () => {
    const key = $("apiKey").value.trim();
    const result = await bg({ type: "SET_KEY", key });
    $("apiKey").value = "";
    if (!result?.ok) {
      $("lastError").hidden = false;
      $("lastError").textContent = result?.error || "Could not save the key.";
      return;
    }
    await refresh();
    await tabMessage({ type: "RESCAN" });
  });
  $("apiKey").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("saveKey").click();
  });
  $("clearKey").addEventListener("click", async () => { await bg({ type: "CLEAR_KEY" }); await refresh(); });
  $("enabled").addEventListener("change", () => saveSettings({ enabled: $("enabled").checked }));
  $("mode").addEventListener("change", () => saveSettings({ mode: $("mode").value }));
  $("confidence").addEventListener("change", () => saveSettings({ confidenceThreshold: Number($("confidence").value) }));
  $("maxCalls").addEventListener("change", () => saveSettings({ maxCallsPerPage: Number($("maxCalls").value) }));
  $("indicator").addEventListener("change", () => saveSettings({ showIndicator: $("indicator").checked }));
  $("siteToggle").addEventListener("click", async () => {
    if (!activeHost) return;
    const hosts = new Set(appState.settings.allowedHosts);
    const isAdding = !hosts.has(activeHost);
    if (isAdding) hosts.add(activeHost); else hosts.delete(activeHost);
    await saveSettings({ allowedHosts: [...hosts] });
    if (isAdding) await tabMessage({ type: "RESTORE_ALL" });
  });
  $("undo").addEventListener("click", async () => {
    const result = await tabMessage({ type: "UNDO_LAST" });
    $("undo").textContent = result?.ok ? "Restored" : "Nothing to restore";
    setTimeout(() => $("undo").textContent = "Undo last removal", 1200);
  });
  $("restoreAll").addEventListener("click", async () => {
    const result = await tabMessage({ type: "RESTORE_ALL" });
    $("restoreAll").textContent = result?.restored ? `Restored ${result.restored}` : "Nothing hidden";
    setTimeout(() => $("restoreAll").textContent = "Restore this page", 1400);
  });
  $("exportLogs").addEventListener("click", async () => {
    const result = await bg({ type: "GET_DIAGNOSTICS" });
    if (!result?.ok) {
      $("diagnosticStatus").textContent = result?.error || "Could not export diagnostics.";
      return;
    }
    downloadJson(result.diagnostics);
    $("diagnosticStatus").textContent = `Downloaded ${result.diagnostics.entries.length} decision log${result.diagnostics.entries.length === 1 ? "" : "s"}.`;
  });
  $("rescan").addEventListener("click", async () => {
    await tabMessage({ type: "RESCAN" });
    $("rescan").textContent = "Scan started";
    setTimeout(() => $("rescan").textContent = "Scan page now", 1200);
  });
  $("clearLogs").addEventListener("click", async () => {
    await bg({ type: "CLEAR_DIAGNOSTICS" });
    $("diagnosticStatus").textContent = "Diagnostic history cleared.";
  });
  $("resetStats").addEventListener("click", async () => { await bg({ type: "RESET_STATS" }); await refresh(); });
  setInterval(refresh, 1500);
}

init().catch((error) => {
  $("statusLine").textContent = "Could not load extension state";
  $("lastError").hidden = false;
  $("lastError").textContent = error.message;
});
