/**
 * Nur anonymous product analytics (Supabase insert-only).
 * No cookies, no user ids, no prayer content. Fire-and-forget.
 */
(function (global) {
    'use strict';

    const ENDPOINT = 'https://qbyirkzdwzeetdugxyre.supabase.co/rest/v1/analytics_events';
    const ANON_KEY = 'sb_publishable_BgBlYMnxPhkWWEtbHNHzIg_h-RkMDda';

    const ALLOWED = new Set([
        'landing_cta_browser',
        'landing_cta_windows',
        'pwa_install',
        'tab_view',
        'prayer_logged',
        'sync_enabled',
        'settings_opened',
    ]);

    const lastSent = Object.create(null);
    const MIN_GAP_MS = 800;

    function sanitizeProps(props) {
        if (!props || typeof props !== 'object') return {};
        const out = {};
        for (const [k, v] of Object.entries(props)) {
            if (typeof k !== 'string' || k.length > 32) continue;
            if (typeof v === 'string' && v.length <= 64) out[k] = v;
            else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
            else if (typeof v === 'boolean') out[k] = v;
        }
        return out;
    }

    function track(eventName, props) {
        try {
            if (!ALLOWED.has(eventName)) return;
            if (typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/i.test(location.hostname)) return;

            const now = Date.now();
            if (lastSent[eventName] && now - lastSent[eventName] < MIN_GAP_MS) return;
            lastSent[eventName] = now;

            const body = JSON.stringify({
                event_name: eventName,
                props: sanitizeProps(props),
            });

            fetch(ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': ANON_KEY,
                    'Authorization': 'Bearer ' + ANON_KEY,
                    'Prefer': 'return=minimal',
                },
                body,
                keepalive: true,
                mode: 'cors',
                credentials: 'omit',
            }).catch(() => {});
        } catch (_) { /* never break the app for analytics */ }
    }

    global.NurAnalytics = { track };
})(typeof window !== 'undefined' ? window : globalThis);
