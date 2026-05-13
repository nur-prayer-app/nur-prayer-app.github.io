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
    const OAUTH_CALLBACK_URL = 'https://nur-prayer-app.github.io/auth-callback.html';
    const SESSION_KEY = 'nur-sync-session';
    const LAST_SYNC_KEY = 'nur-last-sync';
    const SYNC_INTERVAL = 15 * 1000;

    let syncTimer = null;
    let syncEnabled = false;
    let cachedSession = null;
    let lastPushedTimestamps = null;
    let syncFailures = 0;
    let isSyncing = false;

    try { lastPushedTimestamps = JSON.parse(localStorage.getItem('nur-push-timestamps')); } catch {}

    function savePushTimestamps() {
        localStorage.setItem('nur-push-timestamps', JSON.stringify(lastPushedTimestamps));
    }

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
        else localStorage.setItem('nur-pkce-verifier', v);
    }

    function getCodeVerifier() {
        if (window.electronAPI?.getCodeVerifier) return window.electronAPI.getCodeVerifier();
        return localStorage.getItem('nur-pkce-verifier');
    }

    function clearCodeVerifier() {
        if (window.electronAPI?.clearCodeVerifier) window.electronAPI.clearCodeVerifier();
        else localStorage.removeItem('nur-pkce-verifier');
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

    let _refreshPromise = null;

    async function refreshToken() {
        if (_refreshPromise) return _refreshPromise;
        _refreshPromise = (async () => {
            const session = getSession();
            if (!session?.refresh_token) return null;

            const resp = await fetch(`${AUTH_URL}/token?grant_type=refresh_token`, {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({ refresh_token: session.refresh_token }),
            });
            if (!resp.ok) {
                saveSession(null);
                window.dispatchEvent(new CustomEvent('sync-session-lost'));
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
        })();
        try { return await _refreshPromise; }
        finally { _refreshPromise = null; }
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

    function establishSession(data) {
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
        try {
            if (await pullFromCloud()) window.dispatchEvent(new Event('sync-data-updated'));
        } catch (e) {
            console.warn('Initial pull after sign-in failed:', e);
        }
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
        try {
            if (await pullFromCloud()) window.dispatchEvent(new Event('sync-data-updated'));
            else await pushToCloud(true);
        } catch (e) { console.warn('OAuth sync failed:', e); }
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

    async function signOutAll() {
        const token = await getValidToken();
        if (token) {
            await fetch(`${AUTH_URL}/logout?scope=global`, {
                method: 'POST',
                headers: headers(token),
            }).catch(() => {});
        }
        saveSession(null);
        localStorage.removeItem(LAST_SYNC_KEY);
        stopAutoSync();
    }

    /* ─── Per-day timestamps for prayer-data merge ───────────────── */
    const PRAYER_KEY = 'prayer-data';
    const DAY_TS_KEY = 'nur-prayer-day-ts';

    function getDayTimestamps() {
        try { return JSON.parse(localStorage.getItem(DAY_TS_KEY)) || {}; } catch { return {}; }
    }

    function saveDayTimestamps(ts) {
        localStorage.setItem(DAY_TS_KEY, JSON.stringify(ts));
    }

    function stampPrayerDay(dayKey) {
        const ts = getDayTimestamps();
        ts[dayKey] = Date.now();
        saveDayTimestamps(ts);
    }

    /* ─── Goal merge (event-sourcing: union notes by ID) ─────────── */

    const GOALS_KEY = 'goals-data';

    function computeNoteId(n) {
        const raw = `${n.date}|${n.amount}|${n.sourceKey || ''}|${n.text || ''}`;
        let h = 0x811c9dc5;
        for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        return (h >>> 0).toString(36);
    }

    function mergeGoals(localGoals, cloudGoals) {
        if (!cloudGoals || !Array.isArray(cloudGoals)) return localGoals;
        if (!localGoals || !Array.isArray(localGoals)) return cloudGoals;

        function goalKey(g) {
            if (g.type === 'qadaa-auto') return 'auto-' + (g.missedOn || '') + '-' + (g.missedPrayer || '');
            return g.type;
        }

        const byKey = new Map();
        for (const g of localGoals) {
            byKey.set(goalKey(g), { ...g, notes: [...(g.notes || [])] });
        }
        for (const g of cloudGoals) {
            const k = goalKey(g);
            if (!byKey.has(k)) {
                byKey.set(k, { ...g, notes: [...(g.notes || [])] });
            } else {
                const target = byKey.get(k);
                target.total = Math.max(target.total || 0, g.total || 0);
                // Dedup by content hash — same note on any device gets same ID
                const existing = new Set(target.notes.map(n => computeNoteId(n)));
                for (const n of (g.notes || [])) {
                    const id = computeNoteId(n);
                    if (!existing.has(id)) {
                        target.notes.push(n);
                        existing.add(id);
                    }
                }
            }
        }

        const result = [];
        for (const g of byKey.values()) {
            g.remaining = Math.max(0, (g.total || 0) + (g.notes || []).reduce((s, n) => s + (n.amount || 0), 0));
            result.push(g);
        }
        return result;
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
            const envelope = { value, _ts: (firstPush || dirtyKeys.has(key)) ? now : prevTs };
            // Attach per-day timestamps for prayer-data to enable day-level merge
            if (key === PRAYER_KEY) {
                envelope._dayTs = getDayTimestamps();
            }
            payload[key] = envelope;
        }
        return payload;
    }

    async function pushToCloud(force) {
        if (isSyncing) return;
        isSyncing = true;
        try {
            const dirtyKeys = Storage.getDirtyKeys();
            if (!force && lastPushedTimestamps !== null && dirtyKeys.size === 0) return;

            const token = await getValidToken();
            if (!token) return;
            const session = getSession();

            // Pull-before-push: merge cloud changes before overwriting (skip on force push)
            if (!force) try {
                const pullResp = await fetch(
                    `${REST_URL}/user_data?user_id=eq.${session.user.id}&select=data`,
                    { headers: headers(token) }
                );
                if (pullResp.ok) {
                    const rows = await pullResp.json();
                    if (rows.length && rows[0].data) {
                        const cloudData = rows[0].data;
                        const localPrayers = Storage.get(PRAYER_KEY, {});
                        const localDayTs = getDayTimestamps();
                        const cloudEnv = cloudData[PRAYER_KEY];
                        if (cloudEnv && cloudEnv._dayTs && cloudEnv.value) {
                            const cloudDayTs = cloudEnv._dayTs;
                            let merged = false;
                            for (const [dayKey, cloudDayData] of Object.entries(cloudEnv.value)) {
                                const localMod = localDayTs[dayKey] || 0;
                                const cloudMod = cloudDayTs[dayKey] || 0;
                                if (cloudMod > localMod) {
                                    localPrayers[dayKey] = cloudDayData;
                                    localDayTs[dayKey] = cloudMod;
                                    merged = true;
                                }
                            }
                            if (merged) {
                                Storage.suppressDirty(true);
                                try { Storage.set(PRAYER_KEY, localPrayers); }
                                finally { Storage.suppressDirty(false); }
                                saveDayTimestamps(localDayTs);
                                window.dispatchEvent(new Event('sync-data-updated'));
                            }
                        }
                    }
                }
            } catch {}

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
            savePushTimestamps();
            for (const key of dirtyKeys) Storage.removeDirtyKey(key);
            syncFailures = 0;
            return setLastSync();
        } finally {
            isSyncing = false;
        }
    }

    /* ─── Sync: pull + merge ───────────────────────────────────── */

    async function pullFromCloud() {
        if (isSyncing) return;
        isSyncing = true;
        try {
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

            const allowedKeys = new Set(Object.values(Storage.KEYS));
            for (const [key, envelope] of Object.entries(cloudData)) {
                if (!allowedKeys.has(key)) continue;
                if (!envelope || typeof envelope !== 'object') continue;
                const cloudTs = envelope._ts || 0;
                const cloudValue = envelope.value;

                // Per-day merge for prayer-data: field-level merge within each day
                if (key === PRAYER_KEY && envelope._dayTs && cloudValue && typeof cloudValue === 'object') {
                    let localPrayers = {};
                    try { localPrayers = JSON.parse(localSnapshot[key] || '{}'); } catch {}
                    const localDayTs = getDayTimestamps();
                    const cloudDayTs = envelope._dayTs;
                    let dayMerged = false;
                    for (const [dayKey, cloudDayData] of Object.entries(cloudValue)) {
                        const localDayModified = localDayTs[dayKey] || 0;
                        const cloudDayModified = cloudDayTs[dayKey] || 0;
                        if (cloudDayModified > localDayModified) {
                            // Cloud is newer: merge fields (union of true values)
                            if (!localPrayers[dayKey]) {
                                localPrayers[dayKey] = cloudDayData;
                            } else {
                                const local = localPrayers[dayKey];
                                for (const [field, val] of Object.entries(cloudDayData)) {
                                    if (val === true || local[field] === undefined || local[field] === false) {
                                        local[field] = val;
                                    }
                                }
                            }
                            localDayTs[dayKey] = cloudDayModified;
                            dayMerged = true;
                        } else if (cloudDayModified === localDayModified && cloudDayData) {
                            // Same timestamp: merge true values from cloud (additive)
                            if (!localPrayers[dayKey]) localPrayers[dayKey] = {};
                            const local = localPrayers[dayKey];
                            for (const [field, val] of Object.entries(cloudDayData)) {
                                if (val === true && !local[field]) {
                                    local[field] = true;
                                    dayMerged = true;
                                }
                            }
                        }
                    }
                    if (dayMerged) {
                        merged[key] = JSON.stringify(localPrayers);
                        saveDayTimestamps(localDayTs);
                        changed = true;
                    }
                    continue;
                }

                // Goals: merge notes by UUID (event sourcing)
                if (key === GOALS_KEY && cloudValue && Array.isArray(cloudValue)) {
                    let localGoals = [];
                    try { localGoals = JSON.parse(localSnapshot[key] || '[]'); } catch {}
                    const mergedGoals = mergeGoals(localGoals, cloudValue);
                    const mergedRaw = JSON.stringify(mergedGoals);
                    if (mergedRaw !== (localSnapshot[key] || '[]')) {
                        merged[key] = mergedRaw;
                        changed = true;
                    }
                    continue;
                }

                if (dirtyKeys.has(key)) continue;
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
                setLastSync();
                return true;
            }

            return false;
        } finally {
            isSyncing = false;
        }
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
        localStorage.removeItem('nur-push-timestamps');
        localStorage.removeItem(DAY_TS_KEY);
        lastPushedTimestamps = null;
    }

    /* ─── Auto-sync ────────────────────────────────────────────── */

    const MAX_BACKOFF = 30 * 60 * 1000;

    function scheduleNextSync() {
        const delay = Math.min(SYNC_INTERVAL * Math.pow(2, syncFailures), MAX_BACKOFF);
        syncTimer = setTimeout(async () => {
            if (!isSyncing) {
                try {
                    if (await pullFromCloud()) window.dispatchEvent(new Event('sync-data-updated'));
                    await pushToCloud();
                    syncFailures = 0;
                } catch (e) {
                    console.warn('Auto-sync failed:', e);
                    syncFailures++;
                }
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

    if (getSession()) {
        (async () => { try { await pushToCloud(true); } catch(e) { console.warn('startup push:', e); } startAutoSync(); })();
    }

    // Immediate sync on reconnection — reset backoff and trigger sync
    window.addEventListener('online', () => {
        if (syncEnabled && !isSyncing) {
            syncFailures = 0;
            if (syncTimer !== null) { clearTimeout(syncTimer); syncTimer = null; }
            scheduleNextSync();
        }
    });

    /* ─── Public API ───────────────────────────────────────────── */

    window.Sync = Object.freeze({
        signUp,
        signIn,
        signInWithGoogle,
        signOut,
        signOutAll,
        resetPassword,
        getSession,
        getLastSync,
        pushToCloud,
        pullFromCloud,
        clearCloud,
        stampPrayerDay,
        stopAutoSync,
        SUPABASE_URL,
        SUPABASE_KEY,
    });
})();
