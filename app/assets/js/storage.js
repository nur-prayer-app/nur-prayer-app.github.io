/* ================================================================
   Storage Repository
   ================================================================
   Single point of persistence for the app. Every read/write goes
   through this module so the backend can be swapped without touching
   UI code.

   Current backends:
     - LocalStorageBackend  (default, browser)
     - ElectronBackend      (activates when window.electronAPI is present)

   Capacitor/SQLite backends will plug in here the same way.
   All methods are synchronous to match the existing app's expectations.
   ================================================================ */

(function () {
    'use strict';

    /* Keys the app persists. Centralized so migrations/backends can enumerate. */
    const KEYS = Object.freeze({
        THEME: 'prayer-theme',
        PRAYERS: 'prayer-data',
        QADAA: 'qadaa-data',
        GOALS: 'goals-data',
        GOALS_ARCHIVE: 'goals-archive',
        SETTINGS: 'app-settings',
        INSTALLED_AT: 'installed-at',
        // Legacy (read-only, migrated at init)
        LEGACY_FASTING: 'fasting-data',
    });

    /* JSON-shaped keys. Anything not listed is stored as a raw string. */
    const JSON_KEYS = new Set([
        KEYS.PRAYERS,
        KEYS.QADAA,
        KEYS.GOALS,
        KEYS.GOALS_ARCHIVE,
        KEYS.SETTINGS,
    ]);

    /* ─── Backend: localStorage ─────────────────────────────────── */
    const LocalStorageBackend = {
        name: 'localStorage',
        getItem(k)       { return localStorage.getItem(k); },
        setItem(k, v)    { localStorage.setItem(k, v); },
        removeItem(k)    { localStorage.removeItem(k); },
        listKeys() {
            const out = [];
            for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
            return out;
        },
    };

    /* ─── Backend: Electron (synchronous bridge) ────────────────────
       Activates when `window.electronAPI` exposes a sync key-value
       API. The Electron preload will implement this on top of
       better-sqlite3 with the following schema:

       CREATE TABLE IF NOT EXISTS kv (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL
       );

       The preload exposes:
         storageGetSync(k)        → SELECT value FROM kv WHERE key = ?
         storageSetSync(k, v)     → INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)
         storageDeleteSync(k)     → DELETE FROM kv WHERE key = ?
         storageListKeysSync()    → SELECT key FROM kv

       This gives us atomic writes, crash-safety (WAL mode), and
       easy export (dump the whole table as JSON). */
    const ElectronBackend = (() => {
        if (typeof window === 'undefined' || !window.electronAPI?.storageGetSync) return null;
        const api = window.electronAPI;
        return {
            name: 'electron-sqlite',
            getItem(k)    { return api.storageGetSync(k); },
            setItem(k, v) { api.storageSetSync(k, v); },
            removeItem(k) { api.storageDeleteSync(k); },
            listKeys()    { return api.storageListKeysSync() || []; },
        };
    })();

    const backend = ElectronBackend || LocalStorageBackend;

    /* ─── Public API ────────────────────────────────────────────── */
    function get(key, fallback) {
        const raw = backend.getItem(key);
        if (raw == null) return fallback;
        if (!JSON_KEYS.has(key)) return raw;
        try {
            let parsed = JSON.parse(raw);
            if (typeof parsed === 'string') parsed = JSON.parse(parsed);
            return parsed;
        }
        catch { return fallback; }
    }

    function set(key, value) {
        const payload = JSON_KEYS.has(key) ? JSON.stringify(value) : String(value);
        backend.setItem(key, payload);
    }

    function remove(key) { backend.removeItem(key); }

    /** Export all known keys as a single snapshot object — used by
     *  the Settings → Export flow. Reads raw values so import/export
     *  round-trips are byte-identical. */
    function exportAll() {
        const out = {};
        Object.values(KEYS).forEach(k => {
            const v = backend.getItem(k);
            if (v != null) out[k] = v;
        });
        return out;
    }

    /** Import a previously-exported snapshot. Raw values go in as-is. */
    function importAll(snapshot) {
        Object.entries(snapshot).forEach(([k, v]) => backend.setItem(k, v));
    }

    /** Wipe everything the app owns (Settings → Danger zone). */
    function clearAll() {
        Object.values(KEYS).forEach(k => backend.removeItem(k));
    }

    /** Record install timestamp on first run. Idempotent. */
    function ensureInstalledAt() {
        if (!backend.getItem(KEYS.INSTALLED_AT)) {
            backend.setItem(KEYS.INSTALLED_AT, new Date().toISOString());
        }
        return backend.getItem(KEYS.INSTALLED_AT);
    }

    window.Storage = Object.freeze({
        KEYS,
        backend: backend.name,
        get,
        set,
        remove,
        exportAll,
        importAll,
        clearAll,
        ensureInstalledAt,
    });
})();
