# Jev Focus Guard

A local, unpacked Chrome extension that asks **Jev (System One)** whether likely page elements are ads or distractions, then hides only the elements Jev confidently marks for removal.

This is designed for personal developer-mode installation. It does **not** require Chrome Web Store review.

## Install in Chrome

1. Unzip the download to a permanent folder on your computer.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** in the top-right corner.
4. Click **Load unpacked**.
5. Select the unzipped `jev-focus-guard` folder (the folder containing `manifest.json`).
6. Pin **Jev Focus Guard** from Chrome's extensions menu.
7. Open the extension, paste your Jev API key, and click **Connect**.
8. Reload an open webpage or click **Scan page now**.

The key is stored only in Chrome's session-only extension storage. It is cleared when Chrome exits, never synced, and never inserted into a webpage. You will need to reconnect after restarting Chrome.

Chrome does not allow extensions to modify internal pages such as `chrome://…` or the Chrome Web Store.

## What it does

- Locally shortlists likely ad or distraction containers using DOM structure and layout signals.
- Specifically detects sticky bottom banners, side-rail ad frames, viewport-dimming modals, email/newsletter capture popups, and floating or sticky video players.
- Rechecks dynamic elements when their class, style, role, source, or modal state changes, plus periodic rescans during the first minute after page load.
- Prioritizes strong candidates and reserves part of the per-page call budget for ads or overlays injected later.
- Classifies up to four candidates in parallel, with a bounded queue so pages clear faster without an unbounded API burst.
- Sends a privacy-reduced element descriptor to Jev.
- Protects semantic recipe/article/main content and substantial in-flow reading sections even if they contain ad-like class names.
- Hides the element only when Jev returns an allowed removal decision above your confidence threshold and the local primary-content safety check still passes.
- Shows a flashing on-page indicator while a Jev request is running.
- Tracks total Jev API calls, removals, failures, the last decision, confidence, model, and latency.
- Lets you undo the most recent removal, restore everything hidden on the current page, allowlist the site, pause globally, and rescan.
- Keeps the latest 150 privacy-reduced decision records locally and exports them as a JSON diagnostic file.
- Stops automatic calls at a configurable per-page limit (30 by default).
- Pauses on an HTTP 429 response instead of retrying automatically.

## Important limitation

This is an AI-powered **DOM hider**, not a filter-list network blocker. A candidate element may load before Jev classifies and hides it. That trade-off is intentional: Jev makes the final decision rather than a static blocklist. The extension is conservative by default, but AI decisions can still be wrong; use **Undo last removal** or **Allow this site** when needed.

## Data sent to Jev

Each call uses:

```json
{
  "model": "jev-latest",
  "state": {
    "purpose": "browser_element_triage",
    "privacy_note": "No page text, cookies, form values, or full URL are included.",
    "blocking_mode": "ads_and_distractions",
    "page": { "hostname": "example.com" },
    "candidate": {
      "tag": "aside",
      "role": "",
      "id_tokens": ["sponsored", "rail"],
      "class_tokens": ["promo", "sticky"],
      "aria_tokens": [],
      "geometry": {
        "width_px": 300,
        "height_px": 600,
        "viewport_coverage": 0.18,
        "css_position": "sticky",
        "z_index": 10
      },
      "outbound_link_hosts": ["advertiser.example"],
      "embedded_resource_hosts": ["securepubads.g.doubleclick.net"],
      "detected_signals": ["ad_identity_token", "sticky_position"],
      "primary_content_protections": [],
      "text_length": 120
    }
  },
  "questions": {
    "disposition": {
      "type": "choice",
      "instructions": "Classify this browser element conservatively…",
      "criteria": {
        "remove_ad": "Paid advertisement, sponsored placement, affiliate promotion, or ad container.",
        "remove_distraction": "Non-essential newsletter/signup overlay, autoplay floating media, sticky promotion, or attention-grabbing interruption.",
        "keep": "Primary content, navigation, utility, user-requested media, safety/consent control, commerce control, or ambiguous element."
      }
    }
  }
}
```

The values above are an illustrative shape, not captured browsing data. The actual extension sends the current hostname, structural metadata, and hostnames used by embedded frames/media or outbound links. It does not send page text, cookies, form values, query strings, fragments, or the full page URL.

## Jev response and decision policy

The extension expects:

```json
{
  "model": "…",
  "answers": {
    "disposition": {
      "type": "choice",
      "choice": "remove_ad | remove_distraction | keep",
      "confidence": 0.0
    }
  }
}
```

- **Ads + distractions:** allows `remove_ad` and `remove_distraction` above the selected threshold.
- **Ads only:** allows only `remove_ad` above the selected threshold.
- **Balanced default:** 72% confidence.
- Anything malformed, ambiguous, below threshold, or failed stays visible.

## Controls

- **Main switch:** pause or enable globally.
- **Blocking mode:** ads only, or ads plus non-essential attention traps.
- **Confidence:** aggressive (60%), balanced (72%), or conservative (85%).
- **Calls per page:** 10, 20, 30, or 50.
- **Allow this site:** adds the current hostname to a local allowlist.
- **Undo last removal:** restores the most recently hidden element on the current page.
- **Restore this page:** restores every element the extension hid in the current tab, without allowlisting the site.
- **Export diagnostics:** downloads a JSON file containing the latest 150 Jev decisions and outcomes.
- **Scan page now:** asks the current tab to rescan.
- **Forget API key:** clears it immediately from session storage.
- **Clear diagnostics:** deletes the locally saved decision history.
- **Reset stats:** resets lifetime counters saved by the extension.

## Reporting a wrong removal

1. Click **Restore this page** so you can continue using the page.
2. Leave the affected tab open and click **Export diagnostics** in the extension popup.
3. Upload the downloaded `jev-focus-guard-…json` file with a screenshot and the site name.

Logs start only after this version is installed; the extension cannot recover decisions made by an older version. The export never includes the API key, cookies, form values, page text, or full URLs. It includes the page hostname, structural element metadata, local signals, Jev's choice/confidence/model, latency, policy settings, and whether the element was hidden, kept, protected, or restored.

## Source and license

The unzipped folder is the complete source; no build step or dependencies are required. The public repository is [tx-smitht/jev-focus-guard](https://github.com/tx-smitht/jev-focus-guard).

Jev Focus Guard is available under the MIT License. Never commit an API key; this package contains none.

## Updating the local extension

After changing or replacing files, return to `chrome://extensions` and click the extension's **Reload** button. Existing tabs may also need a reload.

## Troubleshooting

- **“API key needed”** — reconnect from the popup; session storage clears when Chrome exits.
- **No change on a page** — reload the tab after first install, verify the global switch is on, and click **Scan page now**.
- **Calls stop** — check the per-page limit and the error under **Last Jev decision**.
- **A site breaks** — click **Restore this page**, export diagnostics, then allowlist the site if you want blocking off there.
- **Rate limited** — the extension pauses automatically and does not retry. Re-enable it later when the provider limit has cleared.

## Security notes

The extension requests access to normal HTTP/HTTPS pages so its content script can inspect candidate element structure. It requests network access only to `https://api.typesafe.ai/*`. The service worker validates and reduces candidate descriptors before sending them. Page scripts cannot read the API key from extension session storage.

Review the source before loading it, as you should with any unpacked extension.
