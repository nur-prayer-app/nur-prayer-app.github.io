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

    function getSession() {
        if (cachedSession) return cachedSession;
        try { cachedSession = JSON.parse(localStorage.getItem(SESSION_KEY)); return cachedSession; }
        catch { return null; }
    }

    function saveSession(session) {
        cachedSession = session;
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
            if (!resp.ok) { saveSession(null); window.dispatchEvent(new CustomEvent('sync-session-lost')); return null; }
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
            const payload = decodeJwtPayload(session.access_token);
            if (Date.now() > payload.exp * 1000 - 60000) session = await refreshToken();
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
        localStorage.removeItem(BOOTSTRAP_KEY);
        stopAutoSync();
    }

    async function signOutAll() {
        const token = await getValidToken();
        if (token) await fetch(`${AUTH_URL}/logout?scope=global`, { method: 'POST', headers: headers(token) }).catch(() => {});
        saveSession(null);
        localStorage.removeItem(LAST_SYNC_KEY);
        localStorage.removeItem(QUEUE_KEY);
        localStorage.removeItem(BOOTSTRAP_KEY);
        stopAutoSync();
    }

    /* ─── Offline Queue ────────────────────────────────────────── */

    function getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; } }
    function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }

    function enqueue(table, data) {
        const q = getQueue();
        q.push({ table, data, ts: syncedNow() });
        saveQueue(q);
    }

    /* ─── Field Timestamps (for prayer days LWW) ───────────────── */

    function getFieldTs() { try { return JSON.parse(localStorage.getItem(FIELD_TS_KEY)) || {}; } catch { return {}; } }
    function saveFieldTs(ts) { localStorage.setItem(FIELD_TS_KEY, JSON.stringify(ts)); }

    function stampField(dayKey, field) {
        const ts = getFieldTs();
        if (!ts[dayKey]) ts[dayKey] = {};
        ts[dayKey][field] = syncedNow();
        saveFieldTs(ts);
    }

    /* ─── Sync: Prayer Days ────────────────────────────────────── */

    const PRAYER_FIELDS = [
        'fajr', 'dhuhr', 'asr', 'maghrib', 'isha',
        'shafa_witr', 'qyaam', 'qyaam_rakaat', 'fasting', 'duha',
        'fajr_qadaa', 'dhuhr_qadaa', 'asr_qadaa', 'maghrib_qadaa', 'isha_qadaa', 'fasting_qadaa'
    ];

    // Map local field names to cloud column names
    const LOCAL_TO_CLOUD = { shafaWitr: 'shafa_witr', qyaamRakaat: 'qyaam_rakaat' };
    const CLOUD_TO_LOCAL = { shafa_witr: 'shafaWitr', qyaam_rakaat: 'qyaamRakaat' };
    // Qadaa field mapping
    const QADAA_LOCAL_TO_CLOUD = {};
    const QADAA_CLOUD_TO_LOCAL = {};
    ['fajr','dhuhr','asr','maghrib','isha'].forEach(p => {
        QADAA_LOCAL_TO_CLOUD[`${p}_qadaa_recorded`] = `${p}_qadaa`;
        QADAA_CLOUD_TO_LOCAL[`${p}_qadaa`] = `${p}_qadaa_recorded`;
    });

    function localFieldToCloud(f) { return QADAA_LOCAL_TO_CLOUD[f] || LOCAL_TO_CLOUD[f] || f; }
    function cloudFieldToLocal(f) { return QADAA_CLOUD_TO_LOCAL[f] || CLOUD_TO_LOCAL[f] || f; }

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
            if (!prayers[dayKey]) prayers[dayKey] = {};
            if (!fieldTs[dayKey]) fieldTs[dayKey] = {};
            const dd = prayers[dayKey];
            const localTs = fieldTs[dayKey];

            for (const cloudField of PRAYER_FIELDS) {
                const cloudTs = row[cloudField + '_at'] || 0;
                const localField = cloudFieldToLocal(cloudField);
                const myTs = localTs[localField] || 0;
                if (cloudTs > myTs) {
                    dd[localField] = row[cloudField];
                    localTs[localField] = cloudTs;
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
        for (const item of prayerItems) {
            const { day_key, ...fields } = item.data;
            const params = { p_user_id: userId, p_day_key: day_key };
            // Build RPC params — set 0 for unchanged fields
            for (const cf of PRAYER_FIELDS) {
                const localField = cloudFieldToLocal(cf);
                const ts = fieldTs[day_key]?.[localField] || 0;
                if (localField in fields) {
                    params[`p_${cf}`] = fields[localField];
                    params[`p_${cf}_at`] = ts;
                } else {
                    params[`p_${cf}`] = cf === 'qyaam_rakaat' ? 0 : false;
                    params[`p_${cf}_at`] = 0; // won't overwrite (0 < any real timestamp)
                }
            }

            const resp = await fetch(`${REST_URL}/rpc/upsert_prayer_day`, {
                method: 'POST', headers: headers(token), body: JSON.stringify({ payload: params }),
            });
            if (!resp.ok) return; // stop on failure, retry next cycle
        }
        // Remove flushed prayer items from queue
        const remaining = q.filter(i => i.table !== 'prayer_days');
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
            let local = localGoals.find(g => g.type === cg.goal_type && (g.createdAt || '') === (new Date(cg.updated_at || 0).toISOString()));
            if (!local) local = localGoals.find(g => g.type === cg.goal_type);
            if (!local) {
                // New goal from cloud
                local = { type: cg.goal_type, name: cg.name, total: cg.target_amount, remaining: cg.target_amount, notes: [], perPrayer: null, createdAt: new Date().toISOString() };
                localGoals.push(local);
                changed = true;
            }
            if (cg.target_amount > local.total) { local.total = cg.target_amount; changed = true; }
            if (cg.name !== local.name) { local.name = cg.name; changed = true; }
            if (cg.archived_at > 0 && !local.completed) { local.completed = true; local.archivedAt = new Date(cg.archived_at).toISOString(); changed = true; }
        }

        // Merge new events into local notes
        if (cloudEvents.length) {
            for (const ev of cloudEvents) {
                const goal = localGoals.find(g => g.type === ev.goal_key || (g.type + '') === ev.goal_key);
                if (!goal) continue;
                goal.notes = goal.notes || [];
                const exists = goal.notes.some(n => n.id === ev.id);
                if (!exists) {
                    goal.notes.push({
                        id: ev.id,
                        date: ev.created_at || new Date(ev.client_ts).toISOString(),
                        text: ev.note_text || '',
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

        // Push goal metadata
        if (goalMeta.length) {
            for (const item of goalMeta) {
                await fetch(`${REST_URL}/goals`, {
                    method: 'POST', headers: { ...headers(token), 'Prefer': 'resolution=merge-duplicates' },
                    body: JSON.stringify({ user_id: userId, ...item.data }),
                });
            }
        }

        // Push goal events (ON CONFLICT DO NOTHING — dedup by PK)
        if (goalItems.length) {
            const events = goalItems.map(i => ({ user_id: userId, ...i.data }));
            await fetch(`${REST_URL}/goal_events`, {
                method: 'POST',
                headers: { ...headers(token), 'Prefer': 'resolution=ignore-duplicates' },
                body: JSON.stringify(events),
            });
        }

        // Remove flushed items
        const remaining = q.filter(i => i.table !== 'goal_events' && i.table !== 'goals');
        saveQueue(remaining);
    }

    /* ─── Sync: Settings ───────────────────────────────────────── */

    const SYNCED_SETTINGS = new Set([
        'location', 'calcMethod', 'asrSchool', 'iqamaOffsets', 'timeAdjustments',
        'notifications', 'notifPreEnabled', 'notifPreMinutes', 'notifAdhanEnabled',
        'notifPreIqamaEnabled', 'notifPreIqamaMinutes', 'prayerNotifs',
        'autoMarkMissed', 'hijriOffset', 'trackLatePrayers',
    ]);

    async function pullSettings(token, userId) {
        const resp = await fetch(`${REST_URL}/user_settings?user_id=eq.${userId}&select=*`, { headers: headers(token) });
        if (!resp.ok) return false;
        const rows = await resp.json();
        if (!rows.length) return false;

        const settings = Storage.get(Storage.KEYS.SETTINGS, {});
        const localTs = JSON.parse(localStorage.getItem('nur-settings-ts') || '{}');
        let changed = false;

        for (const row of rows) {
            if (!SYNCED_SETTINGS.has(row.key)) continue;
            const cloudTs = row.updated_at || 0;
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
            localStorage.setItem('nur-settings-ts', JSON.stringify(localTs));
        }
        return changed;
    }

    async function flushSettingsQueue(token, userId) {
        const q = getQueue();
        const settingsItems = q.filter(i => i.table === 'user_settings');
        if (!settingsItems.length) return;

        for (const item of settingsItems) {
            const resp = await fetch(`${REST_URL}/user_settings`, {
                method: 'POST',
                headers: { ...headers(token), 'Prefer': 'resolution=merge-duplicates' },
                body: JSON.stringify({ user_id: userId, ...item.data }),
            });
            if (!resp.ok) return; // retry next cycle
        }

        const remaining = q.filter(i => i.table !== 'user_settings');
        saveQueue(remaining);
    }

    /* ─── Clock offset ─────────────────────────────────────────── */

    function updateClockOffset(resp) {
        const dateHeader = resp.headers.get('date');
        if (dateHeader) {
            const serverTime = new Date(dateHeader).getTime();
            if (!isNaN(serverTime)) clockOffset = serverTime - Date.now();
        }
    }

    /* ─── Bootstrap: enqueue all local data on first v2 sync ───── */

    const BOOTSTRAP_KEY = 'nur-sync-v2-bootstrapped';

    async function bootstrapIfCloudEmpty(token, userId) {
        if (localStorage.getItem(BOOTSTRAP_KEY)) return;

        // Check if cloud already has data — if so, skip bootstrap and just pull
        const checkResp = await fetch(
            `${REST_URL}/prayer_days?user_id=eq.${userId}&select=day_key&limit=1`,
            { headers: headers(token) }
        );
        if (!checkResp.ok) return; // network issue — retry next cycle
        updateClockOffset(checkResp);
        const rows = await checkResp.json();
        if (rows.length > 0) {
            // Cloud has data from another device — don't push, just pull
            localStorage.setItem(BOOTSTRAP_KEY, '1');
            return;
        }

        const now = syncedNow();
        const fieldTs = getFieldTs();

        // Enqueue all prayer days
        const prayers = Storage.get(Storage.KEYS.PRAYERS, {});
        for (const [dayKey, dd] of Object.entries(prayers)) {
            if (!dd || typeof dd !== 'object') continue;
            if (!fieldTs[dayKey]) fieldTs[dayKey] = {};
            const data = { day_key: dayKey };
            let hasFields = false;
            for (const [k, v] of Object.entries(dd)) {
                if (k.endsWith('_auto_missed') || k === '_localDirty') continue;
                data[k] = v;
                if (!fieldTs[dayKey][k]) fieldTs[dayKey][k] = now;
                hasFields = true;
            }
            if (hasFields) enqueue('prayer_days', data);
        }
        saveFieldTs(fieldTs);

        // Enqueue all goals metadata + events
        const goals = Storage.get(Storage.KEYS.GOALS, []);
        for (const g of goals) {
            if (!g || !g.type) continue;
            enqueue('goals', {
                goal_key: g.type,
                goal_type: g.type,
                name: g.name || g.type,
                target_amount: g.total || 0,
                archived_at: g.completed ? (new Date(g.archivedAt || 0).getTime()) : 0,
                updated_at: now,
            });
            if (Array.isArray(g.notes)) {
                for (const n of g.notes) {
                    enqueue('goal_events', {
                        id: n.id || crypto.randomUUID(),
                        goal_key: g.type,
                        amount: n.amount || 0,
                        note_text: n.text || null,
                        source_key: n.sourceKey || null,
                        prayer: n.prayer || null,
                        ref_event_id: n.refEventId || null,
                        device_id: DEVICE_ID,
                        client_ts: n.date ? new Date(n.date).getTime() : now,
                    });
                }
            }
        }

        // Enqueue all synced settings
        const settings = Storage.get(Storage.KEYS.SETTINGS, {});
        const settingsTs = JSON.parse(localStorage.getItem('nur-settings-ts') || '{}');
        for (const [key, value] of Object.entries(settings)) {
            if (!SYNCED_SETTINGS.has(key)) continue;
            if (!settingsTs[key]) settingsTs[key] = now;
            enqueue('user_settings', { key, value, updated_at: settingsTs[key] });
        }
        localStorage.setItem('nur-settings-ts', JSON.stringify(settingsTs));

        localStorage.setItem(BOOTSTRAP_KEY, '1');
    }

    /* ─── Sync orchestration ───────────────────────────────────── */

    async function syncAll() {
        if (isSyncing) return;
        isSyncing = true;
        try {
            const token = await getValidToken();
            if (!token) return;
            const session = getSession();
            if (!session?.user?.id) return;
            const userId = session.user.id;

            // Bootstrap: push all local data if cloud is empty (first v2 sync)
            await bootstrapIfCloudEmpty(token, userId);

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
        localStorage.removeItem(BOOTSTRAP_KEY);
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
            const localTs = JSON.parse(localStorage.getItem('nur-settings-ts') || '{}');
            localTs[key] = ts;
            localStorage.setItem('nur-settings-ts', JSON.stringify(localTs));
            enqueue('user_settings', { key, value, updated_at: ts });
        },
        // Constants
        SUPABASE_URL, SUPABASE_KEY, DEVICE_ID, SYNCED_SETTINGS,
    });
})();
