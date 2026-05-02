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
    const OAUTH_CALLBACK_URL = 'https://nur-prayer-app.github.io/releases/auth-callback.html';
    const SESSION_KEY = 'nur-sync-session';
    const LAST_SYNC_KEY = 'nur-last-sync';
    const SYNC_INTERVAL = 5 * 60 * 1000;

    let syncTimer = null;
    let syncEnabled = false;
    let cachedSession = null;
    let lastPushedTimestamps = null;
    let syncFailures = 0;

    /* ─── Helpers ───────────────────────────────────────────────── */

    function headers(token) {
        const h = {
            'apikey': SUPABASE_KEY,
            'Content-Type': 'application/json',
        };
        if (token) h['Authorization'] = `Bearer ${token}`;
        return h;
    }

    function decodeJwtPayload(token) {
        const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(base64));
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

    /* ─── PKCE helpers ─────────────────────────────────────────── */

    function generateCodeVerifier() {
        const arr = new Uint8Array(32);
        crypto.getRandomValues(arr);
        return Array.from(arr, b => b.toString(36).padStart(2, '0')).join('').slice(0, 43);
    }

    async function generateCodeChallenge(verifier) {
        const data = new TextEncoder().encode(verifier);
        const hash = await crypto.subtle.digest('SHA-256', data);
        return btoa(String.fromCharCode(...new Uint8Array(hash)))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function storeCodeVerifier(v) {
        if (window.electronAPI?.storeCodeVerifier) window.electronAPI.storeCodeVerifier(v);
        else sessionStorage.setItem('nur-pkce-verifier', v);
    }

    function getCodeVerifier() {
        if (window.electronAPI?.getCodeVerifier) return window.electronAPI.getCodeVerifier();
        return sessionStorage.getItem('nur-pkce-verifier');
    }

    function clearCodeVerifier() {
        if (window.electronAPI?.clearCodeVerifier) window.electronAPI.clearCodeVerifier();
        else sessionStorage.removeItem('nur-pkce-verifier');
    }

    function getOAuthRedirectUrl() {
        return window.electronAPI ? OAUTH_CALLBACK_URL : window.location.origin + window.location.pathname;
    }

    async function exchangeCodeForTokens(code) {
        const verifier = getCodeVerifier();
        clearCodeVerifier();
        if (!verifier) throw new Error('Missing PKCE code verifier');

        const resp = await fetch(`${AUTH_URL}/token?grant_type=pkce`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error_description || data.msg || 'Token exchange failed');
        return data;
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
            const payload = decodeJwtPayload(session.access_token);
            if (Date.now() > payload.exp * 1000 - 60000) {
                session = await refreshToken();
            }
        } catch {
            session = await refreshToken();
        }
        return session?.access_token || null;
    }

    /* ─── Auth ─────────────────────────────────────────────────── */

    function establishSession(data, opts) {
        const session = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            user: data.user || { id: decodeJwtPayload(data.access_token).sub, email: decodeJwtPayload(data.access_token).email },
        };
        saveSession(session);
        startAutoSync();
        return session;
    }

    async function signUp(email, password) {
        const resp = await fetch(`${AUTH_URL}/signup`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ email, password }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error_description || data.msg || 'Sign-up failed');
        if (data.access_token) establishSession(data);
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
        establishSession(data);
        await pullFromCloud();
        return data;
    }

    async function signInWithGoogle() {
        const verifier = generateCodeVerifier();
        const challenge = await generateCodeChallenge(verifier);
        storeCodeVerifier(verifier);

        const redirectTo = getOAuthRedirectUrl();
        const url = `${SUPABASE_URL}/auth/v1/authorize?provider=google`
            + `&redirect_to=${encodeURIComponent(redirectTo)}`
            + `&code_challenge=${encodeURIComponent(challenge)}`
            + `&code_challenge_method=S256`;
        if (window.electronAPI?.openExternal) {
            window.electronAPI.openExternal(url);
        } else {
            window.location.href = url;
        }
    }

    async function handleOAuthTokens(accessToken, refreshToken) {
        establishSession({ access_token: accessToken, refresh_token: refreshToken });
        try { await pullFromCloud(); } catch (e) { console.warn('OAuth pull failed:', e); }
    }

    async function handleOAuthRedirect(url) {
        const qIdx = url.indexOf('?');
        if (qIdx !== -1) {
            const params = new URLSearchParams(url.slice(qIdx + 1));
            const code = params.get('code');
            if (code) {
                const data = await exchangeCodeForTokens(code);
                await handleOAuthTokens(data.access_token, data.refresh_token);
                window.dispatchEvent(new Event('sync-auth-changed'));
                return true;
            }
        }
        // Legacy implicit flow fallback (pre-PKCE clients)
        const fragment = url.split('#')[1];
        if (fragment) {
            const params = new URLSearchParams(fragment);
            const accessToken = params.get('access_token');
            const refreshToken = params.get('refresh_token');
            if (accessToken && refreshToken) {
                await handleOAuthTokens(accessToken, refreshToken);
                window.dispatchEvent(new Event('sync-auth-changed'));
                return true;
            }
        }
        return false;
    }

    if (window.electronAPI?.onOAuthCallback) {
        window.electronAPI.onOAuthCallback(url => {
            handleOAuthRedirect(url).catch(e => console.warn('OAuth callback error:', e));
        });
    }

    if (!window.electronAPI) {
        (async () => {
            try {
                if (await handleOAuthRedirect(window.location.href)) {
                    history.replaceState(null, '', window.location.pathname);
                }
            } catch (e) { console.warn('Web OAuth parse error:', e); }
        })();
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

    function buildCloudPayload(dirtyKeys) {
        const snapshot = Storage.exportAll();
        const now = Date.now();
        const firstPush = lastPushedTimestamps === null;
        const payload = {};
        for (const [key, raw] of Object.entries(snapshot)) {
            let value = raw;
            try { value = JSON.parse(raw); } catch {}
            const prevTs = lastPushedTimestamps?.[key] || now;
            payload[key] = { value, _ts: (firstPush || dirtyKeys.has(key)) ? now : prevTs };
        }
        return payload;
    }

    async function pushToCloud(force) {
        const dirtyKeys = Storage.getDirtyKeys();
        if (!force && lastPushedTimestamps !== null && dirtyKeys.size === 0) return;

        const token = await getValidToken();
        if (!token) return;
        const session = getSession();

        const payload = buildCloudPayload(dirtyKeys);
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
        const timestamps = {};
        for (const [key, envelope] of Object.entries(payload)) timestamps[key] = envelope._ts;
        lastPushedTimestamps = timestamps;
        Storage.clearDirtyKeys();
        syncFailures = 0;
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
        const dirtyKeys = Storage.getDirtyKeys();
        const lastSyncTs = getLastSync();
        const lastSyncMs = lastSyncTs ? new Date(lastSyncTs).getTime() : 0;
        let changed = false;
        const merged = {};

        for (const [key, envelope] of Object.entries(cloudData)) {
            if (!envelope || typeof envelope !== 'object') continue;
            if (dirtyKeys.has(key)) continue;
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
            Storage.suppressDirty(true);
            try { Storage.importAll(merged); }
            finally { Storage.suppressDirty(false); }
            if (Storage.getDirtyKeys().size > 0) await pushToCloud();
            location.reload();
            return true;
        }

        if (Storage.getDirtyKeys().size > 0) await pushToCloud();
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

    const MAX_BACKOFF = 30 * 60 * 1000;

    function scheduleNextSync() {
        const delay = Math.min(SYNC_INTERVAL * Math.pow(2, syncFailures), MAX_BACKOFF);
        syncTimer = setTimeout(async () => {
            try {
                const pulled = await pullFromCloud();
                if (!pulled) await pushToCloud();
            } catch (e) {
                console.warn('Auto-sync failed:', e);
                syncFailures++;
            }
            if (syncEnabled) scheduleNextSync();
        }, delay);
    }

    function startAutoSync() {
        stopAutoSync();
        syncEnabled = true;
        syncFailures = 0;
        scheduleNextSync();
    }

    function stopAutoSync() {
        syncEnabled = false;
        if (syncTimer !== null) { clearTimeout(syncTimer); syncTimer = null; }
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
