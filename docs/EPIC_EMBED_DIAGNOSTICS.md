# Epic Embed Diagnostics

Runtime probes to run when the React app boots **inside Epic** (Hyperdrive / legacy Hyperspace). Feed the returned objects into your in-app console inspector.

Two entry points:
- `collectEmbedDiagnostics()` — **passive**. Safe on mount. No permission prompt, no `getUserMedia`.
- `probeMicrophone()` — **active**. Calls `getUserMedia` (may prompt). Gate behind a button.

Nothing throws to the caller; every field is wrapped so one failed check never kills the rest of the report.

## What it checks

- **Framing** — iframe vs top-level embedded window, parent origin chain (`ancestorOrigins`), `frameElement.allow` when same-origin.
- **Host engine** — WebView2 vs CEF vs plain Chromium, plus any Epic/speech bridges injected on `window`.
- **Permissions policy** — whether `microphone` is even allowed in this browsing context (`document.featurePolicy.allowsFeature('microphone')`). If this is false, `getUserMedia` always fails with `NotAllowedError`.
- **Secure context** — HTTPS check; `navigator.mediaDevices` presence.
- **Devices** — mic permission state + enumerable audio inputs (passive, no prompt).
- **Mic probe** — actual `getUserMedia` call; `error.name` is the diagnostic payload.

## error.name mapping (mic probe)

| error.name | Meaning |
|---|---|
| `NotAllowedError` | Blocked by policy / host / user (the Epic-blocked case) |
| `NotFoundError` | No mic device visible to the context |
| `NotReadableError` | Device busy / hardware / OS-level |
| `SecurityError` | Insecure context or policy violation |
| `AbortError` | Other failure |

## Code

