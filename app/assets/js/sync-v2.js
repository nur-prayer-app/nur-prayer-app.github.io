/* ================================================================
   Sync v2 — Supabase Auth + Hybrid Table Sync
   ================================================================
   Architecture:
   - prayer_days: LWW per field (timestamp per field)
   - goal_events: append-only (UUID PK, DB rejects duplicates)
   - goals: metadata (LWW per row)
   - user_settings: LWW per key

   Local Storage is source of truth. Cloud is synced replica.
   _auto_missed flags are LOCAL ONLY — never synced.
   ================================================================ */

(function () {
    'use strict';

    const SUPABASE_URL = 'https://qbyirkzdwzeetdugxyre.supabase.co';
    const SUPABASE_KEY = 'sb_publishable_BgBlYMnxPhkWWEtbHNHzIg_h-RkMDda';
    const AUTH_URL = `${SUPABASE_URL}/auth/v1`;
    const REST_URL = `${SUPABASE_URL}/rest/v1`;
    const OAUTH_CALLBACK_URL = 'https://nur-prayer-app.github.io/auth-callback.html';
    const SESSION_KEY = 'nur-sync-session';
    const QUEUE_KEY = 'nur-sync-queue';
    const LAST_SYNC_KEY = 'nur-last-sync-v2';
    const FIELD_TS_KEY = 'nur-field-ts';
    const DEVICE_ID_KEY = 'nur-device-id';
    const SYNC_INTERVAL_FG = 15 * 1000;
    const SYNC_INTERVAL_BG = 60 * 1000;

    let syncTimer = null;
    let syncEnabled = false;
    let cachedSession = null;
    let syncFailures = 0;
    let isSyncing = false;
    let clockOffset = 0;

    const DEVICE_ID = localStorage.getItem(DEVICE_ID_KEY) ||
        (() => { const id = crypto.randomUUID(); localStorage.setItem(DEVICE_ID_KEY, id); return id; })();

    /* ─── Sync Log ─────────────────────────────────────────────── */

    const SYNC_LOG_KEY = 'nur-sync-log';
    const SYNC_LOG_MAX = 200;

    function syncLog(msg) {
        const ts = new Date().toISOString().slice(11, 19);
        const logs = JSON.parse(localStorage.getItem(SYNC_LOG_KEY) || '[]');
        logs.push(`[${ts}] ${msg}`);
        if (logs.length > SYNC_LOG_MAX) logs.splice(0, logs.length - SYNC_LOG_MAX);
        localStorage.setItem(SYNC_LOG_KEY, JSON.stringify(logs));
        if (window.electronAPI?.writeLog) window.electronAPI.writeLog(`[sync] ${msg}`);
    }

    /* ─── Helpers ───────────────────────────────────────────────── */

    function syncedNow() { return Date.now() + clockOffset; }

    function headers(token) {
        const h = { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' };
        if (token) h['Authorization'] = `Bearer ${token}`;
        return h;
    }

    function decodeJwtPayload(token) {
        const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(base64));
    }

    /* ─── Session ──────────────────────────────────────────────── */

    let _cachedTokenExp = 0;

    function getSession() {
        if (cachedSession) return cachedSession;
        try {
            cachedSession = JSON.parse(localStorage.getItem(SESSION_KEY));
            if (cachedSession?.access_token && !_cachedTokenExp) {
                try { _cachedTokenExp = decodeJwtPayload(cachedSession.access_token).exp; } catch {}
            }
            return cachedSession;
        } catch { return null; }
    }

    function saveSession(session) {
        cachedSession = session;
        _cachedTokenExp = 0;
        if (session?.access_token) {
            try { _cachedTokenExp = decodeJwtPayload(session.access_token).exp; } catch {}
        }
        if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else localStorage.removeItem(SESSION_KEY);
    }

    function getLastSync() { return localStorage.getItem(LAST_SYNC_KEY); }
    function setLastSync() { const ts = new Date().toISOString(); localStorage.setItem(LAST_SYNC_KEY, ts); return ts; }

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
            method: 'POST', headers: headers(),
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
                method: 'POST', headers: headers(),
                body: JSON.stringify({ refresh_token: session.refresh_token }),
            });
            if (!resp.ok) { saveSession(null); stopAutoSync(); window.dispatchEvent(new CustomEvent('sync-session-lost')); return null; }
            const data = await resp.json();
            const newSession = { access_token: data.access_token, refresh_token: data.refresh_token, user: data.user };
            saveSession(newSession);
            return newSession;
        })();
        try { return await _refreshPromise; } finally { _refreshPromise = null; }
    }

    async function getValidToken() {
        let session = getSession();
        if (!session?.access_token) return null;
        try {
            const exp = _cachedTokenExp || decodeJwtPayload(session.access_token).exp;
            if (Date.now() > exp * 1000 - 60000) session = await refreshToken();
        } catch { session = await refreshToken(); }
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
        localStorage.removeItem(LAST_SYNC_KEY);
        _fullPushDone = false;
        _fullPushGoalsDone = false;
        startAutoSync();
        return session;
    }

    async function signUp(email, password) {
        const resp = await fetch(`${AUTH_URL}/signup`, { method: 'POST', headers: headers(), body: JSON.stringify({ email, password }) });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error_description || data.msg || 'Sign-up failed');
        if (data.access_token) establishSession(data);
        return data;
    }

    async function signIn(email, password) {
        const resp = await fetch(`${AUTH_URL}/token?grant_type=password`, { method: 'POST', headers: headers(), body: JSON.stringify({ email, password }) });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error_description || data.msg || 'Sign-in failed');
        establishSession(data);
        try { await syncAll(); } catch {}
        return data;
    }

    async function signInWithGoogle() {
        const verifier = generateCodeVerifier();
        const challenge = await generateCodeChallenge(verifier);
        storeCodeVerifier(verifier);
        const redirectTo = getOAuthRedirectUrl();
        const url = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
        if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
        else window.location.href = url;
    }

    async function handleOAuthTokens(accessToken, refreshToken) {
        establishSession({ access_token: accessToken, refresh_token: refreshToken });
        try { await syncAll(); } catch {}
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
        window.electronAPI.onOAuthCallback(url => { handleOAuthRedirect(url).catch(() => {}); });
    }
    if (!window.electronAPI) {
        (async () => { try { if (await handleOAuthRedirect(window.location.href)) history.replaceState(null, '', window.location.pathname); } catch {} })();
    }

    async function resetPassword(email) {
        const resp = await fetch(`${AUTH_URL}/recover`, { method: 'POST', headers: headers(), body: JSON.stringify({ email }) });
        if (!resp.ok) { const data = await resp.json(); throw new Error(data.error_description || data.msg || 'Reset failed'); }
    }

    async function signOut() {
        const token = await getValidToken();
        if (token) await fetch(`${AUTH_URL}/logout`, { method: 'POST', headers: headers(token) }).catch(() => {});
        saveSession(null);
        localStorage.removeItem(LAST_SYNC_KEY);
        localStorage.removeItem(QUEUE_KEY);
        _queueCache = null;
        stopAutoSync();
    }

    async function signOutAll() {
        const token = await getValidToken();
        if (token) await fetch(`${AUTH_URL}/logout?scope=global`, { method: 'POST', headers: headers(token) }).catch(() => {});
        saveSession(null);
        localStorage.removeItem(LAST_SYNC_KEY);
        localStorage.removeItem(QUEUE_KEY);
        _queueCache = null;
        stopAutoSync();
    }

    /* ─── Offline Queue ────────────────────────────────────────── */

    let _queueCache = null;

    function getQueue() {
        if (_queueCache !== null) return _queueCache;
        try { _queueCache = JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; }
        catch { _queueCache = []; }
        return _queueCache;
    }
    function saveQueue(q) {
        _queueCache = q;
        localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    }

    function enqueue(table, data) {
        const q = getQueue();
        q.push({ table, data, ts: syncedNow() });
        saveQueue(q);
    }

    /* ─── Field Timestamps (for prayer days LWW) ───────────────── */

    let _fieldTsCache = null;

    function getFieldTs() {
        if (_fieldTsCache !== null) return _fieldTsCache;
        try { _fieldTsCache = JSON.parse(localStorage.getItem(FIELD_TS_KEY)) || {}; }
        catch { _fieldTsCache = {}; }
        return _fieldTsCache;
    }
    function saveFieldTs(ts) {
        _fieldTsCache = ts;
        localStorage.setItem(FIELD_TS_KEY, JSON.stringify(ts));
    }

    /* ─── Sync: Prayer Days ────────────────────────────────────── */

    const PRAYER_FIELDS = [
        'fajr', 'dhuhr', 'asr', 'maghrib', 'isha',
        'shafa_witr', 'qyaam', 'qyaam_rakaat', 'fasting', 'duha',
        'fajr_qadaa', 'dhuhr_qadaa', 'asr_qadaa', 'maghrib_qadaa', 'isha_qadaa', 'fasting_qadaa'
    ];

    // Pre-merged field maps (single lookup instead of chained fallbacks)
    const FIELD_L2C = { shafaWitr: 'shafa_witr', qyaamRakaat: 'qyaam_rakaat' };
    const FIELD_C2L = { shafa_witr: 'shafaWitr', qyaam_rakaat: 'qyaamRakaat' };
    ['fajr','dhuhr','asr','maghrib','isha'].forEach(p => {
        FIELD_L2C[`${p}_qadaa_recorded`] = `${p}_qadaa`;
        FIELD_C2L[`${p}_qadaa`] = `${p}_qadaa_recorded`;
    });

    function localFieldToCloud(f) { return FIELD_L2C[f] || f; }
    function cloudFieldToLocal(f) { return FIELD_C2L[f] || f; }

    async function pullPrayerDays(token, userId) {
        const lastSync = getLastSync();
        const since = lastSync ? new Date(lastSync).getTime() : 0;
        const url = `${REST_URL}/prayer_days?user_id=eq.${userId}&updated_at=gt.${since}&select=*`;
        const resp = await fetch(url, { headers: headers(token) });
        if (!resp.ok) return false;
        updateClockOffset(resp);
        const rows = await resp.json();
        if (!rows.length) return false;

        const prayers = Storage.get(Storage.KEYS.PRAYERS, {});
        const fieldTs = getFieldTs();
        let changed = false;

        for (const row of rows) {
            const dayKey = row.day_key;
            if (typeof dayKey !== 'string') continue;
            if (!prayers[dayKey]) prayers[dayKey] = {};
            if (!fieldTs[dayKey]) fieldTs[dayKey] = {};
            const dd = prayers[dayKey];
            const dayTs = fieldTs[dayKey];

            for (const cloudField of PRAYER_FIELDS) {
                const cloudTs = typeof row[cloudField + '_at'] === 'number' ? row[cloudField + '_at'] : 0;
                const localField = cloudFieldToLocal(cloudField);
                const myTs = dayTs[localField] || 0;
                if (cloudTs > myTs) {
                    dd[localField] = row[cloudField];
                    dayTs[localField] = cloudTs;
                    changed = true;
                }
            }
        }

        if (changed) {
            Storage.suppressDirty(true);
            try { Storage.set(Storage.KEYS.PRAYERS, prayers); } finally { Storage.suppressDirty(false); }
            saveFieldTs(fieldTs);
        }
        return changed;
    }

    async function flushPrayerQueue(token, userId) {
        const q = getQueue();
        const prayerItems = q.filter(i => i.table === 'prayer_days');
        if (!prayerItems.length) return;

        const fieldTs = getFieldTs();
        const failed = [];
        let currentToken = token;
        for (const item of prayerItems) {
            const { day_key, ...fields } = item.data;
            if (!day_key) continue;
            const dayTs = fieldTs[day_key] || {};
            const params = { p_user_id: userId, p_day_key: day_key };
            for (const cf of PRAYER_FIELDS) {
                const localField = cloudFieldToLocal(cf);
                if (localField in fields) {
                    params[`p_${cf}`] = cf === 'qyaam_rakaat' ? (parseInt(fields[localField], 10) || 0) : !!fields[localField];
                    params[`p_${cf}_at`] = dayTs[localField] || 0;
                } else {
                    params[`p_${cf}`] = cf === 'qyaam_rakaat' ? 0 : false;
                    params[`p_${cf}_at`] = 0;
                }
            }

            let resp = await fetch(`${REST_URL}/rpc/upsert_prayer_day`, {
                method: 'POST', headers: headers(currentToken), body: JSON.stringify({ payload: params }),
            });
            if (resp.status === 401) {
                // Token expired mid-flush — refresh and retry this item once
                const refreshed = await getValidToken();
                if (!refreshed) return; // can't recover
                currentToken = refreshed;
                resp = await fetch(`${REST_URL}/rpc/upsert_prayer_day`, {
                    method: 'POST', headers: headers(currentToken), body: JSON.stringify({ payload: params }),
                });
            }
            if (!resp.ok) {
                failed.push(item);
            }
        }
        const remaining = q.filter(i => i.table !== 'prayer_days').concat(failed);
        saveQueue(remaining);
    }

    /* ─── Sync: Goals ──────────────────────────────────────────── */

    async function pullGoals(token, userId) {
        const resp = await fetch(`${REST_URL}/goals?user_id=eq.${userId}&select=*`, { headers: headers(token) });
        if (!resp.ok) return false;
        const cloudGoals = await resp.json();
        if (!cloudGoals.length) return false;

        // Pull events since last sync
        const lastSync = getLastSync();
        const eventsUrl = lastSync
            ? `${REST_URL}/goal_events?user_id=eq.${userId}&created_at=gt.${lastSync}&select=*&order=created_at`
            : `${REST_URL}/goal_events?user_id=eq.${userId}&select=*&order=created_at`;
        const evResp = await fetch(eventsUrl, { headers: headers(token) });
        const cloudEvents = evResp.ok ? await evResp.json() : [];

        // Rebuild local goals from cloud state
        const localGoals = Storage.get(Storage.KEYS.GOALS, []);
        let changed = false;

        for (const cg of cloudGoals) {
            if (!cg.goal_type || typeof cg.goal_type !== 'string') continue;
            if (typeof cg.target_amount !== 'number') continue;
            let local = localGoals.find(g => g.type === cg.goal_type && (g.createdAt || '') === (new Date(cg.updated_at || 0).toISOString()));
            if (!local) local = localGoals.find(g => g.type === cg.goal_type);
            if (!local) {
                local = { type: cg.goal_type, name: cg.name || cg.goal_type, total: cg.target_amount, remaining: cg.target_amount, notes: [], perPrayer: null, createdAt: new Date().toISOString() };
                localGoals.push(local);
                changed = true;
            }
            if (cg.target_amount > local.total) { local.total = cg.target_amount; changed = true; }
            if (typeof cg.name === 'string' && cg.name !== local.name) { local.name = cg.name; changed = true; }
            if (cg.archived_at > 0 && !local.completed) { local.completed = true; local.archivedAt = new Date(cg.archived_at).toISOString(); changed = true; }
        }

        // Merge new events into local notes
        if (cloudEvents.length) {
            for (const ev of cloudEvents) {
                if (!ev.id || typeof ev.id !== 'string') continue;
                if (typeof ev.amount !== 'number') continue;
                const goal = localGoals.find(g => g.type === ev.goal_key || (g.type + '') === ev.goal_key);
                if (!goal) continue;
                goal.notes = goal.notes || [];
                const exists = goal.notes.some(n => n.id === ev.id);
                if (!exists) {
                    goal.notes.push({
                        id: ev.id,
                        date: ev.created_at || new Date(ev.client_ts).toISOString(),
                        text: typeof ev.note_text === 'string' ? ev.note_text : '',
                        amount: ev.amount,
                        sourceKey: ev.source_key || null,
                        prayer: ev.prayer || null,
                        refEventId: ev.ref_event_id || null,
                    });
                    changed = true;
                }
            }
            // Recompute remaining for each goal
            for (const g of localGoals) {
                const sum = (g.notes || []).reduce((s, n) => s + (n.amount || 0), 0);
                const computed = Math.max(0, g.total + sum);
                if (g.remaining !== computed) { g.remaining = computed; changed = true; }
            }
        }

        if (changed) {
            Storage.suppressDirty(true);
            try { Storage.set(Storage.KEYS.GOALS, localGoals); } finally { Storage.suppressDirty(false); }
        }
        return changed;
    }

    async function flushGoalQueue(token, userId) {
        const q = getQueue();
        const goalItems = q.filter(i => i.table === 'goal_events');
        const goalMeta = q.filter(i => i.table === 'goals');
        if (!goalItems.length && !goalMeta.length) return;

        let currentToken = token;
        const failedMeta = [];
        const failedEvents = [];

        // Push goal metadata
        for (const item of goalMeta) {
            let resp = await fetch(`${REST_URL}/goals`, {
                method: 'POST', headers: { ...headers(currentToken), 'Prefer': 'resolution=merge-duplicates' },
                body: JSON.stringify({ user_id: userId, ...item.data }),
            });
            if (resp.status === 401) {
                currentToken = await getValidToken();
                if (!currentToken) return;
                resp = await fetch(`${REST_URL}/goals`, {
                    method: 'POST', headers: { ...headers(currentToken), 'Prefer': 'resolution=merge-duplicates' },
                    body: JSON.stringify({ user_id: userId, ...item.data }),
                });
            }
            if (!resp.ok) failedMeta.push(item);
        }

        // Push goal events (ON CONFLICT DO NOTHING — dedup by PK)
        if (goalItems.length) {
            const events = goalItems.map(i => ({ user_id: userId, ...i.data }));
            let resp = await fetch(`${REST_URL}/goal_events`, {
                method: 'POST',
                headers: { ...headers(currentToken), 'Prefer': 'resolution=ignore-duplicates' },
                body: JSON.stringify(events),
            });
            if (resp.status === 401) {
                currentToken = await getValidToken();
                if (!currentToken) return;
                resp = await fetch(`${REST_URL}/goal_events`, {
                    method: 'POST',
                    headers: { ...headers(currentToken), 'Prefer': 'resolution=ignore-duplicates' },
                    body: JSON.stringify(events),
                });
            }
            if (!resp.ok) failedEvents.push(...goalItems);
        }

        // Remove successfully flushed items, keep failed for retry
        const remaining = q.filter(i => i.table !== 'goal_events' && i.table !== 'goals')
            .concat(failedMeta).concat(failedEvents);
        saveQueue(remaining);
    }

    /* ─── Sync: Settings ───────────────────────────────────────── */

    const SYNCED_SETTINGS = new Set([
        'location', 'calcMethod', 'asrSchool', 'iqamaOffsets', 'timeAdjustments',
        'notifications', 'notifPreEnabled', 'notifPreMinutes', 'notifAdhanEnabled',
        'notifPreIqamaEnabled', 'notifPreIqamaMinutes', 'prayerNotifs',
        'autoMarkMissed', 'hijriOffset', 'trackLatePrayers',
    ]);

    let _settingsTsCache = null;

    function getSettingsTs() {
        if (_settingsTsCache !== null) return _settingsTsCache;
        try { _settingsTsCache = JSON.parse(localStorage.getItem('nur-settings-ts') || '{}'); }
        catch { _settingsTsCache = {}; }
        return _settingsTsCache;
    }
    function saveSettingsTs(ts) {
        _settingsTsCache = ts;
        localStorage.setItem('nur-settings-ts', JSON.stringify(ts));
    }

    async function pullSettings(token, userId) {
        const resp = await fetch(`${REST_URL}/user_settings?user_id=eq.${userId}&select=*`, { headers: headers(token) });
        if (!resp.ok) return false;
        const rows = await resp.json();
        if (!rows.length) return false;

        const settings = Storage.get(Storage.KEYS.SETTINGS, {});
        const localTs = getSettingsTs();
        let changed = false;

        for (const row of rows) {
            if (!SYNCED_SETTINGS.has(row.key)) continue;
            const cloudTs = typeof row.updated_at === 'number' ? row.updated_at : 0;
            const myTs = localTs[row.key] || 0;
            if (cloudTs > myTs) {
                settings[row.key] = row.value;
                localTs[row.key] = cloudTs;
                changed = true;
            }
        }

        if (changed) {
            Storage.suppressDirty(true);
            try { Storage.set(Storage.KEYS.SETTINGS, settings); } finally { Storage.suppressDirty(false); }
            saveSettingsTs(localTs);
        }
        return changed;
    }

    async function flushSettingsQueue(token, userId) {
        const q = getQueue();
        const settingsItems = q.filter(i => i.table === 'user_settings');
        if (!settingsItems.length) return;

        let currentToken = token;
        const failed = [];
        for (const item of settingsItems) {
            let resp = await fetch(`${REST_URL}/user_settings`, {
                method: 'POST',
                headers: { ...headers(currentToken), 'Prefer': 'resolution=merge-duplicates' },
                body: JSON.stringify({ user_id: userId, ...item.data }),
            });
            if (resp.status === 401) {
                currentToken = await getValidToken();
                if (!currentToken) return;
                resp = await fetch(`${REST_URL}/user_settings`, {
                    method: 'POST',
                    headers: { ...headers(currentToken), 'Prefer': 'resolution=merge-duplicates' },
                    body: JSON.stringify({ user_id: userId, ...item.data }),
                });
            }
            if (!resp.ok) failed.push(item);
        }

        const remaining = q.filter(i => i.table !== 'user_settings').concat(failed);
        saveQueue(remaining);
    }

    /* ─── Clock offset ─────────────────────────────────────────── */

    function updateClockOffset(resp) {
        const dateHeader = resp.headers.get('date');
        if (dateHeader) {
            const serverTime = new Date(dateHeader).getTime();
            if (!isNaN(serverTime)) {
                const drift = serverTime - Date.now();
                if (Math.abs(drift) < 5 * 60 * 1000) clockOffset = drift;
            }
        }
    }

    /* ─── Full Push: directly push all local prayer data to cloud ── */

    let _fullPushDone = false;

    async function fullPushIfNeeded(token, userId) {
        if (_fullPushDone) return;

        const prayers = Storage.get(Storage.KEYS.PRAYERS, {});
        const localDays = Object.keys(prayers).filter(k => prayers[k] && typeof prayers[k] === 'object');
        syncLog(`fullPush: local=${localDays.length} days`);
        if (!localDays.length) { _fullPushDone = true; return; }

        // Check how many days cloud has
        const countResp = await fetch(
            `${REST_URL}/prayer_days?user_id=eq.${userId}&select=day_key`,
            { headers: headers(token) }
        );
        if (!countResp.ok) { syncLog(`fullPush: countResp failed ${countResp.status}`); return; }
        updateClockOffset(countResp);
        const cloudDays = new Set((await countResp.json()).map(r => r.day_key));

        // Find local days not yet in cloud
        const missing = localDays.filter(k => !cloudDays.has(k));
        syncLog(`fullPush: cloud=${cloudDays.size}, missing=${missing.length}`);
        if (!missing.length) { _fullPushDone = true; return; }

        // Push missing days directly — throttled to avoid rate limits
        const now = syncedNow();
        const fieldTs = getFieldTs();
        let currentToken = token;
        let pushed = 0;
        const BATCH_SIZE = 20;

        for (let i = 0; i < missing.length; i++) {
            const dayKey = missing[i];
            const dd = prayers[dayKey];
            if (!fieldTs[dayKey]) fieldTs[dayKey] = {};
            const params = { p_user_id: userId, p_day_key: dayKey };
            for (const cf of PRAYER_FIELDS) {
                const localField = cloudFieldToLocal(cf);
                const val = dd[localField];
                const hasTs = !!fieldTs[dayKey][localField];
                if (!hasTs && val) fieldTs[dayKey][localField] = now;
                params[`p_${cf}`] = cf === 'qyaam_rakaat' ? (parseInt(val, 10) || 0) : !!val;
                params[`p_${cf}_at`] = fieldTs[dayKey][localField] || 0;
            }

            let resp = await fetch(`${REST_URL}/rpc/upsert_prayer_day`, {
                method: 'POST', headers: headers(currentToken), body: JSON.stringify({ payload: params }),
            });
            if (resp.status === 401) {
                syncLog(`fullPush: 401 at item ${i}, refreshing token`);
                currentToken = await getValidToken();
                if (!currentToken) { syncLog('fullPush: refresh failed, breaking'); break; }
                resp = await fetch(`${REST_URL}/rpc/upsert_prayer_day`, {
                    method: 'POST', headers: headers(currentToken), body: JSON.stringify({ payload: params }),
                });
            }
            if (resp.status === 429) {
                // Rate limited — pause 2s and retry
                await new Promise(r => setTimeout(r, 2000));
                resp = await fetch(`${REST_URL}/rpc/upsert_prayer_day`, {
                    method: 'POST', headers: headers(currentToken), body: JSON.stringify({ payload: params }),
                });
            }
            if (resp.ok) pushed++;

            // Pause every BATCH_SIZE to avoid rate limits
            if ((i + 1) % BATCH_SIZE === 0 && i + 1 < missing.length) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        saveFieldTs(fieldTs);
        syncLog(`fullPush: pushed=${pushed}/${missing.length}`);
        _fullPushDone = true;
    }

    /* ─── Full Push: Goals + Events ────────────────────────────── */

    let _fullPushGoalsDone = false;

    async function fullPushGoalsIfNeeded(token, userId) {
        if (_fullPushGoalsDone) return;

        const goals = Storage.get(Storage.KEYS.GOALS, []);
        if (!goals.length) { _fullPushGoalsDone = true; return; }

        // Check cloud goal count
        const cloudResp = await fetch(`${REST_URL}/goals?user_id=eq.${userId}&select=goal_key`, { headers: headers(token) });
        if (!cloudResp.ok) { syncLog('fullPushGoals: cloud check failed ' + cloudResp.status); return; }
        const cloudGoals = new Set((await cloudResp.json()).map(r => r.goal_key));

        // Push missing goal metadata
        for (const g of goals) {
            if (!g || !g.type) continue;
            if (cloudGoals.has(g.type)) continue;
            const resp = await fetch(`${REST_URL}/goals`, {
                method: 'POST',
                headers: { ...headers(token), 'Prefer': 'resolution=merge-duplicates' },
                body: JSON.stringify({
                    user_id: userId, goal_key: g.type, goal_type: g.type,
                    name: g.name || g.type, target_amount: g.total || 0,
                    archived_at: g.completed ? new Date(g.archivedAt || 0).getTime() : 0,
                    updated_at: syncedNow(),
                }),
            });
            if (resp.ok) syncLog(`fullPushGoals: pushed goal ${g.type}`);
        }

        // Check cloud event count
        const evResp = await fetch(`${REST_URL}/goal_events?user_id=eq.${userId}&select=id`, { headers: headers(token) });
        if (!evResp.ok) { syncLog('fullPushGoals: events check failed ' + evResp.status); return; }
        const cloudEventIds = new Set((await evResp.json()).map(r => r.id));

        // Collect all local events not in cloud
        const missingEvents = [];
        for (const g of goals) {
            if (!Array.isArray(g.notes)) continue;
            for (const n of g.notes) {
                if (!n.id || cloudEventIds.has(n.id)) continue;
                missingEvents.push({
                    id: n.id, user_id: userId, goal_key: g.type,
                    amount: n.amount || 0, note_text: n.text || null,
                    source_key: n.sourceKey || null, prayer: n.prayer || null,
                    ref_event_id: n.refEventId || null, device_id: DEVICE_ID,
                    client_ts: n.date ? new Date(n.date).getTime() : syncedNow(),
                });
            }
        }

        syncLog(`fullPushGoals: cloudEvents=${cloudEventIds.size}, missing=${missingEvents.length}`);
        if (!missingEvents.length) { _fullPushGoalsDone = true; return; }

        // Push in batches of 20 (PostgREST accepts arrays)
        let currentToken = token;
        for (let i = 0; i < missingEvents.length; i += 20) {
            const batch = missingEvents.slice(i, i + 20);
            let resp = await fetch(`${REST_URL}/goal_events`, {
                method: 'POST',
                headers: { ...headers(currentToken), 'Prefer': 'resolution=ignore-duplicates' },
                body: JSON.stringify(batch),
            });
            if (resp.status === 401) {
                currentToken = await getValidToken();
                if (!currentToken) { syncLog('fullPushGoals: token refresh failed'); return; }
                resp = await fetch(`${REST_URL}/goal_events`, {
                    method: 'POST',
                    headers: { ...headers(currentToken), 'Prefer': 'resolution=ignore-duplicates' },
                    body: JSON.stringify(batch),
                });
            }
            if (i + 20 < missingEvents.length) await new Promise(r => setTimeout(r, 300));
        }
        syncLog(`fullPushGoals: done`);
        _fullPushGoalsDone = true;
    }

    /* ─── Sync orchestration ───────────────────────────────────── */

    async function syncAll() {
        if (isSyncing) return;
        isSyncing = true;
        try {
            const token = await getValidToken();
            if (!token) { syncLog('syncAll: no token'); return; }
            const session = getSession();
            if (!session?.user?.id) { syncLog('syncAll: no user id'); return; }
            const userId = session.user.id;
            syncLog('syncAll: start');

            // Push all local data that's missing from cloud
            await fullPushIfNeeded(token, userId);
            await fullPushGoalsIfNeeded(token, userId);

            // Pull (get latest from cloud)
            let changed = false;
            if (await pullPrayerDays(token, userId)) changed = true;
            if (await pullGoals(token, userId)) changed = true;
            if (await pullSettings(token, userId)) changed = true;

            if (changed) window.dispatchEvent(new Event('sync-data-updated'));

            // Push (flush queued changes)
            await flushPrayerQueue(token, userId);
            await flushGoalQueue(token, userId);
            await flushSettingsQueue(token, userId);

            setLastSync();
            syncFailures = 0;
        } catch (e) {
            console.warn('Sync failed:', e);
            syncFailures++;
        } finally {
            isSyncing = false;
        }
    }

    /* ─── Auto-sync ────────────────────────────────────────────── */

    const MAX_BACKOFF = 30 * 60 * 1000;

    function scheduleNextSync() {
        const isBackground = document.hidden;
        const baseInterval = isBackground ? SYNC_INTERVAL_BG : SYNC_INTERVAL_FG;
        const delay = Math.min(baseInterval * Math.pow(2, syncFailures), MAX_BACKOFF);
        syncTimer = setTimeout(async () => {
            await syncAll();
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

    window.addEventListener('online', () => {
        if (syncEnabled && !isSyncing) { syncFailures = 0; clearTimeout(syncTimer); scheduleNextSync(); }
    });

    window.addEventListener('visibilitychange', () => {
        if (!document.hidden && syncEnabled && !isSyncing) {
            clearTimeout(syncTimer);
            syncAll().then(() => { if (syncEnabled) scheduleNextSync(); });
        }
    });

    /* ─── Public API ───────────────────────────────────────────── */

    async function clearCloud() {
        const token = await getValidToken();
        if (!token) return;
        const session = getSession();
        const userId = session?.user?.id;
        if (!userId) return;
        await fetch(`${REST_URL}/prayer_days?user_id=eq.${userId}`, { method: 'DELETE', headers: headers(token) });
        await fetch(`${REST_URL}/goal_events?user_id=eq.${userId}`, { method: 'DELETE', headers: headers(token) });
        await fetch(`${REST_URL}/goals?user_id=eq.${userId}`, { method: 'DELETE', headers: headers(token) });
        await fetch(`${REST_URL}/user_settings?user_id=eq.${userId}`, { method: 'DELETE', headers: headers(token) });
        localStorage.removeItem(LAST_SYNC_KEY);
        localStorage.removeItem(QUEUE_KEY);
        localStorage.removeItem(FIELD_TS_KEY);
        _queueCache = null;
        _fieldTsCache = null;
        _fullPushDone = false;
        _fullPushGoalsDone = false;
    }

    window.Sync = Object.freeze({
        // Auth
        signUp, signIn, signInWithGoogle, signOut, signOutAll, resetPassword,
        getSession, getLastSync,
        // Sync
        syncAll, stopAutoSync, clearCloud,
        // Queue helpers (called by app on save)
        enqueuePrayerDay(dayKey, fields) {
            const fieldTs = getFieldTs();
            if (!fieldTs[dayKey]) fieldTs[dayKey] = {};
            const now = syncedNow();
            const data = { day_key: dayKey };
            for (const [k, v] of Object.entries(fields)) {
                if (k.endsWith('_auto_missed') || k === '_localDirty') continue; // never sync these
                data[k] = v;
                fieldTs[dayKey][k] = now;
            }
            saveFieldTs(fieldTs);
            enqueue('prayer_days', data);
        },
        enqueueGoalEvent(event) {
            if (!event.id) event.id = crypto.randomUUID();
            event.device_id = DEVICE_ID;
            event.client_ts = syncedNow();
            enqueue('goal_events', event);
        },
        enqueueGoalMeta(goalData) {
            goalData.updated_at = syncedNow();
            enqueue('goals', goalData);
        },
        enqueueSetting(key, value) {
            if (!SYNCED_SETTINGS.has(key)) return;
            const ts = syncedNow();
            const localTs = getSettingsTs();
            localTs[key] = ts;
            saveSettingsTs(localTs);
            enqueue('user_settings', { key, value, updated_at: ts });
        },
        // Constants
        SUPABASE_URL, SUPABASE_KEY, DEVICE_ID, SYNCED_SETTINGS,
        // Debug
        getLog() { return JSON.parse(localStorage.getItem(SYNC_LOG_KEY) || '[]'); },
    });
})();
