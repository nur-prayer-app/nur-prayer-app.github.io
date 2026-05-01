/* ================================================================
   Sync — Supabase Auth + Cloud Sync
   ================================================================
   Sits on top of Storage. Local is always source of truth.
   Cloud is a mirror with per-key timestamps for merge.
   Session/sync metadata lives in localStorage directly (not in
   Storage.KEYS) because it's browser-specific, not user data.
   ================================================================ */

(function () {
    'use strict';

    const SUPABASE_URL = 'https://qbyirkzdwzeetdugxyre.supabase.co';
    const SUPABASE_KEY = 'sb_publishable_BgBlYMnxPhkWWEtbHNHzIg_h-RkMDda';
    const AUTH_URL = `${SUPABASE_URL}/auth/v1`;
    const REST_URL = `${SUPABASE_URL}/rest/v1`;
    const SESSION_KEY = 'nur-sync-session';
    const LAST_SYNC_KEY = 'nur-last-sync';
    const SYNC_INTERVAL = 5 * 60 * 1000;

    let syncTimer = null;
    let cachedSession = null;
    let lastPushSnapshot = null;

    /* ─── Helpers ───────────────────────────────────────────────── */

    function headers(token) {
        const h = {
            'apikey': SUPABASE_KEY,
            'Content-Type': 'application/json',
        };
        if (token) h['Authorization'] = `Bearer ${token}`;
        return h;
    }

    function getSession() {
        if (cachedSession) return cachedSession;
        try {
            cachedSession = JSON.parse(localStorage.getItem(SESSION_KEY));
            return cachedSession;
        } catch { return null; }
    }

    function saveSession(session) {
        cachedSession = session;
        if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else localStorage.removeItem(SESSION_KEY);
    }

    function getLastSync() {
        return localStorage.getItem(LAST_SYNC_KEY);
    }

    function setLastSync() {
        const ts = new Date().toISOString();
        localStorage.setItem(LAST_SYNC_KEY, ts);
        return ts;
    }

    /* ─── Token refresh ────────────────────────────────────────── */

    async function refreshToken() {
        const session = getSession();
        if (!session?.refresh_token) return null;

        const resp = await fetch(`${AUTH_URL}/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ refresh_token: session.refresh_token }),
        });
        if (!resp.ok) {
            saveSession(null);
            return null;
        }
        const data = await resp.json();
        const newSession = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            user: data.user,
        };
        saveSession(newSession);
        return newSession;
    }

    async function getValidToken() {
        let session = getSession();
        if (!session?.access_token) return null;

        try {
            const payload = JSON.parse(atob(session.access_token.split('.')[1]));
            const expiresAt = payload.exp * 1000;
            if (Date.now() > expiresAt - 60000) {
                session = await refreshToken();
            }
        } catch {
            session = await refreshToken();
        }
        return session?.access_token || null;
    }

    /* ─── Auth ─────────────────────────────────────────────────── */

    async function signUp(email, password) {
        const resp = await fetch(`${AUTH_URL}/signup`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ email, password }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error_description || data.msg || 'Sign-up failed');
        if (data.access_token) {
            saveSession({
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                user: data.user,
            });
            startAutoSync();
        }
        return data;
    }

    async function signIn(email, password) {
        const resp = await fetch(`${AUTH_URL}/token?grant_type=password`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ email, password }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error_description || data.msg || 'Sign-in failed');
        saveSession({
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            user: data.user,
        });
        await pullFromCloud();
        startAutoSync();
        return data;
    }

    function signInWithGoogle() {
        const redirectTo = window.electronAPI
            ? 'https://nur-prayer-app.github.io/releases/auth-callback.html'
            : window.location.origin + window.location.pathname;
        const url = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
        if (window.electronAPI?.openExternal) {
            window.electronAPI.openExternal(url);
        } else {
            window.location.href = url;
        }
    }

    async function handleOAuthTokens(accessToken, refreshToken) {
        const payload = JSON.parse(atob(accessToken.split('.')[1]));
        saveSession({
            access_token: accessToken,
            refresh_token: refreshToken,
            user: { id: payload.sub, email: payload.email },
        });
        startAutoSync();
        try { await pullFromCloud(); } catch (e) { console.warn('OAuth pull failed:', e); }
    }

    if (window.electronAPI?.onOAuthCallback) {
        window.electronAPI.onOAuthCallback(async (url) => {
            try {
                const fragment = url.split('#')[1];
                if (!fragment) return;
                const params = new URLSearchParams(fragment);
                const accessToken = params.get('access_token');
                const refreshToken = params.get('refresh_token');
                if (accessToken && refreshToken) {
                    await handleOAuthTokens(accessToken, refreshToken);
                    window.dispatchEvent(new Event('sync-auth-changed'));
                }
            } catch (e) { console.warn('OAuth callback error:', e); }
        });
    }

    if (!window.electronAPI && window.location.hash) {
        try {
            const params = new URLSearchParams(window.location.hash.substring(1));
            const accessToken = params.get('access_token');
            const refreshToken = params.get('refresh_token');
            if (accessToken && refreshToken) {
                handleOAuthTokens(accessToken, refreshToken);
                history.replaceState(null, '', window.location.pathname);
            }
        } catch (e) { console.warn('Web OAuth parse error:', e); }
    }

    async function resetPassword(email) {
        const resp = await fetch(`${AUTH_URL}/recover`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ email }),
        });
        if (!resp.ok) {
            const data = await resp.json();
            throw new Error(data.error_description || data.msg || 'Reset failed');
        }
    }

    async function signOut() {
        const token = await getValidToken();
        if (token) {
            await fetch(`${AUTH_URL}/logout`, {
                method: 'POST',
                headers: headers(token),
            }).catch(() => {});
        }
        saveSession(null);
        localStorage.removeItem(LAST_SYNC_KEY);
        stopAutoSync();
    }

    /* ─── Sync: push ───────────────────────────────────────────── */

    function buildCloudPayload() {
        const snapshot = Storage.exportAll();
        const now = Date.now();
        const payload = {};
        for (const [key, raw] of Object.entries(snapshot)) {
            let value = raw;
            try { value = JSON.parse(raw); } catch {}
            payload[key] = { value, _ts: now };
        }
        return payload;
    }

    async function pushToCloud(force) {
        const token = await getValidToken();
        if (!token) return;
        const session = getSession();

        const snapshot = JSON.stringify(Storage.exportAll());
        if (!force && snapshot === lastPushSnapshot) return;

        const payload = buildCloudPayload();
        const resp = await fetch(`${REST_URL}/user_data?on_conflict=user_id`, {
            method: 'POST',
            headers: {
                ...headers(token),
                'Prefer': 'resolution=merge-duplicates',
            },
            body: JSON.stringify({
                user_id: session.user.id,
                data: payload,
                updated_at: new Date().toISOString(),
            }),
        });
        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`Push failed: ${err}`);
        }
        lastPushSnapshot = snapshot;
        return setLastSync();
    }

    /* ─── Sync: pull + merge ───────────────────────────────────── */

    async function pullFromCloud() {
        const token = await getValidToken();
        if (!token) return;
        const session = getSession();

        const resp = await fetch(
            `${REST_URL}/user_data?user_id=eq.${session.user.id}&select=data`,
            { headers: headers(token) }
        );
        if (!resp.ok) return;
        const rows = await resp.json();
        if (!rows.length || !rows[0].data) return;

        const cloudData = rows[0].data;
        const localSnapshot = Storage.exportAll();
        const lastSyncTs = getLastSync();
        const lastSyncMs = lastSyncTs ? new Date(lastSyncTs).getTime() : 0;
        let changed = false;
        const merged = {};

        for (const [key, envelope] of Object.entries(cloudData)) {
            if (!envelope || typeof envelope !== 'object') continue;
            const cloudTs = envelope._ts || 0;
            const cloudValue = envelope.value;
            const raw = typeof cloudValue === 'string' ? cloudValue : JSON.stringify(cloudValue);

            if (key in localSnapshot) {
                if (localSnapshot[key] !== raw && cloudTs > lastSyncMs) {
                    merged[key] = raw;
                    changed = true;
                }
            } else {
                merged[key] = raw;
                changed = true;
            }
        }

        if (changed) {
            Storage.importAll(merged);
            await pushToCloud();
            location.reload();
            return true;
        }

        await pushToCloud();
        return false;
    }

    /* ─── Sync: clear cloud ────────────────────────────────────── */

    async function clearCloud() {
        const token = await getValidToken();
        if (!token) return;
        const session = getSession();

        const resp = await fetch(
            `${REST_URL}/user_data?user_id=eq.${session.user.id}`,
            { method: 'DELETE', headers: headers(token) }
        );
        if (!resp.ok) throw new Error('Failed to clear cloud data');
        localStorage.removeItem(LAST_SYNC_KEY);
    }

    /* ─── Auto-sync ────────────────────────────────────────────── */

    function startAutoSync() {
        stopAutoSync();
        syncTimer = setInterval(async () => {
            try { await pushToCloud(); } catch (e) { console.warn('Auto-sync failed:', e); }
        }, SYNC_INTERVAL);
    }

    function stopAutoSync() {
        if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    }

    if (getSession()) startAutoSync();

    /* ─── Public API ───────────────────────────────────────────── */

    window.Sync = Object.freeze({
        signUp,
        signIn,
        signInWithGoogle,
        signOut,
        resetPassword,
        getSession,
        getLastSync,
        pushToCloud,
        pullFromCloud,
        clearCloud,
    });
})();
