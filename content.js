(() => {
  if (window.top !== window || document.documentElement.dataset.jevFocusGuardLoaded) return;
  document.documentElement.dataset.jevFocusGuardLoaded = "true";

  const state = {
    settings: null,
    keyPresent: false,
    callsThisPage: 0,
    hidden: [],
    queue: [],
    queued: new WeakSet(),
    evaluated: new WeakMap(),
    running: false,
    observer: null,
    hud: null,
    hudTimer: null,
  };
  const AD_WORDS = new Set(["ad", "ads", "advert", "advertisement", "advertising", "adslot", "adunit", "sponsor", "sponsored", "promo", "promoted", "dfp", "prebid", "taboola", "outbrain", "mediavine", "raptive", "adthrive", "playwire", "primis", "conatix"]);
  const DISTRACTION_WORDS = new Set(["newsletter", "subscribe", "signup", "sign-up", "modal", "popup", "overlay", "floating", "floater", "sticky", "dock", "docked", "pip"]);
  const MEDIA_WORDS = new Set(["video", "player", "autoplay", "media", "vpaid", "vast"]);
  const MAX_PARALLEL_CLASSIFICATIONS = 4;

  function message(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response || { ok: false, error: "No response." });
      });
    });
  }

  function words(value) {
    return String(value || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean).slice(0, 40);
  }

  function hasAdToken(tokens) {
    return tokens.some((token) => AD_WORDS.has(token) || /^(?:ad|ads)(?:slot|unit|wrap|wrapper|container|banner|rail|box|zone|space|holder|placement|server)?$/.test(token));
  }

  function resourceHosts(element) {
    const hosts = [];
    const nodes = element.matches("iframe[src], video[src], source[src], embed[src]")
      ? [element]
      : [...element.querySelectorAll("iframe[src], video[src], source[src], embed[src]")].slice(0, 8);
    for (const node of nodes) {
      try {
        const host = new URL(node.getAttribute("src"), location.href).hostname;
        if (host && !hosts.includes(host)) hosts.push(host);
      } catch { /* ignore invalid resource URLs */ }
    }
    return hosts;
  }

  function visible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width >= 40 && rect.height >= 24 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
  }

  function localSignals(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const idTokens = words(element.id);
    const classTokens = words(element.className);
    const ariaTokens = words([
      element.getAttribute("aria-label"), element.getAttribute("title"),
      element.getAttribute("name"), element.getAttribute("data-testid"),
    ].filter(Boolean).join(" "));
    const attributeTokens = words([...element.attributes]
      .map((attribute) => attribute.name)
      .filter((name) => name.startsWith("data-") || name === "src")
      .join(" "));
    const allTokens = [...idTokens, ...classTokens, ...ariaTokens, ...attributeTokens];
    const signals = [];
    let score = 0;
    if (hasAdToken(allTokens)) { signals.push("ad_identity_token"); score += 4; }
    if (allTokens.some((token) => DISTRACTION_WORDS.has(token))) { signals.push("distraction_identity_token"); score += 2; }
    if (allTokens.some((token) => MEDIA_WORDS.has(token))) { signals.push("media_identity_token"); score += 1; }
    if (element.matches("[data-ad], [data-ad-slot], [data-ad-client], [data-google-query-id], [data-adunit], [data-ad-unit]")) {
      signals.push("ad_data_attribute"); score += 5;
    }

    const coverage = Math.min(1, (rect.width * rect.height) / Math.max(1, innerWidth * innerHeight));
    const fixed = style.position === "fixed";
    const sticky = style.position === "sticky";
    const zIndex = Number.parseInt(style.zIndex, 10) || 0;
    const horizontalEdgeGap = Math.max(32, Math.min(96, innerWidth * 0.06));
    const verticalEdgeGap = Math.max(32, Math.min(80, innerHeight * 0.07));
    const nearBottom = rect.bottom >= innerHeight - verticalEdgeGap && rect.top < innerHeight - 24;
    const nearSide = rect.right >= innerWidth - horizontalEdgeGap || rect.left <= horizontalEdgeGap;
    if (fixed || sticky) { signals.push(`${style.position}_position`); score += 2; }
    if ((fixed || sticky) && nearBottom) { signals.push("bottom_edge_overlay"); score += 2; }
    if ((fixed || sticky) && nearSide && rect.width < innerWidth * 0.65) { signals.push("side_edge_overlay"); score += 1; }
    if (fixed && coverage > 0.05) { signals.push("fixed_overlay_area"); score += 2; }
    if (fixed && coverage > 0.55) { signals.push("viewport_covering_overlay"); score += 4; }
    if (zIndex > 99) { signals.push("high_z_index"); score += 1; }

    const isDialog = element.matches("dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']");
    if (isDialog) { signals.push("modal_semantics"); score += 5; }
    const hasCloseControl = Boolean(element.querySelector("button[aria-label*='close' i], [role='button'][aria-label*='close' i], button[class*='close' i]"));
    if (hasCloseControl && (fixed || isDialog || zIndex > 99)) { signals.push("overlay_close_control"); score += 2; }

    const text = String(element.innerText || "").slice(0, 1200).toLowerCase();
    if (/\b(sponsored|advertisement|promoted|ad choices|learn more)\b/.test(text)) { signals.push("sponsorship_language"); score += 3; }
    if (/\b(newsletter|subscribe|sign up|join our|email(?: me)?|send (?:this|the) recipe|to your(?:self)?|your inbox|yes,? please|no thanks)\b/.test(text)) {
      signals.push("email_capture_language"); score += (fixed || isDialog || zIndex > 99) ? 4 : 1;
    }

    const resourceHostList = resourceHosts(element);
    if (resourceHostList.some((host) => /(^|\.)(doubleclick|googlesyndication|googleadservices|amazon-adsystem|adnxs|adsrvr|taboola|outbrain|mediavine|raptive|adthrive|playwire|primis|conatix)\./.test(host))) {
      signals.push("known_ad_resource_host"); score += 5;
    }
    const hasMedia = element.matches("video, iframe, embed, object") || Boolean(element.querySelector("video, iframe, embed, object"));
    const autoplay = element.matches("video[autoplay]") || Boolean(element.querySelector("video[autoplay]"));
    if (element.matches("iframe, embed, object")) { signals.push("embedded_content"); score += 2; }
    if (element.matches("iframe, embed, object") && rect.left > innerWidth * 0.55 && rect.width <= innerWidth * 0.45) {
      signals.push("right_rail_embedded_content"); score += 2;
    }
    if (autoplay) { signals.push("autoplay_media"); score += 3; }
    if (hasMedia && (fixed || sticky) && nearSide && coverage >= 0.025 && coverage <= 0.45) {
      signals.push("floating_sticky_media_player"); score += 5;
    }
    if (element.tagName === "ASIDE") { signals.push("aside_container"); score += 1; }

    const commonAdSize = [[300, 250], [300, 600], [320, 50], [320, 100], [336, 280], [728, 90], [970, 90], [970, 250]]
      .some(([width, height]) => Math.abs(rect.width - width) <= 28 && Math.abs(rect.height - height) <= 28);
    if (commonAdSize) { signals.push("common_ad_dimensions"); score += 2; }

    return { score, style, rect, coverage, idTokens, classTokens, ariaTokens, resourceHostList, signals };
  }

  function primaryContentSignals(element, info) {
    const signals = [];
    const position = info.style.position;
    const inFlow = !["fixed", "sticky", "absolute"].includes(position);
    const textLength = String(element.innerText || "").length;
    const paragraphCount = element.querySelectorAll("p").length;
    const headingCount = element.querySelectorAll("h1, h2, h3").length;
    const itemType = String(element.getAttribute("itemtype") || "").toLowerCase();
    const semanticRoot = element.matches("main, article, [role='main'], [itemprop='recipeInstructions']");
    const recipeSchema = itemType.includes("recipe") || element.getAttribute("itemprop") === "recipeInstructions";
    const containsPrimaryRoot = inFlow && Boolean(element.querySelector("main, article, [role='main'], [itemprop='recipeInstructions']"));
    const richDocumentSection = inFlow && info.coverage >= 0.18 && textLength >= 700 && (paragraphCount >= 3 || headingCount >= 2);
    if (semanticRoot) signals.push("semantic_primary_content");
    if (recipeSchema) signals.push("recipe_schema_content");
    if (containsPrimaryRoot) signals.push("contains_primary_content_root");
    if (richDocumentSection) signals.push("substantial_in_flow_content");
    return signals;
  }

  function describe(element, info) {
    const linkHosts = [];
    const links = element.matches("a[href]") ? [element] : [...element.querySelectorAll("a[href]")].slice(0, 8);
    for (const link of links) {
      try {
        const host = new URL(link.href).hostname;
        if (host && !linkHosts.includes(host)) linkHosts.push(host);
      } catch { /* ignore invalid page links */ }
    }
    return {
      pageHost: location.hostname,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || "",
      idTokens: info.idTokens,
      classTokens: info.classTokens,
      ariaTokens: info.ariaTokens,
      width: Math.round(info.rect.width),
      height: Math.round(info.rect.height),
      viewportCoverage: Number(info.coverage.toFixed(3)),
      position: info.style.position,
      zIndex: Number.parseInt(info.style.zIndex, 10) || 0,
      linkHosts,
      resourceHosts: info.resourceHostList,
      signals: info.signals,
      protectionSignals: primaryContentSignals(element, info),
      textLength: String(element.innerText || "").length,
    };
  }

  if (globalThis.__JEVFG_TEST_MODE__) {
    globalThis.__JEVFG_TEST_HOOKS__ = { localSignals, primaryContentSignals, describe };
    return;
  }

  function showHud(kind, text) {
    if (!state.settings?.showIndicator) return;
    if (!state.hud) {
      state.hud = document.createElement("div");
      state.hud.id = "jev-focus-guard-hud";
      state.hud.setAttribute("role", "status");
      state.hud.setAttribute("aria-live", "polite");
      document.documentElement.appendChild(state.hud);
    }
    clearTimeout(state.hudTimer);
    state.hud.className = kind;
    state.hud.textContent = text;
    if (kind !== "calling") {
      state.hudTimer = setTimeout(() => state.hud?.classList.add("jevfg-fade"), 1800);
    }
  }

  function hideElement(element, result) {
    const record = {
      element,
      style: element.getAttribute("style"),
      ariaHidden: element.getAttribute("aria-hidden"),
      requestId: result.requestId,
    };
    state.hidden.push(record);
    element.dataset.jevfgState = "hidden";
    element.style.setProperty("display", "none", "important");
    element.setAttribute("aria-hidden", "true");
    message({ type: "RECORD_REMOVED", requestId: result.requestId });
    showHud("removed", `Jev removed ${result.choice === "remove_ad" ? "an ad" : "a distraction"} · ${Math.round(result.confidence * 100)}% · call #${result.callNumber}`);
  }

  function restoreLast() {
    const record = state.hidden.pop();
    if (!record?.element?.isConnected) return false;
    if (record.style === null) record.element.removeAttribute("style");
    else record.element.setAttribute("style", record.style);
    if (record.ariaHidden === null) record.element.removeAttribute("aria-hidden");
    else record.element.setAttribute("aria-hidden", record.ariaHidden);
    record.element.dataset.jevfgState = "restored";
    message({ type: "RECORD_ACTION", requestId: record.requestId, action: "restored_by_user" });
    showHud("kept", "Restored the last hidden element");
    return true;
  }

  function restoreAll() {
    let restored = 0;
    while (state.hidden.length) if (restoreLast()) restored += 1;
    return restored;
  }

  function descriptorSignature(descriptor) {
    return JSON.stringify([
      descriptor.width, descriptor.height, descriptor.position, descriptor.zIndex,
      descriptor.signals, descriptor.resourceHosts,
    ]);
  }

  function enqueue(element, deferRun = false) {
    if (state.queued.has(element) || element.closest("#jev-focus-guard-hud")) return;
    if (!visible(element) || element.dataset.jevfgState === "hidden" || element.dataset.jevfgState === "calling") return;
    const info = localSignals(element);
    if (info.score < 2) return;
    const descriptor = describe(element, info);
    const signature = descriptorSignature(descriptor);
    if (state.evaluated.get(element) === signature) return;
    if (descriptor.protectionSignals.length) {
      state.evaluated.set(element, signature);
      element.dataset.jevfgState = "protected";
      return;
    }
    state.queued.add(element);
    element.dataset.jevfgState = "queued";
    state.queue.push({ element, descriptor, signature, priority: info.score });
    state.queue.sort((a, b) => b.priority - a.priority);
    if (!deferRun) runQueue();
  }

  async function classifyNext() {
    while (state.queue.length) {
      const item = state.queue.shift();
      state.queued.delete(item.element);
      if (!item.element.isConnected || !visible(item.element)) continue;
      if (!state.settings?.enabled || !state.keyPresent || state.settings.allowedHosts?.includes(location.hostname)) return;
      if (state.callsThisPage >= state.settings.maxCallsPerPage) {
        item.element.dataset.jevfgState = "limit";
        showHud("kept", `Jev call limit reached (${state.settings.maxCallsPerPage})`);
        return;
      }
      const reservedCalls = Math.min(5, Math.max(1, Math.floor(state.settings.maxCallsPerPage / 5)));
      if (item.priority < 4 && state.callsThisPage >= state.settings.maxCallsPerPage - reservedCalls) {
        item.element.dataset.jevfgState = "deferred";
        continue;
      }
      state.callsThisPage += 1;
      item.element.dataset.jevfgState = "calling";
      showHud("calling", `Calling Jev · up to ${MAX_PARALLEL_CLASSIFICATIONS} at once · decision ${state.callsThisPage}`);
      const result = await message({ type: "CLASSIFY", candidate: item.descriptor });
      if (!result?.ok) {
        item.element.dataset.jevfgState = "error";
        showHud("error", result?.error || "Jev call failed");
        if (result?.needsKey) return;
      } else if (result.shouldRemove) {
        state.evaluated.set(item.element, item.signature);
        const currentInfo = localSignals(item.element);
        const protections = primaryContentSignals(item.element, currentInfo);
        if (protections.length) {
          item.element.dataset.jevfgState = "protected";
          message({ type: "RECORD_ACTION", requestId: result.requestId, action: "protected_primary_content", protections });
          showHud("kept", `Protected primary content · call #${result.callNumber}`);
        } else {
          hideElement(item.element, result);
        }
      } else {
        state.evaluated.set(item.element, item.signature);
        item.element.dataset.jevfgState = "kept";
        showHud("kept", `Jev kept it · ${Math.round(result.confidence * 100)}% · call #${result.callNumber}`);
      }
    }
  }

  async function runQueue() {
    if (state.running) return;
    state.running = true;
    try {
      await Promise.all(Array.from(
        { length: MAX_PARALLEL_CLASSIFICATIONS },
        () => classifyNext(),
      ));
    } finally {
      state.running = false;
      if (state.queue.length) runQueue();
    }
  }

  function scan(root = document) {
    if (!state.settings?.enabled || !state.keyPresent || state.settings.allowedHosts?.includes(location.hostname)) return;
    const selector = [
      "iframe", "aside", "dialog", "video", "embed", "object",
      "[role='dialog']", "[role='alertdialog']", "[aria-modal='true']", "[aria-label]",
      "[data-ad]", "[data-ad-slot]", "[data-ad-client]", "[data-google-query-id]",
      "[id]", "[class]", "[style*='fixed' i]", "[style*='sticky' i]",
    ].join(",");
    const elements = root instanceof Element && root.matches(selector)
      ? [root, ...root.querySelectorAll(selector)]
      : [...root.querySelectorAll(selector)];
    for (const element of elements.slice(0, 1400)) enqueue(element, true);
    runQueue();
  }

  function startObserver() {
    state.observer?.disconnect();
    state.observer = new MutationObserver((mutations) => {
      const roots = [];
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          roots.push(mutation.target);
          if (mutation.target.parentElement) roots.push(mutation.target.parentElement);
        }
        for (const node of mutation.addedNodes || []) if (node instanceof Element) roots.push(node);
      }
      if (!roots.length) return;
      clearTimeout(startObserver.scanTimer);
      startObserver.scanTimer = setTimeout(() => roots.slice(0, 60).forEach(scan), 250);
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "aria-modal", "role", "src"],
    });
    // Catch players that become floating through stylesheet/media-query changes without a DOM mutation.
    clearInterval(startObserver.periodicTimer);
    let passes = 0;
    startObserver.periodicTimer = setInterval(() => {
      if (++passes > 20) return clearInterval(startObserver.periodicTimer);
      scan();
    }, 3000);
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      if (request?.type === "UNDO_LAST") {
        sendResponse({ ok: restoreLast() });
      } else if (request?.type === "RESTORE_ALL") {
        sendResponse({ ok: true, restored: restoreAll() });
      } else if (request?.type === "RESCAN") {
        const response = await message({ type: "GET_STATE" });
        if (response.ok) {
          state.settings = response.settings;
          state.keyPresent = response.keyPresent;
        }
        scan();
        runQueue();
        sendResponse({ ok: true });
      } else if (request?.type === "SETTINGS_CHANGED") {
        state.settings = request.settings;
        if (state.settings.enabled) scan();
        sendResponse({ ok: true });
      } else if (request?.type === "GET_PAGE_STATE") {
        sendResponse({ ok: true, hiddenCount: state.hidden.length, callsThisPage: state.callsThisPage });
      }
    })();
    return true;
  });

  (async () => {
    const response = await message({ type: "GET_STATE" });
    if (!response.ok) return;
    state.settings = response.settings;
    state.keyPresent = response.keyPresent;
    startObserver();
    if (state.keyPresent) setTimeout(() => scan(), 700);
  })();
})();