```typescript
/**
 * epicEmbedDiagnostics.ts
 *
 * Runtime probes to run when the React app boots INSIDE Epic (Hyperdrive / legacy Hyperspace).
 * Feed the returned objects into your in-app console inspector.
 *
 * Two entry points:
 *   collectEmbedDiagnostics()  -> PASSIVE. Safe on mount. No permission prompt. No getUserMedia.
 *   probeMicrophone()          -> ACTIVE.  Calls getUserMedia (MAY prompt). Gate behind a button.
 *
 * Nothing here throws to the caller; every field is wrapped so one failed check
 * never kills the rest of the report.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Safe<T> = T | { error: string };

function safe<T>(fn: () => T): Safe<T> {
  try {
    return fn();
  } catch (e: any) {
    return { error: e?.name ? `${e.name}: ${e.message}` : String(e) };
  }
}

async function safeAsync<T>(fn: () => Promise<T>): Promise<Safe<T>> {
  try {
    return await fn();
  } catch (e: any) {
    return { error: e?.name ? `${e.name}: ${e.message}` : String(e) };
  }
}

// ---------------------------------------------------------------------------
// 1. FRAMING — iframe vs top-level embedded window, and the parent chain
// ---------------------------------------------------------------------------
export function getFramingInfo() {
  const w = window as any;

  // Reference comparison is always allowed (won't throw even cross-origin).
  const isFramed = safe(() => window.self !== window.top);

  // frameElement: readable ONLY if the parent frame is same-origin.
  //  - element returned -> same-origin iframe: you can read its `allow`/`sandbox`.
  //  - throws SecurityError / null while framed -> CROSS-ORIGIN iframe (the Epic case).
  const frameElement = safe(() => {
    const el = window.frameElement as HTMLElement | null;
    if (!el) return null;
    return {
      tagName: el.tagName,
      id: el.id || null,
      name: (el as any).name || null,
      allow: el.getAttribute('allow'),        // <-- look for "microphone" here
      sandbox: el.getAttribute('sandbox'),
      src: el.getAttribute('src'),
    };
  });

  // ancestorOrigins: Chromium-only (Hyperdrive is Chromium). Gives the parent
  // origin chain even cross-origin — this is how you learn Epic's frame origin.
  const ancestorOrigins = safe(() => {
    const ao = (window.location as any).ancestorOrigins;
    return ao ? Array.from(ao as ArrayLike<string>) : null;
  });

  return {
    isFramed,
    // If cross-origin iframe, frameElement will be an error/null but isFramed=true.
    framingKind:
      isFramed === false
        ? 'TOP_LEVEL (embedded window or standalone)'
        : (frameElement && !(frameElement as any).error)
        ? 'SAME_ORIGIN_IFRAME'
        : 'CROSS_ORIGIN_IFRAME (or blocked frameElement access)',
    frameElement,
    ancestorOrigins,
    nestingDepth: Array.isArray(ancestorOrigins) ? ancestorOrigins.length : null,
    referrer: safe(() => document.referrer || null),
    windowName: safe(() => window.name || null),
    topAccessible: safe(() => {
      // If cross-origin, reading top.location.href throws — a quick isolation check.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      (window.top as any).location.href;
      return true;
    }),
  };
}

// ---------------------------------------------------------------------------
// 2. HOST ENGINE — WebView2 vs CEF vs plain Chromium, Epic-injected bridges
// ---------------------------------------------------------------------------
export function getHostInfo() {
  const w = window as any;

  // Scan globals that reveal the embedding shell / injected native bridges.
  const globalSignals = safe(() => {
    const patterns = /epic|hyper|cef|webview|chrome\.?webview|dragon|nuance|subspace|fhircast/i;
    const hits: string[] = [];
    for (const k of Object.keys(w)) {
      if (patterns.test(k)) hits.push(k);
    }
    return hits;
  });

  return {
    userAgent: safe(() => navigator.userAgent),
    // WebView2 host (Edge/Chromium) injects window.chrome.webview
    isWebView2: safe(() => !!(w.chrome && w.chrome.webview)),
    // CEF host commonly exposes cefQuery / CefSharp
    isCEF: safe(() => !!(w.cefQuery || w.CefSharp || w.cef)),
    uaData: safe(() => {
      const ua = (navigator as any).userAgentData;
      if (!ua) return null;
      return {
        brands: ua.brands,
        mobile: ua.mobile,
        platform: ua.platform,
      };
    }),
    injectedGlobals: globalSignals, // e.g. Epic / Hyperdrive / speech bridges present on window
  };
}

// ---------------------------------------------------------------------------
// 3. PERMISSIONS POLICY — is 'microphone' even allowed in THIS browsing context?
//    (If policy blocks it, getUserMedia fails with NotAllowedError no matter what.)
// ---------------------------------------------------------------------------
export function getPermissionsPolicyInfo() {
  return {
    // document.featurePolicy is deprecated but still implemented in Chromium/Hyperdrive.
    micAllowedByPolicy: safe(() =>
      (document as any).featurePolicy?.allowsFeature('microphone') ?? null
    ),
    cameraAllowedByPolicy: safe(() =>
      (document as any).featurePolicy?.allowsFeature('camera') ?? null
    ),
    allowedFeaturesSample: safe(() => {
      const fp = (document as any).featurePolicy;
      if (!fp?.allowedFeatures) return null;
      const feats: string[] = fp.allowedFeatures();
      return feats.filter((f) => /microphone|camera|display-capture/.test(f));
    }),
    // Newer spec surface (thin support) — reported if present.
    permissionsPolicyPresent: safe(() => !!(document as any).permissionsPolicy),
  };
}

// ---------------------------------------------------------------------------
// 4. SECURE CONTEXT — getUserMedia requires HTTPS; otherwise mediaDevices is undefined
// ---------------------------------------------------------------------------
export function getSecureContextInfo() {
  return {
    isSecureContext: safe(() => window.isSecureContext),
    protocol: safe(() => window.location.protocol),
    origin: safe(() => window.location.origin),
    href: safe(() => window.location.href),
    crossOriginIsolated: safe(() => (window as any).crossOriginIsolated ?? null),
    mediaDevicesPresent: safe(() => !!navigator.mediaDevices),
    getUserMediaPresent: safe(() => !!navigator.mediaDevices?.getUserMedia),
  };
}

// ---------------------------------------------------------------------------
// 5. DEVICES + PERMISSION STATE — passive, no prompt
//    Before permission is granted, device labels are empty but you can still
//    see whether audioinput hardware is enumerable and the current perm state.
// ---------------------------------------------------------------------------
export async function getDeviceInfo() {
  const permissionState = await safeAsync(async () => {
    const status = await (navigator as any).permissions?.query({ name: 'microphone' as any });
    return status ? status.state : 'permissions-api-unsupported';
  });

  const devices = await safeAsync(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return 'enumerateDevices-unsupported';
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.map((d) => ({
      kind: d.kind,
      hasLabel: !!d.label,          // false until permission granted
      hasDeviceId: !!d.deviceId,    // often empty until granted
      groupId: d.groupId || null,
    }));
  });

  const audioInputCount = Array.isArray(devices)
    ? devices.filter((d: any) => d.kind === 'audioinput').length
    : null;

  return { permissionState, audioInputCount, devices };
}

// ---------------------------------------------------------------------------
// PASSIVE AGGREGATE — call this on mount / launch. No prompt.
// ---------------------------------------------------------------------------
export async function collectEmbedDiagnostics() {
  const report = {
    timestamp: new Date().toISOString(),
    framing: getFramingInfo(),
    host: getHostInfo(),
    permissionsPolicy: getPermissionsPolicyInfo(),
    secureContext: getSecureContextInfo(),
    devices: await getDeviceInfo(),
  };
  // Dump to your inspector however it consumes objects:
  // eslint-disable-next-line no-console
  console.log('[EPIC-EMBED-DIAG]', report);
  return report;
}

// ---------------------------------------------------------------------------
// ACTIVE MIC PROBE — CALLS getUserMedia. May show a prompt. GATE BEHIND A BUTTON.
//   error.name is the diagnostic payload:
//     NotAllowedError  -> blocked by policy / host / user (the Epic-blocked case)
//     NotFoundError    -> no mic device visible to the context
//     NotReadableError -> device busy / hardware / OS-level
//     SecurityError    -> insecure context or policy violation
//     AbortError       -> other failure
// ---------------------------------------------------------------------------
export async function probeMicrophone() {
  const started = performance.now();
  const result = await safeAsync(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('navigator.mediaDevices.getUserMedia is undefined (likely insecure context)');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tracks = stream.getAudioTracks();
    const trackInfo = tracks.map((t) => ({
      label: t.label,
      enabled: t.enabled,
      muted: t.muted,
      readyState: t.readyState,
      settings: t.getSettings(), // sampleRate, channelCount, echoCancellation, etc.
    }));

    // Labels are now populated post-grant — re-enumerate to confirm.
    const devicesAfterGrant = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ label: d.label, deviceId: d.deviceId ? '(present)' : '(empty)' }));

    // Release the mic immediately.
    tracks.forEach((t) => t.stop());

    return { granted: true, trackInfo, devicesAfterGrant };
  });

  const payload = {
    timestamp: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - started),
    ...(typeof result === 'object' && 'error' in (result as any)
      ? { granted: false, failure: (result as any).error }
      : (result as any)),
  };
  // eslint-disable-next-line no-console
  console.log('[EPIC-MIC-PROBE]', payload);
  return payload;
}
```

## Wiring

- Call `collectEmbedDiagnostics()` in a `useEffect` on root mount (passive, no prompt).
- Bind `probeMicrophone()` to a button in your inspector panel — don't auto-run it.
- Run it in the **actual Hyperdrive client at the customer site**, not just the Web Developer Test Harness — the real permission grant depends on that org's Hyperdrive config, so results can differ between harness and production.
