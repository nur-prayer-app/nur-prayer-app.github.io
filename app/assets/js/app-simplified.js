/* ================================================================
   Nur — Prayer Tracker Application
   Written from scratch. No legacy code.
   ================================================================ */
(function () {
    'use strict';

    const APP_VERSION = '1.1.211';
    const UPDATE_URL = 'https://nur-prayer-app.github.io/releases/version.json';

    /* ── Helpers ─────────────────────────────────────────────── */
    const $ = (s, c) => (c || document).querySelector(s);
    const $$ = (s, c) => [...(c || document).querySelectorAll(s)];
    const hk = (y, m, d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const esc = (s) => {
        if (!s) return '';
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    };

    /* ── State ───────────────────────────────────────────────────
       All persistence flows through the Storage repository (assets/js/storage.js),
       so the backend (localStorage → Electron SQLite → Capacitor SQLite) can swap
       without touching this file. */
    const KEYS = Storage.KEYS;
    const S = {
        theme: Storage.get(KEYS.THEME, 'default'),
        calY: 0, calM: 0,
        prayers: Storage.get(KEYS.PRAYERS, {}),
        qadaa:   Storage.get(KEYS.QADAA, {}),
        settings: Storage.get(KEYS.SETTINGS, {}),
        goalsArchive: Storage.get(KEYS.GOALS_ARCHIVE, []),
    };

    /* ── Install date (for auto-missed prayers) ─────────────── */
    Storage.ensureInstalledAt();

    const PRAYERS = [
        { id:'fajr',    name:'Fajr',    time:'5:15 AM' },
        { id:'dhuhr',   name:'Dhuhr',   time:'12:30 PM' },
        { id:'asr',     name:'Asr',     time:'3:45 PM' },
        { id:'maghrib', name:'Maghrib', time:'6:20 PM' },
        { id:'isha',    name:'Isha',    time:'8:00 PM' },
    ];
    /** Index lookup — avoids PRAYERS.find(p => p.id === id) repetition. */
    const PRAYERS_BY_ID = new Map(PRAYERS.map(p => [p.id, p]));
    const prayerById = (id) => PRAYERS_BY_ID.get(id);

    // Extra daily activities (tracked per-day in S.prayers[key])
    const EXTRAS = [
        { id:'qyaam',   name:'Qyaam',   time:'Night' },
        { id:'duha',    name:'Duha',    time:'Morning' },
        { id:'shafaWitr', name:"Shaf'a & Witr", time:'Night' },
        { id:'fasting', name:'Fasting', time:'All day' },
    ];

    const PRAYER_MAP = Object.fromEntries(PRAYERS.map(p => [p.id, p]));

    function prayerName(id, gregDate) {
        if (id === 'dhuhr' && gregDate && gregDate.getDay() === 5) return "Jumu'ah";
        return PRAYERS_BY_ID.get(id)?.name || id;
    }
    const isQadaaGoal = (g) => g.type === 'qadaa' || g.type === 'qadaa-auto';

    function todayKey() {
        const h = HijriCalendar.gregorianToHijri(new Date());
        return hk(h.year, h.month, h.day);
    }

    function computePassedPrayers(date) {
        const loc = S.settings.location;
        const passed = {};
        if (!loc) {
            PRAYERS.forEach(p => { passed[p.id] = true; });
        } else {
            const raw = computeRawTimesCached(loc.lat, loc.lng, date, getTimesOptions());
            PRAYERS.forEach(p => { passed[p.id] = raw[p.id] <= date; });
        }
        return passed;
    }

    function dashboardKey() {
        const now = new Date();
        const loc = S.settings.location;
        if (loc) {
            const fajr = computeRawTimesCached(loc.lat, loc.lng, now, getTimesOptions()).fajr;
            if (now < fajr) {
                const yesterday = new Date(now);
                yesterday.setDate(yesterday.getDate() - 1);
                const h = HijriCalendar.gregorianToHijri(yesterday);
                return hk(h.year, h.month, h.day);
            }
        }
        return todayKey();
    }

    const EMPTY_DAY = { fajr:false, dhuhr:false, asr:false, maghrib:false, isha:false, qyaam:false, qyaamRakaat:0, duha:false, shafaWitr:false, fasting:false };

    /** Get or create prayer data for a day (use when writing). */
    function dayData(key) {
        if (!S.prayers[key]) S.prayers[key] = { ...EMPTY_DAY };
        return S.prayers[key];
    }

    /** Read-only: get prayer data if it exists, else return the shared empty object. */
    function peekDay(key) {
        return S.prayers[key] || EMPTY_DAY;
    }

    function completed(d) { return PRAYERS.filter(p => d[p.id]).length; }
    /** Persist a top-level key through the Storage repository. */
    function save(k, v) { Storage.set(k, v); }

    /* ── Formatters ──────────────────────────────────────────
     * Shared date + Hijri formatters. Every call-site formats the same way,
     * so concentrating them here keeps output consistent and makes locale
     * changes a one-line edit. */
    const fmtShortDate = (d) => new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    const fmtLongDate  = (d) => new Date(d).toLocaleDateString('en-US', { month:'long',  day:'numeric', year:'numeric' });
    const fmtFullDate  = (d) => new Date(d).toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    const fmtDateTime  = (d) => new Date(d).toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });
    const fmtMonthYear = (d) => new Date(d).toLocaleDateString('en-US', { month:'long', year:'numeric' });
    const fmtMonthOnly = (d) => new Date(d).toLocaleDateString('en-US', { month:'long' });
    const fmtMonthShort = (d) => new Date(d).toLocaleDateString('en', { month:'short' });
    const fmtHijriLong = (h) => `${h.monthName} ${h.day}, ${h.year}`;
    const fmtHijriShort = (h) => `${h.monthName} ${h.day}`;
    /** Convert any Gregorian Date/ISO to Hijri in one step. */
    const toHijri = (d) => HijriCalendar.gregorianToHijri(new Date(d));

    /** Clear the auto-missed flag for `prayerId` on the Hijri day that `dateIso`
     *  falls on. Called when the user marks an auto-missed prayer as prayed or
     *  dismisses the goal. Idempotent — no-op if the flag is absent. */
    function clearAutoMissedFlag(prayerId, dateIso) {
        if (!prayerId || !dateIso) return;
        const mH = toHijri(dateIso);
        const dKey = hk(mH.year, mH.month, mH.day);
        const dd = S.prayers[dKey];
        if (dd && dd[`${prayerId}_auto_missed`]) {
            delete dd[`${prayerId}_auto_missed`];
            save(KEYS.PRAYERS, S.prayers);
        }
    }

    /* ── Dashboard ───────────────────────────────────────────── */
    function render() {
        const tk = dashboardKey();
        const dd = dayData(tk);
        const c  = completed(dd);

        renderPrayerList(tk, dd);
        renderPrayerRing(c);
        renderGoals();
        renderReminders();
        renderCalendar();
        updateTray();
    }

    /* ── Prayer List (icon grid) ────────────────────────────── */
    const PRAYER_ICONS = {
        fajr:    '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 1v3M21 12h-3M12 21v3M3 12h3" stroke="currentColor" stroke-width="1.5"/>',
        sunrise: '<circle cx="12" cy="16" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 5v3M4.22 11.22l2.12 2.12M19.78 11.22l-2.12 2.12M1 16h4M19 16h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
        dhuhr:   '<circle cx="12" cy="12" r="5" fill="currentColor"/><path d="M12 1v3M21 12h-3M12 21v3M3 12h3" stroke="currentColor" stroke-width="1.5"/>',
        asr:     '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l3 3" stroke="currentColor" stroke-width="1.5"/>',
        maghrib: '<path d="M17 18a5 5 0 0 0-10 0" stroke="currentColor" stroke-width="2"/><line x1="12" y1="9" x2="12" y2="3" stroke="currentColor" stroke-width="2"/>',
        isha:    '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/>',
    };

    function prayerIconSvg(id, size) {
        const s = size || 14;
        const icon = PRAYER_ICONS[id];
        return icon ? `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none">${icon}</svg>` : '';
    }

    function renderPrayerList(tk, dd) {
        const list = $('.prayer-card .prayer-list');
        if (!list) return;

        const [hy, hm, hd] = tk.split('-').map(Number);
        const gregDate = HijriCalendar.hijriToGregorian(hy, hm, hd);
        const isCurrentDay = tk === todayKey();
        const passed = isCurrentDay ? computePassedPrayers(new Date()) : {};
        if (!isCurrentDay) PRAYERS.forEach(p => { passed[p.id] = true; });

        list.innerHTML = PRAYERS.map(p => {
            const done = dd[p.id];
            const future = !passed[p.id] && !done;
            const name = prayerName(p.id, gregDate);
            return `
            <label class="prayer-icon-btn${done ? ' completed' : ''}${future ? ' future' : ''}" data-key="${tk}" data-prayer="${p.id}">
                <input type="checkbox" ${done ? 'checked' : ''} ${future ? 'disabled' : ''} aria-label="Mark ${name} as ${done ? 'incomplete' : 'complete'}">
                <div class="prayer-icon-circle">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">${done ? '<polyline points="20,6 9,17 4,12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' : PRAYER_ICONS[p.id]}</svg>
                </div>
                <span class="prayer-icon-name">${name}</span>
                <span class="prayer-icon-time">${p.time}</span>
            </label>`;
        }).join('');

        $$('input[type="checkbox"]', list).forEach(cb => {
            cb.addEventListener('change', () => {
                const item = cb.closest('.prayer-icon-btn');
                const key = item.dataset.key;
                const pid = item.dataset.prayer;
                const d = dayData(key);
                const wasOff = !d[pid];
                d[pid] = cb.checked;
                // If just marked prayed and it was auto-missed, clear the flag + resolve the goal
                if (wasOff && d[pid] && d[`${pid}_auto_missed`]) {
                    delete d[`${pid}_auto_missed`];
                    const matchingGoal = getGoals().find(g => {
                        if (g.type !== 'qadaa-auto' || !g.missedOn) return false;
                        const gh = toHijri(g.missedOn);
                        const [y, m, day] = key.split('-').map(Number);
                        return gh.year === y && gh.month === m && gh.day === day
                            && ((g.perPrayer && g.perPrayer[pid] > 0) || g.missedPrayer === pid);
                    });
                    if (matchingGoal) recordQadaaPrayers(matchingGoal, pid, 1);
                }
                save(KEYS.PRAYERS, S.prayers);
                render();
            });
        });
    }

    /* ── Prayer Ring ──────────────────────────────────────────── */
    function renderPrayerRing(c) {
        const ring = $('#main-progress-ring');
        const num  = $('#main-prayer-count');
        if (ring) {
            const circ = 2 * Math.PI * 54; // r=54 (matches SVG)
            ring.style.strokeDasharray = circ;
            ring.style.strokeDashoffset = circ - (c / 5) * circ;
        }
        if (num) num.textContent = c;
    }

    /* ── Goals ───────────────────────────────────────────────── */
    // perDay: how many units one complete day worth equals (used by Record Full Day)
    // unitName: singular noun for the goal
    const GOAL_TYPES = {
        qadaa:         { name: 'Qadaa Prayers',    perDay: 5, unitName: 'prayer', icon: '<path d="M12 2L15.09 8.26L22 9L16 14.74L17.18 21.02L12 18L6.82 21.02L8 14.74L2 9L8.91 8.26L12 2Z" stroke="currentColor" stroke-width="1.5" fill="none"/>', css: 'goal-qadaa', fill: 'fill-blue', unit: 'prayers' },
        'qadaa-auto':  { name: 'Auto-missed',      perDay: 5, unitName: 'prayer', icon: '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>', css: 'goal-qadaa-auto', fill: 'fill-danger', unit: 'prayers' },
        'qadaa-fast':  { name: 'Qadaa Fasting',    perDay: 1, unitName: 'day',    icon: '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M12 8v8" stroke="currentColor" stroke-width="1.5"/>', css: 'goal-fasting', fill: 'fill-warn', unit: 'days' },
        qyaam:         { name: 'Qyaam Prayers',    perDay: 1, unitName: 'night',  icon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/>', css: 'goal-qyaam', fill: 'fill-purple', unit: 'nights' },
        quran:         { name: 'Quran Pages',      perDay: 1, unitName: 'page',   icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" stroke="currentColor" stroke-width="1.5"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15z" stroke="currentColor" stroke-width="1.5"/>', css: 'goal-quran', fill: 'fill-green', unit: 'pages' },
        custom:        { name: 'Custom',           perDay: 1, unitName: 'unit',   icon: '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.5"/>', css: 'goal-custom', fill: 'fill-gradient', unit: '' },
    };

    function getGoals() {
        if (!S.goals) S.goals = Storage.get(KEYS.GOALS, []);
        return S.goals;
    }

    function saveGoals() { save(KEYS.GOALS, S.goals); }

    function renderGoals() {
        const list = $('#goals-list');
        if (!list) return;
        // Auto-archive any goal whose remaining just hit 0 — keeps the active list tidy
        // and preserves the goal (with completed: true) for statistics.
        archiveCompletedGoals();
        const allGoals = getGoals();
        // Show all goals including qadaa-auto (it will render with a special "auto" badge)
        const goals = allGoals;
        const archiveCount = (S.goalsArchive || []).length;

        let html = '';

        if (goals.length === 0) {
            html += `<div class="goals-empty">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="6" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>
                <span>No goals yet</span></div>`;
        } else {
            html += goals.map((g) => {
                const realIdx = allGoals.indexOf(g);
                const type = GOAL_TYPES[g.type] || GOAL_TYPES.custom;
                const done = g.total - g.remaining;
                const pct = g.total > 0 ? Math.round((done / g.total) * 100) : 0;
                const finished = g.remaining <= 0;
                const isAutoType = g.type === 'qadaa-auto';
                const showAutoTag = isAutoType && !g.isManual;
                // For AUTO (not manual) qadaa-auto goals, fold the origin date into the title as
                // "X days ago" so we don't add an extra row that inflates the card. Manual entries
                // are a pure "pay back a missed prayer" goal — no day-of-origin, so no suffix.
                let displayName = esc(g.name) || type.name;
                if (isAutoType && !g.isManual && g.missedOn) {
                    const nowStart = new Date(); nowStart.setHours(0,0,0,0);
                    const missedStart = new Date(g.missedOn); missedStart.setHours(0,0,0,0);
                    const daysAgo = Math.round((nowStart - missedStart) / (24 * 3600 * 1000));
                    const when = daysAgo === 0 ? 'today'
                        : daysAgo === 1 ? 'yesterday'
                        : daysAgo > 0 ? `${daysAgo} days ago`
                        : '';
                    if (when) displayName = `${esc(g.name) || type.name} from ${when}`;
                }
                return `
                <div class="goal-row${isAutoType ? (g.isManual ? ' goal-row-manual' : ' goal-row-auto') : ''}" data-idx="${realIdx}" role="button" tabindex="0">
                    <div class="goal-icon ${type.css}">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">${type.icon}</svg>
                    </div>
                    <div class="goal-info">
                        <div class="goal-name">
                            ${displayName}
                            ${showAutoTag ? '<span class="goal-auto-tag" title="System-created from auto-missed prayers">AUTO</span>' : ''}
                        </div>
                        <div class="goal-progress-text">${finished ? 'Complete!' : `${done} / ${g.total} ${type.unit}`}</div>
                        <div class="goal-bar"><div class="goal-bar-fill ${type.fill}" style="width:${pct}%"></div></div>
                    </div>
                    <svg class="goal-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <polyline points="9,6 15,12 9,18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </div>`;
            }).join('');
        }

        if (archiveCount > 0) {
            const archiveStyle = getSetting('archiveStyle', 'modal');
            if (archiveStyle === 'inline') {
                html += `<div class="goals-inline-archive" id="goals-inline-archive">
                    <div class="goals-inline-archive-head">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        Archive (${archiveCount})
                    </div>
                    ${(S.goalsArchive || []).map((g, i) => {
                        const type = GOAL_TYPES[g.type] || GOAL_TYPES.custom;
                        const done = g.total - g.remaining;
                        const pct = g.total > 0 ? Math.round((done / g.total) * 100) : 0;
                        return `
                        <div class="archive-row inline" data-aidx="${i}">
                            <div class="goal-icon ${type.css}">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">${type.icon}</svg>
                            </div>
                            <div class="goal-info">
                                <div class="goal-name">${esc(g.name) || type.name}</div>
                                <div class="goal-progress-text">${done} / ${g.total} · ${pct}%</div>
                            </div>
                            <button type="button" class="archive-action archive-restore" data-aidx="${i}" title="Restore">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                            </button>
                            <button type="button" class="archive-action archive-delete" data-aidx="${i}" title="Delete forever">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                            </button>
                        </div>`;
                    }).join('')}
                </div>`;
            } else {
                html += `<button type="button" class="goals-archive-link" id="goals-archive-link">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    <span>View archive (${archiveCount})</span>
                </button>`;
            }
        }

        list.innerHTML = html;

        // Click row to open detail (event delegation — attached once per list element)
        if (!list.dataset.delegated) {
            list.dataset.delegated = '1';
            list.addEventListener('click', (e) => {
                const row = e.target.closest('.goal-row');
                if (!row || !list.contains(row)) return;
                // Ignore clicks inside inline-archive action buttons
                if (e.target.closest('.archive-action')) return;
                const idx = parseInt(row.dataset.idx);
                if (isNaN(idx)) return;
                openGoalDetail(idx);
            });
        }

        $('#goals-archive-link')?.addEventListener('click', openArchiveModal);

        // Inline archive actions
        $$('.archive-row.inline .archive-restore', list).forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const i = parseInt(btn.dataset.aidx);
                const restored = S.goalsArchive.splice(i, 1)[0];
                delete restored.archivedAt;
                save(KEYS.GOALS_ARCHIVE, S.goalsArchive);
                getGoals().push(restored);
                saveGoals();
                renderGoals();
                toast('Goal restored');
            });
        });
        $$('.archive-row.inline .archive-delete', list).forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                if (!btn.classList.contains('confirm')) {
                    btn.classList.add('confirm');
                    btn.style.color = 'var(--accent-danger)';
                    setTimeout(() => { btn.classList.remove('confirm'); btn.style.color = ''; }, 3000);
                    return;
                }
                const i = parseInt(btn.dataset.aidx);
                S.goalsArchive.splice(i, 1);
                save(KEYS.GOALS_ARCHIVE, S.goalsArchive);
                renderGoals();
            });
        });
    }

    /* ── Add Goal Modal (calculator) ─────────────────────────── */
    function openAddGoalModal(opts = {}) {
        clearModalHeaderActions();
        const modal = $('#modal-backdrop');
        const content = $('#modal-content');
        if (!modal || !content) return;

        const backToDay = opts.backToDay || null;
        $('#modal-title').textContent = 'Add Goal';

        // Period unit multipliers (in days)
        const UNIT_DAYS = { day: 1, week: 7, month: 30, year: 365 };

        content.innerHTML = `
            <div class="add-goal-modal">
                <div class="settings-section">
                    <h4>Goal type</h4>
                    <div class="goal-type-grid">
                        ${Object.entries(GOAL_TYPES).filter(([key]) => key !== 'qadaa-auto').map(([key, t]) => `
                        <button type="button" class="goal-type-btn${key === 'qadaa' ? ' active' : ''}" data-type="${key}">
                            <span class="goal-type-icon ${t.css}">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">${t.icon}</svg>
                            </span>
                            <span class="goal-type-name">${t.name}</span>
                        </button>`).join('')}
                    </div>
                </div>

                <div class="settings-section" id="goal-name-section" style="display:none">
                    <h4>Goal name</h4>
                    <input type="text" id="goal-name-input" class="app-input" placeholder="e.g. Dhikr 1000x">
                </div>

                <div class="settings-section">
                    <h4 id="calc-header">How many days?</h4>
                    <div class="calc-row">
                        <div class="num-stepper">
                            <button type="button" class="num-stepper-btn" data-step="-1" aria-label="Decrease">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
                            </button>
                            <input type="number" id="calc-amount" min="1" max="9999" value="1" class="num-stepper-input">
                            <button type="button" class="num-stepper-btn" data-step="1" aria-label="Increase">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
                            </button>
                        </div>
                        <div class="calc-unit-group">
                            <button type="button" class="calc-unit-btn active" data-unit="day">Days</button>
                            <button type="button" class="calc-unit-btn" data-unit="week">Weeks</button>
                            <button type="button" class="calc-unit-btn" data-unit="month">Months</button>
                            <button type="button" class="calc-unit-btn" data-unit="year">Years</button>
                        </div>
                    </div>
                    <div class="calc-preview">
                        <span>=</span>
                        <strong id="calc-result">5</strong>
                        <span id="calc-unit-label">prayers</span>
                    </div>
                    <div class="calc-pace" id="calc-pace">
                        <div class="calc-pace-row"><span class="pace-label" id="pace1-label">At 1/day</span><span id="calc-pace1">—</span></div>
                        <div class="calc-pace-row"><span class="pace-label" id="pace5-label">At 5/day</span><span id="calc-pace5">—</span></div>
                    </div>
                </div>

                <div class="settings-section" id="single-prayer-section">
                    <h4>Quick add missed</h4>
                    <div class="single-prayer-row">
                        ${PRAYERS.map(p => `<button type="button" class="single-prayer-btn" data-prayer="${p.id}" title="Add 1 ${p.name}"><span>${p.name}</span></button>`).join('')}
                    </div>
                </div>

                <div class="goal-modal-actions">
                    <button type="button" class="btn btn-secondary" id="goal-cancel">${backToDay ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="margin-right:4px"><polyline points="15,18 9,12 15,6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Back' : 'Cancel'}</button>
                    <button type="button" class="btn btn-primary" id="goal-save">Add Goal</button>
                </div>
            </div>`;

        let selectedType = 'qadaa';
        let selectedUnit = 'day';

        function refreshCalc() {
            const amount = parseInt($('#calc-amount')?.value) || 0;
            const t = GOAL_TYPES[selectedType];
            // Quran/Custom: amount IS the total (no day multiplier)
            const isDirect = selectedType === 'quran' || selectedType === 'custom';
            const days = isDirect ? amount : amount * UNIT_DAYS[selectedUnit];
            const total = isDirect ? amount : days * t.perDay;
            const result = $('#calc-result');
            const label = $('#calc-unit-label');
            const unitGroup = $('.calc-unit-group');
            const previewEl = $('.calc-preview');
            const calcHeader = $('#calc-header');
            const pace1Label = $('#pace1-label');
            const pace5Label = $('#pace5-label');
            if (unitGroup) unitGroup.style.display = isDirect ? 'none' : '';
            if (previewEl) previewEl.style.display = isDirect ? 'none' : '';
            if (calcHeader) {
                if (selectedType === 'quran') calcHeader.textContent = 'How many pages?';
                else if (selectedType === 'custom') calcHeader.textContent = 'Total count';
                else if (selectedType === 'qadaa-fast') calcHeader.textContent = 'How many days?';
                else calcHeader.textContent = 'How many days?';
            }
            const unitLabel = isDirect ? (selectedType === 'quran' ? 'pages' : 'units') : (t.unit || t.unitName);
            if (pace1Label) pace1Label.textContent = isDirect ? `At 1/${unitLabel.slice(0,-1)}/day` : 'At 1/day';
            if (pace5Label) pace5Label.textContent = isDirect ? `At 5/${unitLabel.slice(0,-1)}/day` : 'At 5/day';
            if (result) result.textContent = total.toLocaleString();
            if (label) label.textContent = unitLabel;
            const pace1 = Math.ceil(total / 1);
            const pace5 = Math.ceil(total / 5);
            const d1 = new Date(); d1.setDate(d1.getDate() + pace1);
            const d5 = new Date(); d5.setDate(d5.getDate() + pace5);
            const e1 = $('#calc-pace1'); if (e1) e1.textContent = total > 0 ? `${fmtShortDate(d1)} · ${pace1}d` : '—';
            const e5 = $('#calc-pace5'); if (e5) e5.textContent = total > 0 ? `${fmtShortDate(d5)} · ${pace5}d` : '—';
        }

        // Goal type selection
        $$('.goal-type-btn', content).forEach(btn => {
            btn.addEventListener('click', () => {
                $$('.goal-type-btn', content).forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                selectedType = btn.dataset.type;
                $('#goal-name-section').style.display = selectedType === 'custom' ? '' : 'none';
                // Hide single-prayer buttons except for qadaa
                $('#single-prayer-section').style.display = selectedType === 'qadaa' ? '' : 'none';
                refreshCalc();
            });
        });

        // Unit buttons
        $$('.calc-unit-btn', content).forEach(btn => {
            btn.addEventListener('click', () => {
                $$('.calc-unit-btn', content).forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                selectedUnit = btn.dataset.unit;
                refreshCalc();
            });
        });

        // Amount input
        $('#calc-amount')?.addEventListener('input', refreshCalc);

        // Stepper +/- buttons
        $$('.num-stepper-btn', content).forEach(btn => {
            btn.addEventListener('click', () => {
                const inp = $('#calc-amount');
                if (!inp) return;
                const step = parseInt(btn.dataset.step);
                const cur = parseInt(inp.value) || 0;
                const next = Math.max(1, Math.min(9999, cur + step));
                inp.value = next;
                refreshCalc();
            });
        });

        // Multi-select single-prayer: toggle highlight on click, commit on save.
        // Selected prayers become individual "Missed X" goals at save time.
        const selectedSingles = new Set();
        $$('.single-prayer-btn', content).forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const pid = btn.dataset.prayer;
                if (selectedSingles.has(pid)) {
                    selectedSingles.delete(pid);
                    btn.classList.remove('selected');
                } else {
                    selectedSingles.add(pid);
                    btn.classList.add('selected');
                }
                const saveBtn = $('#goal-save');
                if (saveBtn) {
                    if (selectedSingles.size > 0) {
                        saveBtn.textContent = `Add ${selectedSingles.size} missed prayer${selectedSingles.size === 1 ? '' : 's'}`;
                    } else {
                        saveBtn.textContent = 'Add Goal';
                    }
                }
            });
        });

        $('#goal-cancel')?.addEventListener('click', () => {
            if (backToDay) openDayModal(backToDay);
            else closeAllModals();
        });

        $('#goal-save')?.addEventListener('click', () => {
            // Priority 1: highlighted single prayers
            // - 1 selected → single per-prayer missed goal (manual flag)
            // - 2+ selected → ONE combined manual qadaa goal with those prayers counted
            //   (auto-missed is always split per-prayer, but manual batches stay together
            //   because user intent is a single event — "I missed these today")
            if (selectedSingles.size > 0) {
                const now = new Date().toISOString();
                const selected = [...selectedSingles];

                if (selected.length === 1) {
                    addAutoMissedGoal(selected[0], now, { manual: true });
                } else {
                    // Build one combined manual qadaa goal
                    const greg = new Date(now);
                    const dateLabel = fmtShortDate(greg);
                    const hijriLabel = fmtHijriShort(toHijri(greg));
                    const prayerNames = selected
                        .map(pid => PRAYER_MAP[pid]?.name)
                        .filter(Boolean);
                    const goalName = `Missed ${prayerNames.join(' & ')} · ${dateLabel}`;
                    const perPrayer = { fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 };
                    selected.forEach(pid => { perPrayer[pid] = 1; });
                    const total = selected.length;

                    getGoals().push({
                        type: 'qadaa',
                        name: goalName,
                        total,
                        remaining: total,
                        perPrayer,
                        isManualBatch: true,
                        missedOn: now,
                        notes: [{
                            date: now,
                            text: `Added missed ${prayerNames.join(', ')}`,
                            amount: total,
                        }],
                        createdAt: now,
                    });
                    saveGoals();
                }

                closeAllModals();
                renderGoals();
                const n = selected.length;
                toast(`${n} missed added`);
                return;
            }

            // Priority 2: regular goal from calculator
            const amount = parseInt($('#calc-amount')?.value) || 0;
            const t = GOAL_TYPES[selectedType];
            const isDirect = selectedType === 'quran' || selectedType === 'custom';
            const days = isDirect ? amount : amount * UNIT_DAYS[selectedUnit];
            const total = isDirect ? amount : days * t.perDay;
            if (total <= 0) return;
            const goals = getGoals();
            const name = selectedType === 'custom' ? ($('#goal-name-input')?.value || 'Custom Goal') : t.name;
            const goal = { type: selectedType, name, total, remaining: total, createdAt: new Date().toISOString(), notes: [] };
            // For qadaa goals, seed perPrayer so each prayer gets its share
            if (selectedType === 'qadaa') {
                const perP = Math.ceil(total / 5);
                goal.perPrayer = { fajr: perP, dhuhr: perP, asr: perP, maghrib: perP, isha: perP };
            }
            goals.push(goal);
            saveGoals();
            if (backToDay) openDayModal(backToDay);
            else closeAllModals();
            renderGoals();
            toast(`Goal added: ${name}`);
        });

        refreshCalc();
        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
    }

    /* ── Auto-missed Goal Detail (focused: 1 prayer + date) ──── */
    function openAutoMissedGoalDetail(idx, opts = {}) {
        const goals = getGoals();
        const g = goals[idx];
        if (!g) return;

        const backToDay = opts.backToDay || null;

        const modal = $('#modal-backdrop');
        const content = $('#modal-content');
        if (!modal || !content) return;

        const pid = g.missedPrayer;
        const p = PRAYER_MAP[pid] || PRAYERS[0];
        // Labels recomputed fresh from `missedOn` so stale cached strings
        // (from old algorithm runs / seed data) can't drift from the current calendar.
        let dateLabel = '—';
        let hijriLabel = '';
        if (g.missedOn) {
            dateLabel = fmtLongDate(g.missedOn);
            hijriLabel = fmtHijriLong(toHijri(g.missedOn));
        } else if (g.missedOnLabel) {
            dateLabel = g.missedOnLabel;
            hijriLabel = g.missedOnHijri || '';
        }
        const isComplete = g.remaining <= 0;

        $('#modal-title').textContent = `Missed ${p.name}`;
        clearModalHeaderActions();

        content.innerHTML = `
            <div class="automiss-detail">
                <div class="automiss-hero pp-${pid}">
                    <div class="automiss-icon pp-circle pp-${pid}">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none">${PRAYER_ICONS[pid]}</svg>
                    </div>
                    <div class="automiss-prayer">${p.name}</div>
                    <div class="automiss-tag">
                        ${g.isManual ? '' : '<span class="goal-auto-tag">AUTO</span>'}
                        <span class="automiss-status">${isComplete ? '✓ Prayed' : 'Pending'}</span>
                    </div>
                </div>

                <div class="automiss-meta">
                    ${!g.isManual ? `
                    <div class="automiss-meta-row">
                        <span class="automiss-meta-label">Prayer date</span>
                        <span class="automiss-meta-value">${dateLabel}${hijriLabel ? ` · ${hijriLabel}` : ''}</span>
                    </div>` : ''}
                    <div class="automiss-meta-row">
                        <span class="automiss-meta-label">Prayer time</span>
                        <span class="automiss-meta-value">${p.time}</span>
                    </div>
                    ${g.createdAt ? `
                    <div class="automiss-meta-row">
                        <span class="automiss-meta-label">Added</span>
                        <span class="automiss-meta-value">${fmtDateTime(g.createdAt)}</span>
                    </div>` : ''}
                </div>

                <p class="settings-hint automiss-note">${g.isManual
                    ? `Mark as prayed when you make it up.`
                    : `Already prayed? Mark it. Otherwise record when you make it up.`
                }</p>

                <div class="automiss-actions">
                    ${isComplete ? `
                    <div class="automiss-complete-pill">✓ Prayed — goal complete</div>
                    ` : `
                    <button type="button" class="btn btn-primary automiss-record-btn" id="am-record">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><polyline points="20,6 9,17 4,12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        I prayed it
                    </button>
                    <button type="button" class="btn btn-secondary" id="am-forgot">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 3-3 3M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                        I didn't pray (keep tracking)
                    </button>
                    `}
                </div>

                ${g.notes && g.notes.filter(Boolean).length > 0 ? `
                <div class="settings-section">
                    <h4>Activity</h4>
                    <div class="goal-notes">
                        ${g.notes.map((n, i) => ({ n, i })).filter(x => x.n).slice(-5).reverse().map(({ n, i }) => {
                            const text = n.text || '—';
                            const dateStr = n.date ? fmtShortDate(n.date) : '';
                            return `<button type="button" class="goal-note" data-note-idx="${i}">
                                <div class="goal-note-body">
                                    <span class="goal-note-text">${text}</span>
                                    <span class="goal-note-date">${dateStr}</span>
                                </div>
                                <span class="goal-note-undo" aria-hidden="true">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 14l-4-4 4-4M5 10h9a5 5 0 0 1 0 10h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                                </span>
                            </button>`;
                        }).join('')}
                    </div>
                </div>` : ''}

                <div class="goal-danger-zone">
                    <button type="button" class="btn-danger-ghost" id="am-delete">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                        <span>Dismiss this goal</span>
                    </button>
                </div>

                ${(() => {
                    const bt = resolveBackTarget(backToDay);
                    return bt ? `
                <div class="goal-modal-actions">
                    <button type="button" class="btn btn-secondary" id="am-back" style="flex:1">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="margin-right:4px"><polyline points="15,18 9,12 15,6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        ${bt.label}
                    </button>
                </div>` : '';
                })()}
            </div>`;

        const reopen = () => openAutoMissedGoalDetail(idx, { backToDay });

        // Back button (if a back target was provided)
        {
            const bt = resolveBackTarget(backToDay);
            if (bt) $('#am-back')?.addEventListener('click', bt.run);
        }

        // "I prayed it" — clears the goal AND clears the auto-missed flag on the day so
        // the calendar's MISSED badge disappears immediately (no page refresh needed).
        $('#am-record')?.addEventListener('click', () => {
            g.remaining = 0;
            if (g.perPrayer) g.perPrayer[pid] = 0;
            g.notes = g.notes || [];
            g.notes.push({
                date: new Date().toISOString(),
                text: `Prayed ${p.name}`,
                amount: -1,
                prayer: pid,
            });
            clearAutoMissedFlag(pid, g.missedOn);
            saveGoals();
            reopen();
            renderGoals();
            renderCalendar();
            toast(`${p.name} recorded`);
        });

        // "I didn't pray" — closes modal (goal stays)
        $('#am-forgot')?.addEventListener('click', () => {
            closeAllModals();
        });

        // Per-row undo in activity list
        $$('.goal-note', content).forEach(btn => {
            btn.addEventListener('click', () => {
                const noteIdx = parseInt(btn.dataset.noteIdx);
                const note = (g.notes || [])[noteIdx];
                if (!note) return;
                // Undo: reverse the amount (negative amount was a record → add back)
                const reverse = -note.amount;
                g.remaining = Math.max(0, Math.min(g.total, g.remaining + reverse));
                if (g.perPrayer && note.prayer && g.perPrayer[note.prayer] !== undefined) {
                    g.perPrayer[note.prayer] = Math.max(0, g.perPrayer[note.prayer] + reverse);
                }
                g.notes.splice(noteIdx, 1);
                saveGoals();
                reopen();
                renderGoals();
                toast('Undone');
            });
        });

        // Dismiss with confirm
        $('#am-delete')?.addEventListener('click', () => {
            const btn = $('#am-delete');
            if (!btn.classList.contains('confirm')) {
                btn.classList.add('confirm');
                btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> <span>Tap again to confirm</span>';
                setTimeout(() => {
                    if (btn && btn.classList.contains('confirm')) {
                        btn.classList.remove('confirm');
                        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> <span>Dismiss this goal</span>';
                    }
                }, 3000);
                return;
            }
            S.goalsArchive = S.goalsArchive || [];
            S.goalsArchive.push({ ...g, archivedAt: new Date().toISOString() });
            save(KEYS.GOALS_ARCHIVE, S.goalsArchive);
            goals.splice(idx, 1);
            clearAutoMissedFlag(g.missedPrayer, g.missedOn);
            saveGoals();
            closeAllModals();
            renderGoals();
            renderCalendar();
            toast('Dismissed', { label: 'Undo', fn: () => {
                const restored = S.goalsArchive.pop();
                save(KEYS.GOALS_ARCHIVE, S.goalsArchive);
                getGoals().push(restored);
                saveGoals();
                renderGoals();
                renderCalendar();
            } });
        });

        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
    }

    /* ── Goal Detail (click row) ────────────────────────────── */
    function openGoalDetail(idx, opts = {}) {
        const goals = getGoals();
        const g = goals[idx];
        if (!g) return;

        // Per-prayer auto-missed goals get a focused detail view
        if (g.type === 'qadaa-auto') return openAutoMissedGoalDetail(idx, opts);

        const backToDay = opts.backToDay || null;

        const type = GOAL_TYPES[g.type] || GOAL_TYPES.custom;
        const done = g.total - g.remaining;
        const pct = g.total > 0 ? Math.round((done / g.total) * 100) : 0;

        const modal = $('#modal-backdrop');
        const content = $('#modal-content');
        if (!modal || !content) return;

        $('#modal-title').textContent = g.name || type.name;
        clearModalHeaderActions();

        // Pace forecasts
        function forecastAt(rate) {
            const days = g.remaining > 0 ? Math.ceil(g.remaining / rate) : 0;
            const d = new Date();
            d.setDate(d.getDate() + days);
            return { days, date: fmtLongDate(d) };
        }
        const isQadaa = isQadaaGoal(g);

        // Pace options customized per goal type
        const PACE_PROFILES = {
            qadaa:        [{ rate: 1, label: 'At 1/day' }, { rate: 5, label: 'At 5/day (1 full day)' }],
            'qadaa-auto': [{ rate: 1, label: 'At 1/day' }],
            'qadaa-fast': [{ rate: 1, label: 'At 1/day' }, { rate: 2, label: 'At 2/week', divisor: 3.5 }],
            qyaam:        [{ rate: 1, label: 'At 1 night/day' }, { rate: 2, label: 'At 2 nights/week', divisor: 3.5 }],
            quran:        [{ rate: 1, label: 'At 1 page/day' }, { rate: 5, label: 'At 5 pages/day' }, { rate: 20, label: 'At 20 pages/day (khatm in 30 days)' }],
            custom:       [{ rate: 1, label: 'At 1/day' }, { rate: 7, label: 'At 7/week', divisor: 1 }],
        };
        const paces = (PACE_PROFILES[g.type] || PACE_PROFILES.custom).map(p => ({ ...p, ...forecastAt(p.divisor ? p.rate / p.divisor : p.rate) }));

        content.innerHTML = `
            <div class="goal-detail">
                <div class="goal-detail-header">
                    <div class="goal-detail-num"><strong>${done}</strong> / ${g.total} <span>${type.unit || type.unitName}</span></div>
                    <div class="goal-detail-sub">${pct}% complete</div>
                    <div class="goal-bar goal-bar-lg"><div class="goal-bar-fill ${type.fill}" style="width:${pct}%"></div></div>
                </div>

                ${g.remaining > 0 && paces.length > 0 ? `
                <div class="goal-pace-list">
                    ${paces.map(p => `
                    <div class="goal-pace-row">
                        <span class="pace-label">${p.label}</span>
                        <span class="pace-date"><strong>${p.date}</strong></span>
                        <span class="pace-days">${p.days} ${p.days === 1 ? 'day' : 'days'}</span>
                    </div>`).join('')}
                </div>` : ''}

                ${isQadaa ? (() => {
                    ensurePerPrayer(g);
                    return `
                    <div class="settings-section">
                        <h4>Per-prayer breakdown</h4>
                        <div class="pp-compact-grid">
                            ${PRAYERS.map(p => {
                                const left = g.perPrayer[p.id] || 0;
                                const disabled = left <= 0;
                                return `
                                <div class="pp-cell">
                                    <button type="button" class="pp-tap${disabled ? ' disabled' : ''}" data-prayer="${p.id}" ${disabled ? 'disabled' : ''} title="Record 1 ${p.name}">
                                        <div class="pp-circle pp-${p.id}">
                                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">${PRAYER_ICONS[p.id]}</svg>
                                        </div>
                                        <span class="pp-name">${p.name}</span>
                                    </button>
                                    <div class="pp-row">
                                        <button type="button" class="pp-step" data-pp-step="-1" data-prayer="${p.id}" aria-label="Decrease ${p.name}" ${left <= 0 ? 'disabled' : ''}>−</button>
                                        <span class="pp-count">${left}</span>
                                        <button type="button" class="pp-step" data-pp-step="1" data-prayer="${p.id}" aria-label="Increase ${p.name}">+</button>
                                    </div>
                                </div>`;
                            }).join('')}
                        </div>
                        <div class="goal-bulk-row">
                            <button type="button" class="btn btn-primary goal-fullday" data-days="1" ${g.remaining <= 0 ? 'disabled' : ''}>1 day</button>
                            <button type="button" class="btn btn-secondary goal-fullday" data-days="2" ${g.remaining < 10 ? 'disabled' : ''}>2 days</button>
                            <button type="button" class="btn btn-secondary goal-fullday" data-days="3" ${g.remaining < 15 ? 'disabled' : ''}>3 days</button>
                        </div>
                    </div>
                    `;
                })() : `
                <div class="goal-bulk-row">
                    <button type="button" class="btn btn-primary" id="goal-record-one" ${g.remaining <= 0 ? 'disabled' : ''}>+1</button>
                    <button type="button" class="btn btn-secondary" id="goal-record-3" ${g.remaining < 3 ? 'disabled' : ''}>+3</button>
                    <button type="button" class="btn btn-secondary" id="goal-record-5" ${g.remaining < 5 ? 'disabled' : ''}>+5</button>
                    <button type="button" class="btn btn-secondary" id="goal-record-10" ${g.remaining < 10 ? 'disabled' : ''}>+10</button>
                </div>
                `}

                ${g.notes && g.notes.filter(Boolean).length > 0 ? `
                <div class="settings-section">
                    <h4>Recent activity <span class="info-tip" data-hint="Tap any row to undo that action.">?</span></h4>
                    <div class="goal-notes">
                        ${g.notes.map((n, i) => ({ n, i })).filter(x => x.n).slice(-8).reverse().map(({ n, i }) => {
                            const text = n.text || '—';
                            const dateStr = n.date ? fmtShortDate(n.date) : '';
                            return `<button type="button" class="goal-note" data-note-idx="${i}" title="Tap to undo this action">
                                <div class="goal-note-body">
                                    <span class="goal-note-text">${text}</span>
                                    <span class="goal-note-date">${dateStr}</span>
                                </div>
                                <span class="goal-note-undo" aria-hidden="true">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 14l-4-4 4-4M5 10h9a5 5 0 0 1 0 10h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                                </span>
                            </button>`;
                        }).join('')}
                    </div>
                </div>
                ` : ''}

                <!-- Danger zone — delete goal -->
                <div class="goal-danger-zone">
                    <button type="button" class="btn-danger-ghost" id="goal-delete">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                        <span>Delete goal</span>
                    </button>
                </div>

                ${(() => {
                    const bt = resolveBackTarget(backToDay);
                    return bt ? `
                <div class="goal-modal-actions">
                    <button type="button" class="btn btn-secondary" id="goal-back" style="flex:1">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="margin-right:4px"><polyline points="15,18 9,12 15,6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        ${bt.label}
                    </button>
                </div>` : '';
                })()}

            </div>`;

        // Re-open helper
        const reopen = () => openGoalDetail(idx, { backToDay });

        // Back button (if a back target was provided)
        {
            const bt = resolveBackTarget(backToDay);
            if (bt) $('#goal-back')?.addEventListener('click', bt.run);
        }

        // Per-prayer record buttons (qadaa goals) — tap the icon+name area
        $$('.pp-tap', content).forEach(btn => {
            btn.addEventListener('click', () => {
                const pid = btn.dataset.prayer;
                if (g.perPrayer[pid] <= 0) return;
                const snapshot = { perPrayer: { ...g.perPrayer }, remaining: g.remaining, notesLen: (g.notes||[]).length };
                recordQadaaPrayers(g, pid, 1);
                reopen();
                renderGoals();
                const pName = PRAYER_MAP[pid].name;
                toast(`Recorded 1 ${pName}`, { label: 'Undo', fn: () => {
                    g.perPrayer = snapshot.perPrayer;
                    g.remaining = snapshot.remaining;
                    if (g.notes) g.notes.length = snapshot.notesLen;
                    saveGoals(); reopen(); renderGoals();
                } });
            });
        });

        // Per-prayer stepper (+/−): adjust the count directly
        $$('.pp-step', content).forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const pid = btn.dataset.prayer;
                const step = parseInt(btn.dataset.ppStep);
                ensurePerPrayer(g);
                const cur = g.perPrayer[pid] || 0;
                const next = Math.max(0, cur + step);
                if (next === cur) return;
                const delta = next - cur;
                g.perPrayer[pid] = next;
                g.remaining = Math.max(0, g.remaining + delta);
                g.total = Math.max(g.total, g.remaining);
                g.notes = g.notes || [];
                g.notes.push({
                    date: new Date().toISOString(),
                    text: `Manual ${step > 0 ? '+' : ''}${delta} ${prayerById(pid).name}`,
                    amount: delta,
                    manual: true,
                    prayer: pid,
                });
                saveGoals();
                reopen();
                renderGoals();
            });
        });

        // Recent activity — tap the whole row to undo
        $$('.goal-note', content).forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!btn.classList.contains('confirm')) {
                    btn.classList.add('confirm');
                    const textEl = btn.querySelector('.goal-note-text');
                    if (textEl) textEl.textContent = 'Tap again to undo';
                    setTimeout(() => { if (btn.isConnected) { btn.classList.remove('confirm'); reopen(); } }, 3000);
                    return;
                }
                const noteIdx = parseInt(btn.dataset.noteIdx);
                const note = (g.notes || [])[noteIdx];
                if (!note) return;
                ensurePerPrayer(g);
                const reverse = -note.amount;
                g.remaining = Math.max(0, g.remaining + reverse);
                if (note.prayer && g.perPrayer[note.prayer] !== undefined) {
                    g.perPrayer[note.prayer] = Math.max(0, g.perPrayer[note.prayer] + reverse);
                } else if (note.text && /of each/.test(note.text)) {
                    PRAYERS.forEach(p => {
                        g.perPrayer[p.id] = Math.max(0, (g.perPrayer[p.id] || 0) + reverse);
                    });
                }
                if (note.amount > 0) g.total = Math.max(g.remaining, g.total - note.amount);
                if (note.sourceKey) {
                    const dd = dayData(note.sourceKey);
                    PRAYERS.forEach(p => { delete dd[`${p.id}_qadaa_recorded`]; });
                    save(KEYS.PRAYERS, S.prayers);
                }
                g.notes.splice(noteIdx, 1);
                saveGoals();
                reopen();
                renderGoals();
                renderCalendar();
                toast(`Undone: ${note.text || 'entry'}`);
            });
        });

        // Record full day — deduct 1 from each prayer that still has stock;
        // if some have 0, they stay at 0. This lets the user bulk-record even
        // when breakdown is uneven.
        // Qadaa: 1/2/3 day buttons
        $$('.goal-fullday[data-days]', content).forEach(btn => {
            btn.addEventListener('click', () => {
                const days = parseInt(btn.dataset.days);
                ensurePerPrayer(g);
                const snapshot = { perPrayer: { ...g.perPrayer }, remaining: g.remaining, notesLen: (g.notes||[]).length };
                let total = 0;
                for (let d = 0; d < days; d++) {
                    const mix = {};
                    let any = false;
                    PRAYERS.forEach(p => {
                        if ((g.perPrayer[p.id] || 0) >= 1) { mix[p.id] = 1; any = true; }
                    });
                    if (!any) break;
                    total += recordQadaaPrayers(g, mix, 1, { silent: true });
                }
                if (total === 0) { toast('No prayers remaining'); return; }
                // One consolidated note for the whole action
                g.notes = g.notes || [];
                g.notes.push({ date: new Date().toISOString(), text: `${total} prayers — ${days} day${days === 1 ? '' : 's'}`, amount: -total });
                saveGoals();
                reopen();
                renderGoals();
                toast(`${total} prayers — ${days} day${days === 1 ? '' : 's'}`, { label: 'Undo', fn: () => {
                    g.perPrayer = snapshot.perPrayer;
                    g.remaining = snapshot.remaining;
                    if (g.notes) g.notes.length = snapshot.notesLen;
                    saveGoals(); reopen(); renderGoals();
                } });
            });
        });

        // Non-qadaa: +1/+3/+5/+10 buttons
        const recordN = (n) => {
            const amount = Math.min(n, g.remaining);
            if (amount <= 0) return;
            const prev = { remaining: g.remaining, notesLen: (g.notes||[]).length };
            g.remaining -= amount;
            g.notes = g.notes || [];
            g.notes.push({ date: new Date().toISOString(), text: `Recorded ${amount}`, amount: -amount });
            saveGoals(); reopen(); renderGoals();
            toast(`${amount} recorded`, { label: 'Undo', fn: () => {
                g.remaining = prev.remaining;
                if (g.notes) g.notes.length = prev.notesLen;
                saveGoals(); reopen(); renderGoals();
            } });
        };
        $('#goal-record-one')?.addEventListener('click', () => recordN(1));
        $('#goal-record-3')?.addEventListener('click', () => recordN(3));
        $('#goal-record-5')?.addEventListener('click', () => recordN(5));
        $('#goal-record-10')?.addEventListener('click', () => recordN(10));

        // Undo last (= +1)
        $('#goal-undo')?.addEventListener('click', () => {
            if (g.total - g.remaining <= 0) return;
            g.remaining++;
            if (g.remaining > g.total) g.remaining = g.total;
            if (g.notes && g.notes.length) g.notes.pop();
            saveGoals();
            reopen();
            renderGoals();
        });

        // Delete with inline confirmation (ghost button in danger zone)
        $('#goal-delete')?.addEventListener('click', () => {
            const btn = $('#goal-delete');
            if (!btn.classList.contains('confirm')) {
                btn.classList.add('confirm');
                btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> <span>Tap again to confirm</span>';
                setTimeout(() => {
                    if (btn) {
                        btn.classList.remove('confirm');
                        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> <span>Delete goal</span>';
                    }
                }, 3000);
                return;
            }
            S.goalsArchive = S.goalsArchive || [];
            S.goalsArchive.push({ ...g, archivedAt: new Date().toISOString() });
            save(KEYS.GOALS_ARCHIVE, S.goalsArchive);
            goals.splice(idx, 1);
            saveGoals();
            closeAllModals();
            renderGoals();
            toast('Goal archived', { label: 'Undo', fn: () => {
                const restored = S.goalsArchive.pop();
                save(KEYS.GOALS_ARCHIVE, S.goalsArchive);
                getGoals().push(restored);
                saveGoals();
                renderGoals();
            } });
        });


        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
    }

    /* ── Archive Modal ──────────────────────────────────────── */
    function openArchiveModal() {
        clearModalHeaderActions();
        const modal = $('#modal-backdrop');
        const content = $('#modal-content');
        if (!modal || !content) return;

        const archive = S.goalsArchive || [];
        $('#modal-title').textContent = 'Archive';

        if (archive.length === 0) {
            content.innerHTML = '<div class="goals-empty"><span>No archived goals</span></div>';
            modal.classList.add('active');
            modal.setAttribute('aria-hidden', 'false');
            return;
        }

        // Split archive into two sections: completed (done) vs dismissed/deleted
        const completed = [];
        const dismissed = [];
        archive.forEach((g, i) => {
            if (g.completed) completed.push({ g, i });
            else dismissed.push({ g, i });
        });

        const rowHTML = ({ g, i }) => {
            const type = GOAL_TYPES[g.type] || GOAL_TYPES.custom;
            const done = g.total - g.remaining;
            const pct = g.total > 0 ? Math.round((done / g.total) * 100) : 0;
            const archivedDate = g.archivedAt ? fmtShortDate(g.archivedAt) : '';
            return `
            <div class="archive-row" data-idx="${i}">
                <div class="goal-icon ${type.css}">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">${type.icon}</svg>
                </div>
                <div class="goal-info">
                    <div class="goal-name">${esc(g.name) || type.name}${g.type === 'qadaa-auto' && !g.isManual ? '<span class="goal-auto-tag">AUTO</span>' : ''}${g.completed ? '<span class="archive-done-tag">DONE</span>' : ''}</div>
                    <div class="goal-progress-text">${done} / ${g.total} · ${pct}%${archivedDate ? ' · ' + archivedDate : ''}</div>
                </div>
                <button type="button" class="archive-action archive-restore" data-idx="${i}" title="Restore">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <button type="button" class="archive-action archive-delete" data-idx="${i}" title="Delete forever">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                </button>
            </div>`;
        };

        content.innerHTML = `
            ${completed.length > 0 ? `
            <div class="archive-section">
                <h4 class="archive-section-head"><span class="archive-dot archive-dot-done"></span> Completed (${completed.length})</h4>
                <div class="archive-list">${completed.map(rowHTML).join('')}</div>
            </div>` : ''}
            ${dismissed.length > 0 ? `
            <div class="archive-section">
                <h4 class="archive-section-head"><span class="archive-dot archive-dot-dismissed"></span> Dismissed &amp; deleted (${dismissed.length})</h4>
                <div class="archive-list">${dismissed.map(rowHTML).join('')}</div>
            </div>` : ''}
        `;

        $$('.archive-restore', content).forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const i = parseInt(btn.dataset.idx);
                const restored = archive.splice(i, 1)[0];
                delete restored.archivedAt;
                delete restored.completed;
                // If restoring a completed goal, give it 1 remaining so it's actionable
                if (restored.remaining <= 0 && restored.total > 0) {
                    restored.remaining = 1;
                    restored.total = Math.max(restored.total, 1);
                }
                save(KEYS.GOALS_ARCHIVE, archive);
                getGoals().push(restored);
                saveGoals();
                renderGoals();
                openArchiveModal();
                toast('Goal restored');
            });
        });
        $$('.archive-delete', content).forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                if (!btn.classList.contains('confirm')) {
                    btn.classList.add('confirm');
                    btn.style.color = 'var(--accent-danger)';
                    setTimeout(() => { btn.classList.remove('confirm'); btn.style.color = ''; }, 3000);
                    return;
                }
                const i = parseInt(btn.dataset.idx);
                archive.splice(i, 1);
                save(KEYS.GOALS_ARCHIVE, archive);
                openArchiveModal();
                renderGoals();
            });
        });

        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
    }

    /* ── Reminder info cards ──────────────────────────────────── */
    const REMINDER_INFO = {
        'Surat Al-Kahf': {
            text: 'Abū Sa\'id reported the Prophet ﷺ as saying, "If anyone recites Sūrat al-Kahf on Friday, light will shine brightly for him till the next Friday."',
            source: 'Mishkat al-Masabih 2175 · Transmitted by al-Bayhaqi in al-Da\'awat al-Kabir',
            url: 'https://sunnah.com/mishkat:2175',
            quranUrl: 'https://quran.com/18',
        },
        'Days of Muharram': {
            text: 'Ibn \'Abbas said that when the Messenger of Allah ﷺ fasted on the day of \'Ashura and commanded that it should be observed as a fast, he was told it was a day held in honour by Jews and Christians, and said, "If I am spared till next year I shall fast on the ninth."',
            source: 'Mishkat al-Masabih 2041 · Transmitted by Muslim',
            url: 'https://sunnah.com/mishkat:2041',
        },
        'First 10 Days of Dhul Hijjah': {
            text: 'Narrated Ibn Abbas: The Prophet ﷺ said, "No good deeds done on other days are superior to those done on these (first ten days of Dhul Hijja)." Then some companions of the Prophet ﷺ said, "Not even Jihad?" He replied, "Not even Jihad, except that of a man who does it by putting himself and his property in danger (for Allah\'s sake) and does not return with any of those things."',
            source: 'Sahih al-Bukhari 969',
            url: 'https://sunnah.com/bukhari:969',
        },
        '6 Days of Shawwal': {
            text: 'Abu Ayyub al-Ansari (Allah be pleased with him) reported Allah\'s Messenger ﷺ as saying: "He who observed the fast of Ramadan and then followed it with six (fasts) of Shawwal, it would be as if he fasted perpetually."',
            source: 'Sahih Muslim 1164a',
            url: 'https://sunnah.com/muslim:1164a',
        },
        'White Days (Fasting)': {
            text: '\'Abdul-Malik bin Qudamah bin Milhan narrated that his father said: "The Messenger of Allah ﷺ used to command us to fast the three days with the shining bright nights (Al-Ayam Al-Bid), the thirteenth, fourteenth and fifteenth."',
            source: 'Sunan an-Nasa\'i 2432 · Grade: Da\'if (Darussalam)',
            url: 'https://sunnah.com/nasai:2432',
        },
        'Islamic New Year': {
            text: 'The Islamic New Year marks the first day of Muharram, the beginning of the lunar Hijri calendar. It commemorates the Hijrah — the migration of Prophet Muhammad ﷺ and his companions from Makkah to Madinah in 622 CE, a turning point in Islamic history.',
            source: '',
        },
        'Day of Ashura': {
            text: 'Narrated Ibn \'Abbas: When the Prophet ﷺ arrived at Medina, the Jews were observing the fast on \'Ashura (10th of Muharram) and they said, "This is the day when Moses became victorious over Pharaoh." On that, the Prophet ﷺ said to his companions, "You (Muslims) have more right to celebrate Moses\' victory than they have, so observe the fast on this day."',
            source: 'Sahih al-Bukhari 4680',
            url: 'https://sunnah.com/bukhari:4680',
        },
        'Mawlid al-Nabi': {
            text: 'Mawlid al-Nabi marks the birth of Prophet Muhammad ﷺ. Muslims observe it through prayers, Quranic recitation, charitable giving, and gatherings to remember his life and teachings.',
            source: '',
        },
        "Isra' & Mi'raj": {
            text: 'The Night Journey and Ascension. The Prophet ﷺ was taken from Makkah to Jerusalem, then ascended through the seven heavens. The five daily prayers were prescribed on this night.',
            source: 'Sahih al-Bukhari 3887 (full narration)',
            url: 'https://sunnah.com/bukhari:3887',
        },
        'Shab-e-Barat': {
            text: 'The night of mid-Sha\'ban, known as Laylat al-Bara\'ah. A night of prayer and seeking forgiveness. Many Muslims observe it with extra worship and supplication, believing it to be a night when Allah extends His mercy and forgiveness to His creation.',
            source: '',
        },
        'Ramadan Begins': {
            text: 'Narrated Abu Huraira: Allah\'s Messenger ﷺ said, "When the month of Ramadan starts, the gates of the heaven are opened and the gates of Hell are closed and the devils are chained."',
            source: 'Sahih al-Bukhari 1899',
            url: 'https://sunnah.com/bukhari:1899',
        },
        'Odd Night': {
            text: 'Narrated \'Aisha: Allah\'s Messenger ﷺ said, "Search for the Night of Qadr in the odd nights of the last ten days of Ramadan."',
            source: 'Sahih al-Bukhari 2017',
            url: 'https://sunnah.com/bukhari:2017',
        },
        'Eid al-Fitr': {
            text: 'Eid al-Fitr marks the end of Ramadan and the completion of a month of fasting. Muslims celebrate with a special congregational prayer, the giving of Zakat al-Fitr, and festive gatherings with family and community.',
            source: '',
        },
        'Day of Tarwiyah': {
            text: 'The Day of Tarwiyah is the 8th of Dhul Hijjah and marks the first day of the Hajj rites. Pilgrims enter their state of Ihram and travel to Mina, spending the day and night in prayer, preparing for the standing at Arafah the following day.',
            source: '',
        },
        'Day of Arafah': {
            text: 'Abu Qatada al-Ansari narrated that the Messenger of Allah ﷺ was asked about fasting on the day of Arafah. He replied, "Fasting on the day of Arafah is an expiation for the preceding year and the following year."',
            source: 'Sahih Muslim · Bulugh al-Maram, Book 5, Hadith 700',
            url: 'https://sunnah.com/bulugh/5/31',
        },
        'Eid al-Adha': {
            text: 'Eid al-Adha commemorates Prophet Ibrahim\'s willingness to sacrifice his son in complete obedience to Allah. Muslims celebrate with Eid prayers and Qurbani (the ritual sacrifice of livestock), distributing the meat among family, friends, and the poor.',
            source: '',
        },
    };

    /* ── Reminders — month-specific special days ─────────────── */
    // Multi-day events keyed by Hijri month
    const MONTH_EVENTS = {
        // Muharram — days of virtue
        1: [
            { range: [9, 11], short: 'Muharram', name: 'Days of Muharram', detail: 'Recommended fasting: 9, 10 (Ashura), 11' },
        ],
        // Dhul Hijjah — the sacred 10 days
        12: [
            { range: [1, 10], short: 'Dhul Hijjah', name: 'First 10 Days of Dhul Hijjah', detail: 'The most beloved days to Allah' },
        ],
    };

    function getCellRangeEvent(month, day) {
        const events = MONTH_EVENTS[month];
        if (!events) return null;
        return events.find(e => day >= e.range[0] && day <= e.range[1]) || null;
    }

    // Dynamic reminders computed at render time (e.g. "X days left in Shawwal")
    function getDynamicEvents(year, month) {
        const events = [];

        // Shawwal: 6 days of fasting — show days remaining in month
        if (month === 10) {
            const today = HijriCalendar.gregorianToHijri(new Date());
            const totalDays = HijriCalendar.daysInMonth(year, month);
            let daysLeft = totalDays;
            if (today.year === year && today.month === month) {
                daysLeft = Math.max(0, totalDays - today.day + 1);
            } else if (today.year > year || (today.year === year && today.month > month)) {
                daysLeft = 0;
            }
            events.push({
                name: '6 Days of Shawwal',
                detail: daysLeft > 0
                    ? `Fast any 6 days — ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left this month`
                    : 'Shawwal has ended',
                icon: 'dynamic',
            });
        }

        return events;
    }

    function getMonthSpecialDays(year, month) {
        const specials = [];
        const monthData = HijriCalendar.getMonthData(year, month);

        // Month significance banner first
        if (monthData.significance) {
            specials.push({ type: 'significance', name: monthData.significance });
        }

        // Dynamic (windowed) events
        getDynamicEvents(year, month).forEach(e => {
            specials.push({ type: 'dynamic', name: e.name, detail: e.detail });
        });

        // Multi-day ranges
        (MONTH_EVENTS[month] || []).forEach(e => {
            specials.push({
                type: 'range',
                name: e.name,
                detail: e.detail,
                rangeText: `${monthData.monthName} ${e.range[0]}–${e.range[1]}`,
            });
        });

        // Single-day special dates
        monthData.weeks.forEach(week => {
            week.forEach(cell => {
                if (cell && cell.isSpecial && cell.specialName) {
                    specials.push({ type: 'single', day: cell.day, name: cell.specialName });
                }
            });
        });

        // White Days every month
        specials.push({ type: 'white', day: '13–15', name: 'White Days (Fasting)' });

        return specials;
    }

    function renderReminders() {
        const h = HijriCalendar.gregorianToHijri(new Date());
        renderRemindersForMonth(h.year, h.month);
        renderFridayReminder();
    }

    function renderFridayReminder() {
        if (new Date().getDay() !== 5) return;
        const container = $('.reminders-display');
        if (!container) return;
        const html = renderReminderRow({ type: 'friday', name: 'Surat Al-Kahf', detail: "Read Surat Al-Kahf on Jumu'ah" });
        const temp = document.createElement('div');
        temp.innerHTML = html;
        const row = temp.firstElementChild;
        container.prepend(row);
        wireReminderClicks(container);
    }


    /* ── Prayer Toggle (from calendar modal) ─────────────────── */

    /* ── Calendar ────────────────────────────────────────────── */
    function renderCalendar() {
        if (!S.calY || !S.calM) {
            const h = HijriCalendar.gregorianToHijri(new Date());
            S.calY = h.year;
            S.calM = h.month;
        }
        updateCalendar();
    }

    /* Mini icons for cell indicators */
    const CELL_GLYPHS = {
        fajr:    '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M12 4v1M20 12h-1M12 20v-1M4 12h1" stroke="currentColor" stroke-width="1.5"/>',
        dhuhr:   '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
        asr:     '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/><path d="M15 15l3 3" stroke="currentColor" stroke-width="1.5"/>',
        maghrib: '<path d="M6 16h12M9 16a3 3 0 0 1 6 0" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 10v-3" stroke="currentColor" stroke-width="1.5"/>',
        isha:    '<path d="M17 13A6 6 0 0 1 11 7a5 5 0 0 0 6 6z" fill="currentColor"/>',
        qyaam:   '<path d="M17 13A6 6 0 0 1 11 7a5 5 0 0 0 6 6z" fill="currentColor"/><circle cx="7" cy="7" r="1" fill="currentColor"/><circle cx="18" cy="5" r="0.8" fill="currentColor"/>',
        fasting: '<path d="M6 2h12M6 22h12M6 2c0 4 4 5 4 8s-4 4-4 8h12c0-4-4-5-4-8s4-4 4-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    };

    /** Build a Set<"Y-M-D"> of every Hijri day currently flagged as auto-missed.
     * O(goals) once — callers then do O(1) lookups per cell instead of O(cells × goals).
     * Only non-manual, unresolved goals count (manual entries don't flag the calendar;
     * they're goals to pray back a prayer, not a record of which day it was missed). */
    function buildAutoMissedSet() {
        const set = new Set();
        getGoals().forEach(g => {
            if (g.type !== 'qadaa-auto' || !g.missedOn || g.isManual) return;
            if ((g.remaining || 0) <= 0) return;
            const h = toHijri(g.missedOn);
            set.add(`${h.year}-${h.month}-${h.day}`);
        });
        return set;
    }

    function hasAutoMissedGoalFor(hYear, hMonth, hDay) {
        return getGoals().some(g => {
            if (g.type !== 'qadaa-auto' || !g.missedOn) return false;
            if (g.isManual) return false;
            if ((g.remaining || 0) <= 0) return false;
            const d = new Date(g.missedOn);
            const h = HijriCalendar.gregorianToHijri(d);
            return h.year === hYear && h.month === hMonth && h.day === hDay;
        });
    }


    function renderCellIndicator(dd, hijriInfo, autoMissedSet) {
        const show = S.settings.showIndicators !== false;
        if (!show) return '';

        const hadQadaaMissed = hijriInfo
            ? (autoMissedSet
                ? autoMissedSet.has(`${hijriInfo.year}-${hijriInfo.month}-${hijriInfo.day}`)
                : hasAutoMissedGoalFor(hijriInfo.year, hijriInfo.month, hijriInfo.day))
            : false;
        const qadaaCount = PRAYERS.filter(p => dd[`${p.id}_qadaa_recorded`]).length;

        const iconsRow = `<div class="cell-prayers-row">
            ${PRAYERS.map(p => `<span class="cell-ico ${dd[p.id] ? 'on' : 'off'}" title="${p.name}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none">${CELL_GLYPHS[p.id]}</svg></span>`).join('')}
        </div>`;

        const badges = [];
        if (dd.fasting) badges.push('<span class="cell-badge cell-badge-fast" title="Fasting"><svg viewBox="0 0 24 24" fill="none"><path d="M6 2h12M6 22h12M6 2c0 4 4 5 4 8s-4 4-4 8h12c0-4-4-5-4-8s4-4 4-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Fast</span>');
        if (dd.duha) badges.push('<span class="cell-badge cell-badge-duha" title="Duha"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>Duha</span>');
        if (dd.shafaWitr) badges.push('<span class="cell-badge cell-badge-shafa" title="Shaf\'a & Witr"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3C7.03 3 3 7.03 3 12s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36A5.39 5.39 0 0 1 14.4 14 5.4 5.4 0 0 1 9 8.6c0-1.07.31-2.07.85-2.91C10.26 3.26 11.06 3 12 3z" fill="currentColor"/></svg>Witr</span>');
        if (dd.qyaam) {
            const rak = dd.qyaamRakaat || 0;
            badges.push(`<span class="cell-badge cell-badge-qyaam" title="Qyaam ${rak} rakaat"><svg viewBox="0 0 24 24" fill="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/></svg>Qyaam${rak ? ' ' + rak : ''}</span>`);
        }
        if (hadQadaaMissed) badges.push('<span class="cell-badge cell-badge-qadaa-missed" title="Auto-missed prayer on this day"><svg viewBox="0 0 24 24" fill="none"><path d="M12 2L14 8.5L20 9L15 13.5L16 20L12 17L8 20L9 13.5L4 9L10 8.5Z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>Missed</span>');
        if (qadaaCount > 0) badges.push(`<span class="cell-badge cell-badge-qadaa-done" title="${qadaaCount} qadaa prayer${qadaaCount === 1 ? '' : 's'} recorded this day"><svg viewBox="0 0 24 24" fill="none"><path d="M12 2L14 8.5L20 9L15 13.5L16 20L12 17L8 20L9 13.5L4 9L10 8.5Z" fill="currentColor"/></svg>Qadaa ${qadaaCount}</span>`);

        const badgesRow = badges.length > 0 ? `<div class="cell-badges-row">${badges.join('')}</div>` : '';

        return badgesRow + iconsRow;
    }

    /** Update calendar state to match today in the active (primary) calendar. */
    function calToday() {
        const primary = S.settings.primaryCalendar || 'hijri';
        if (primary === 'gregorian') {
            const n = new Date();
            S.gregY = n.getFullYear();
            S.gregM = n.getMonth(); // 0-11
        } else {
            const h = HijriCalendar.gregorianToHijri(new Date());
            S.calY = h.year; S.calM = h.month;
        }
        S.highlightHijriMonth = null;
        updateCalendar();
    }

    /** Render calendar when primary is Gregorian: grid by Gregorian month, Hijri as secondary */
    function updateCalendarGregorian() {
        // Determine the Gregorian month we're showing
        if (S.gregY == null || S.gregM == null) {
            const n = new Date();
            S.gregY = n.getFullYear();
            S.gregM = n.getMonth();
        }
        const monthStart = new Date(S.gregY, S.gregM, 1);
        const monthEnd = new Date(S.gregY, S.gregM + 1, 0);
        const totalDays = monthEnd.getDate();
        const firstWeekday = monthStart.getDay(); // 0=Sun

        // Compute ALL Hijri months that overlap this Gregorian month (typically 2, but can be 3 in edge cases)
        const hijriMonthMap = new Map();
        for (let d = 1; d <= totalDays; d++) {
            const gDate = new Date(S.gregY, S.gregM, d);
            const h = HijriCalendar.gregorianToHijri(gDate);
            const key = `${h.year}-${h.month}`;
            if (!hijriMonthMap.has(key)) hijriMonthMap.set(key, { year: h.year, month: h.month });
        }
        const hijriMonthsList = [...hijriMonthMap.values()];

        const gregTitle = fmtMonthYear(monthStart);
        // Add a color index (0, 1, 2) for each chip so we can tint cells to match
        const hijriSubtitle = hijriMonthsList.map((m, idx) => {
            const info = HijriCalendar.getMonthData(m.year, m.month);
            return {
                ...m,
                label: `${info.monthName} ${m.year}`,
                monthName: info.monthName,
                colorIdx: idx, // 0, 1, 2
            };
        });

        // Set title + subtitle chips (color-coded so you don't need to click to tell them apart)
        const title = $('#cal-month-title');
        const sub = $('#cal-sub-title');
        if (title) title.textContent = gregTitle;
        if (sub) {
            sub.innerHTML = hijriSubtitle.map(m => {
                const chipKey = `${m.year}-${m.month}`;
                const active = S.highlightHijriMonth === chipKey;
                return `<button type="button" class="cal-chip-legend chip-color-${m.colorIdx}${active ? ' active' : ''}" data-chip="${chipKey}">${m.label}</button>`;
            }).join('');
            // Delegation: attach once, use dataset flag to guard re-render re-attachment.
            if (!sub.dataset.chipDelegated) {
                sub.dataset.chipDelegated = '1';
                sub.addEventListener('click', (e) => {
                    const btn = e.target.closest('.cal-chip-legend');
                    if (!btn || !sub.contains(btn)) return;
                    const key = btn.dataset.chip;
                    if (!key) return;
                    S.highlightHijriMonth = S.highlightHijriMonth === key ? null : key;
                    updateCalendar();
                });
            }
        }

        // Build a quick lookup: hijri month key → color idx (for cell tinting)
        const hijriColorByKey = {};
        hijriSubtitle.forEach(m => { hijriColorByKey[`${m.year}-${m.month}`] = m.colorIdx; });

        const grid = $('#calendar-grid');
        if (!grid) return;

        const weekStart = S.settings.weekStart ?? 6;
        const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const orderedNames = [...DAY_NAMES.slice(weekStart), ...DAY_NAMES.slice(0, weekStart)];
        let html = orderedNames.map(d => `<div class="cal-day-header">${d}</div>`).join('');

        const offset = (firstWeekday - weekStart + 7) % 7;
        const allCells = [];
        for (let i = 0; i < offset; i++) allCells.push({ empty: true });
        for (let d = 1; d <= totalDays; d++) {
            const gDate = new Date(S.gregY, S.gregM, d);
            const h = HijriCalendar.gregorianToHijri(gDate);
            allCells.push({ empty: false, gDay: d, gDate, hYear: h.year, hMonth: h.month, hDay: h.day });
        }
        while (allCells.length % 7 !== 0) allCells.push({ empty: true });
        const rebuiltWeeks = [];
        for (let i = 0; i < allCells.length; i += 7) rebuiltWeeks.push(allCells.slice(i, i + 7));

        const todayStr = new Date().toDateString();
        const showSecondary = S.settings.showGregorian !== false;
        // Memoize Hijri getMonthData calls — same (year,month) pair repeats across many cells.
        const monthDataCache = {};
        const getMInfo = (y, m) => {
            const k = `${y}-${m}`;
            return monthDataCache[k] || (monthDataCache[k] = HijriCalendar.getMonthData(y, m));
        };
        const autoMissedSet = buildAutoMissedSet();

        rebuiltWeeks.forEach(week => {
            week.forEach(cell => {
                if (cell.empty) { html += '<div class="cal-cell empty"></div>'; return; }

                const key = hk(cell.hYear, cell.hMonth, cell.hDay);
                const dd = peekDay(key);
                const hasData = !!S.prayers[key];
                const isToday = cell.gDate.toDateString() === todayStr;
                const isWhite = [13,14,15].includes(cell.hDay);
                const rangeEvent = getCellRangeEvent(cell.hMonth, cell.hDay);
                const mInfo = getMInfo(cell.hYear, cell.hMonth);
                const specialName = HijriCalendar.SPECIAL_DATES[`${cell.hMonth}-${cell.hDay}`];
                const isSpecial = !!specialName;

                const cellMonthKey = `${cell.hYear}-${cell.hMonth}`;
                const colorIdx = hijriColorByKey[cellMonthKey];
                const highlighted = S.highlightHijriMonth === cellMonthKey;

                let cls = ` month-color-${colorIdx}`;
                if (isToday) cls += ' today';
                if (isWhite) cls += ' white-day';
                if (isSpecial) cls += ' special-day';
                if (rangeEvent) cls += ' range-day';
                if (highlighted) cls += ' chip-highlight';
                if (colorIdx > 0) cls += ' cross-month';

                const badge = isSpecial
                    ? `<div class="special-day-badge">${specialName}</div>`
                    : rangeEvent
                        ? `<div class="special-day-badge range-badge">${rangeEvent.short}</div>`
                        : isWhite
                            ? '<div class="special-day-badge white-badge">White Day</div>'
                            : '';

                const hShort = mInfo.monthNameShort || mInfo.monthName;
                const hijriInfo = { year: cell.hYear, month: cell.hMonth, day: cell.hDay };
                const showCell = hasData || autoMissedSet.has(`${cell.hYear}-${cell.hMonth}-${cell.hDay}`);

                html += `
                <div class="cal-cell${cls}" data-key="${key}" role="button" tabindex="0"
                     onclick="handleDayClick(event,'${key}')"
                     aria-label="${mInfo.monthName} ${cell.hDay} - ${cell.gDate.toDateString()}">
                    <div class="day-num">${cell.gDay}</div>
                    ${showSecondary ? `<div class="gregorian-date">${hShort} ${cell.hDay}</div>` : ''}
                    ${badge}
                    ${showCell ? renderCellIndicator(dd, hijriInfo, autoMissedSet) : ''}
                </div>`;
            });
        });

        grid.innerHTML = html;

        // Render reminders for ALL overlapping Hijri months
        renderRemindersForMonths(hijriSubtitle);
    }

    /** Render reminders aggregated over multiple Hijri months. */
    function renderRemindersForMonths(months) {
        const container = $('.reminders-display');
        if (!container) return;
        const heading = $('#reminders-heading');
        if (heading) heading.textContent = months.map(m => m.monthName).join(' · ');

        const combined = [];
        months.forEach(m => {
            const specials = getMonthSpecialDays(m.year, m.month);
            specials.forEach(s => combined.push({ ...s, _monthName: m.monthName, _year: m.year }));
        });

        if (combined.length === 0) {
            container.innerHTML = '<div class="reminder-row"><div class="reminder-icon-box"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/></svg></div><div class="reminder-text"><div class="reminder-title">No special days</div></div></div>';
            renderFridayReminder();
            wireReminderClicks(container);
            return;
        }

        container.innerHTML = combined.map(s => renderReminderRow({ ...s, _monthName: s._monthName }, s._monthName)).join('');
        renderFridayReminder();
        wireReminderClicks(container);
    }

    function updateCalendar() {
        const primary = S.settings.primaryCalendar || 'hijri';
        if (primary === 'gregorian') return updateCalendarGregorian();
        const md = HijriCalendar.getMonthData(S.calY, S.calM);

        // Gregorian range covered by this Hijri month
        const firstGreg = HijriCalendar.hijriToGregorian(S.calY, S.calM, 1);
        const lastGreg = HijriCalendar.hijriToGregorian(S.calY, S.calM, md.totalDays);
        let gregRange;
        if (firstGreg.getMonth() === lastGreg.getMonth() && firstGreg.getFullYear() === lastGreg.getFullYear()) {
            gregRange = fmtMonthYear(firstGreg);
        } else if (firstGreg.getFullYear() === lastGreg.getFullYear()) {
            gregRange = `${fmtMonthOnly(firstGreg)} – ${fmtMonthYear(lastGreg)}`;
        } else {
            gregRange = `${fmtMonthYear(firstGreg)} – ${fmtMonthYear(lastGreg)}`;
        }

        const hijriLabel = `${md.monthName} ${S.calY}`;

        const title = $('#cal-month-title');
        const sub = $('#cal-sub-title');

        // Compute ALL Gregorian months that overlap this Hijri month (usually 2, can be 3)
        const gregMonthMap = new Map();
        for (let d = 1; d <= md.totalDays; d++) {
            const g = HijriCalendar.hijriToGregorian(S.calY, S.calM, d);
            const key = `${g.getFullYear()}-${g.getMonth()}`;
            if (!gregMonthMap.has(key)) {
                gregMonthMap.set(key, { y: g.getFullYear(), m: g.getMonth(), label: fmtMonthYear(g) });
            }
        }
        const gregChips = [...gregMonthMap.values()].map((c, idx) => ({ ...c, colorIdx: idx }));

        if (title) title.textContent = hijriLabel;
        if (sub) {
            sub.innerHTML = gregChips.map(c => {
                const chipKey = `${c.y}-${c.m}`;
                const active = S.highlightGregMonth === chipKey;
                return `<button type="button" class="cal-chip-legend chip-color-${c.colorIdx}${active ? ' active' : ''}" data-gchip="${chipKey}">${c.label}</button>`;
            }).join('');
            if (!sub.dataset.gchipDelegated) {
                sub.dataset.gchipDelegated = '1';
                sub.addEventListener('click', (e) => {
                    const btn = e.target.closest('.cal-chip-legend');
                    if (!btn || !sub.contains(btn)) return;
                    const k = btn.dataset.gchip;
                    if (!k) return;
                    S.highlightGregMonth = S.highlightGregMonth === k ? null : k;
                    updateCalendar();
                });
            }
        }

        // Quick lookup for cell tinting
        const gregColorByKey = {};
        gregChips.forEach(c => { gregColorByKey[`${c.y}-${c.m}`] = c.colorIdx; });

        const grid = $('#calendar-grid');
        if (!grid) return;

        const weekStart = S.settings.weekStart ?? 6; // 0=Sun, 1=Mon, 6=Sat
        const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const orderedNames = [...DAY_NAMES.slice(weekStart), ...DAY_NAMES.slice(0, weekStart)];

        let html = orderedNames.map(d => `<div class="cal-day-header">${d}</div>`).join('');

        // Rebuild cells with the user's week-start preference
        const totalDays = md.totalDays;
        const firstWeekday = md.startWeekday; // 0=Sun
        const offset = (firstWeekday - weekStart + 7) % 7;
        const allCells = [];
        for (let i = 0; i < offset; i++) allCells.push({ empty: true });
        for (let d = 1; d <= totalDays; d++) {
            const cell = md.weeks.flat().find(c => !c.empty && c.day === d);
            allCells.push(cell);
        }
        while (allCells.length % 7 !== 0) allCells.push({ empty: true });
        const rebuiltWeeks = [];
        for (let i = 0; i < allCells.length; i += 7) rebuiltWeeks.push(allCells.slice(i, i + 7));

        const autoMissedSet = buildAutoMissedSet();

        rebuiltWeeks.forEach(week => {
            week.forEach(cell => {
                if (!cell || cell.empty) {
                    html += '<div class="cal-cell empty"></div>';
                    return;
                }

                const key = hk(S.calY, S.calM, cell.day);
                const dd = peekDay(key);
                const c = completed(dd);
                const hasData = !!S.prayers[key];
                const greg = HijriCalendar.hijriToGregorian(S.calY, S.calM, cell.day);
                const gDay = greg.getDate();
                const gMon = fmtMonthShort(greg);
                const gMonFull = fmtMonthYear(greg);
                const gKey = `${greg.getFullYear()}-${greg.getMonth()}`;

                const isWhite = [13,14,15].includes(cell.day);
                const rangeEvent = getCellRangeEvent(S.calM, cell.day);
                const colorIdx = gregColorByKey[gKey];

                let cls = ` month-color-${colorIdx}`;
                if (cell.isToday) cls += ' today';
                if (isWhite) cls += ' white-day';
                if (cell.isSpecial) cls += ' special-day';
                if (rangeEvent) cls += ' range-day';
                // Cross-month = any color other than 0 (dominant month)
                if (colorIdx > 0) cls += ' cross-month';
                if (S.highlightGregMonth === gKey) cls += ' chip-highlight';

                const showSecondary = S.settings.showGregorian !== false;
                const badge = cell.isSpecial
                    ? `<div class="special-day-badge">${cell.specialName}</div>`
                    : rangeEvent
                        ? `<div class="special-day-badge range-badge">${rangeEvent.short}</div>`
                        : isWhite
                            ? '<div class="special-day-badge white-badge">White Day</div>'
                            : '';

                const secondaryLabel = `${gMon} ${gDay}`;
                const hijriInfo = { year: S.calY, month: S.calM, day: cell.day };
                const showCell = hasData || autoMissedSet.has(`${S.calY}-${S.calM}-${cell.day}`);

                html += `
                <div class="cal-cell${cls}" data-key="${key}" role="button" tabindex="0"
                     onclick="handleDayClick(event,'${key}')"
                     aria-label="${md.monthName} ${cell.day} - ${gMonFull} ${gDay} - ${c}/5 prayers">
                    <div class="day-num">${cell.day}</div>
                    ${showSecondary ? `<div class="gregorian-date">${secondaryLabel}</div>` : ''}
                    ${badge}
                    ${showCell ? renderCellIndicator(dd, hijriInfo, autoMissedSet) : ''}
                </div>`;
            });
        });

        grid.innerHTML = html;

        // Also re-render reminders when calendar month changes
        renderRemindersForMonth(S.calY, S.calM);
        renderFridayReminder();
    }

    function renderRemindersForMonth(year, month) {
        const specials = getMonthSpecialDays(year, month);
        const container = $('.reminders-display');
        if (!container) return;

        const monthData = HijriCalendar.getMonthData(year, month);
        const mn = monthData.monthName;

        const heading = $('#reminders-heading');
        if (heading) heading.textContent = `${mn} ${year}`;

        if (specials.length === 0) {
            container.innerHTML = '<div class="reminder-row"><div class="reminder-icon-box"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/></svg></div><div class="reminder-text"><div class="reminder-title">No special days this month</div></div></div>';
            return;
        }

        const iconMap = {
            significance: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/>',
            single:       '<path d="M12 2L14.09 8.26L20 10L14.09 11.74L12 18L9.91 11.74L4 10L9.91 8.26L12 2Z" fill="currentColor"/>',
            range:        '<rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M8 3v4M16 3v4M3 11h18" stroke="currentColor" stroke-width="1.5"/>',
            dynamic:      '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
            white:        '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.5"/>',
        };

        container.innerHTML = specials.map(s => renderReminderRow(s, mn)).join('');
        wireReminderClicks(container);
    }

    function renderReminderRow(s, monthName) {
        const subtitle = s.detail || s.rangeText || (s.day ? `${monthName || ''} ${s.day}` : '');
        const hasInfo = !!REMINDER_INFO[s.name];
        const iconMap = {
            significance: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/>',
            single:       '<path d="M12 2L14.09 8.26L20 10L14.09 11.74L12 18L9.91 11.74L4 10L9.91 8.26L12 2Z" fill="currentColor"/>',
            range:        '<rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M8 3v4M16 3v4M3 11h18" stroke="currentColor" stroke-width="1.5"/>',
            dynamic:      '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
            white:        '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.5"/>',
            friday:       '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
        };
        return `
        <div class="reminder-row reminder-${s.type}${hasInfo ? ' has-info' : ''}" ${hasInfo ? `data-reminder="${s.name}"` : ''}>
            <div class="reminder-icon-box">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">${iconMap[s.type] || iconMap.single}</svg>
            </div>
            <div class="reminder-text">
                <div class="reminder-title">${s.name}</div>
                ${subtitle ? `<div class="reminder-date">${subtitle}</div>` : ''}
            </div>
            ${hasInfo ? '<svg class="reminder-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
        </div>`;
    }

    function wireReminderClicks(container) {
        container.querySelectorAll('.reminder-row[data-reminder]').forEach(row => {
            row.addEventListener('click', () => {
                const name = row.dataset.reminder;
                const info = REMINDER_INFO[name];
                if (!info) return;
                showReminderModal(name, info);
            });
        });
    }

    function showReminderModal(name, info) {
        const existing = $('.reminder-modal-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'reminder-modal-overlay';
        overlay.innerHTML = `
            <div class="reminder-modal">
                <div class="reminder-modal-header">
                    <h3>${name}</h3>
                    <button type="button" class="reminder-modal-close" aria-label="Close">&times;</button>
                </div>
                <div class="reminder-modal-body">
                    <div class="reminder-modal-text">${info.text}</div>
                    ${info.source ? `<div class="reminder-modal-source">${info.source}</div>` : ''}
                </div>
                <div class="reminder-modal-links">
                    ${info.quranUrl ? `<a href="#" class="reminder-modal-link" data-url="${info.quranUrl}">Read Surah</a>` : ''}
                    ${info.url ? `<a href="#" class="reminder-modal-link reminder-modal-link-secondary" data-url="${info.url}">View Hadith</a>` : ''}
                </div>
            </div>`;

        document.body.appendChild(overlay);

        overlay.querySelector('.reminder-modal-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        overlay.querySelectorAll('.reminder-modal-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                openUrl(link.dataset.url);
            });
        });
    }

    /* ── Day Modal ───────────────────────────────────────────── */
    window.handleDayClick = function(e, key) {
        e.stopPropagation();
        openDayModal(key);
    };

    const CHECK_GLYPH = '<polyline points="20,6 9,17 4,12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
    const QYAAM_GLYPH = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/><circle cx="4" cy="12" r="0.8" fill="currentColor"/>';
    const FASTING_GLYPH = '<path d="M6 2h12M6 22h12M6 2c0 4 4 5 4 8s-4 4-4 8h12c0-4-4-5-4-8s4-4 4-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
    const DUHA_GLYPH = '<circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';
    const SHAFA_WITR_GLYPH = '<path d="M12 3C7.03 3 3 7.03 3 12s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36A5.39 5.39 0 0 1 14.4 14 5.4 5.4 0 0 1 9 8.6c0-1.07.31-2.07.85-2.91C10.26 3.26 11.06 3 12 3z" stroke="currentColor" stroke-width="1.5" fill="none"/>';

    function toggleExtra(key, field) {
        const d = dayData(key);
        d[field] = !d[field];
        save(KEYS.PRAYERS, S.prayers);
        openDayModal(key);
        render();
    }

    function openDayModal(key) {
        clearModalHeaderActions();
        const dd = dayData(key);
        const [y, m, d] = key.split('-').map(Number);
        const md = HijriCalendar.getMonthData(y, m);
        const greg = HijriCalendar.hijriToGregorian(y, m, d);
        const gFmt = fmtFullDate(greg);

        const modal = $('#modal-backdrop');
        const content = $('#modal-content');
        if (!modal || !content) return;

        $('#modal-title').textContent = `${md.monthName} ${d}, ${y}`;

        const rakaat = dd.qyaamRakaat || 0;

        const isToday = key === todayKey();
        const nowFull = new Date();
        const nowMidnight = new Date(nowFull); nowMidnight.setHours(0, 0, 0, 0);
        const gregMidnight = new Date(greg); gregMidnight.setHours(0, 0, 0, 0);
        const dayDiff = Math.round((gregMidnight - nowMidnight) / 86400000);
        const isFutureDay = dayDiff >= 2;

        const prayerPassed = isFutureDay
            ? Object.fromEntries(PRAYERS.map(p => [p.id, false]))
            : (dayDiff === 0 || isToday)
                ? computePassedPrayers(nowFull)
                : Object.fromEntries(PRAYERS.map(p => [p.id, true]));

        content.innerHTML = `
            <div class="day-modal-simple">
                <div class="modal-date-header">
                    <div class="hijri-date">${md.monthName} ${d}, ${y}</div>
                    <div class="gregorian-date">${gFmt}</div>
                </div>

                ${isFutureDay ? '<div class="day-future-note">Future day</div>' : ''}

                <!-- Section: Daily Prayers (5) -->
                <div class="day-section">
                    <div class="day-section-head">
                        <h4>Daily Prayers</h4>
                        ${!isFutureDay ? `<div class="day-section-actions">
                            <button type="button" class="section-mini-btn" data-action="alldone" title="Mark all 5 as prayed">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><polyline points="20,6 9,17 4,12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                                All
                            </button>
                            <button type="button" class="section-mini-btn" data-action="clear" title="Clear the 5 daily prayers">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M8 12h8" stroke="currentColor" stroke-width="1.5"/></svg>
                                Clear
                            </button>
                        </div>` : ''}
                    </div>
                    <div class="modal-prayer-icons">
                        ${PRAYERS.map(p => {
                            const done = dd[p.id];
                            const autoMissed = dd[`${p.id}_auto_missed`] && !done;
                            const future = !prayerPassed[p.id] && !done;
                            const name = prayerName(p.id, greg);
                            const missedTag = autoMissed
                                ? '<span class="mpi-missed-tag" title="This prayer was flagged as missed for this day">MISSED</span>'
                                : '';
                            const cls = done ? ' completed' : autoMissed ? ' missed' : future ? ' future' : '';
                            return `
                            <button type="button" class="modal-prayer-icon${cls}" data-prayer="${p.id}" data-key="${key}" ${future ? 'disabled' : ''}>
                                <div class="mpi-circle">
                                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">${done ? '<polyline points="20,6 9,17 4,12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' : PRAYER_ICONS[p.id]}</svg>
                                </div>
                                <span class="mpi-name">${name}</span>
                                <span class="mpi-time">${p.time}</span>
                                ${missedTag}
                            </button>`;
                        }).join('')}
                    </div>

                    <!-- Mark-missed row: explicit per-prayer buttons to flag a prayer as
                         missed for THIS specific day. Creates a qadaa-auto goal with
                         missedOn = this day, so the calendar cell shows MISSED. -->
                    ${!isFutureDay ? `<div class="modal-mark-missed-row">
                        <span class="mmr-label">Mark as missed:</span>
                        ${PRAYERS.map(p => {
                            const done = dd[p.id];
                            const missed = dd[`${p.id}_auto_missed`];
                            const notYet = !prayerPassed[p.id];
                            const disabled = done || missed || notYet;
                            return `
                            <button type="button" class="mmr-btn${missed ? ' active' : ''}" data-miss-prayer="${p.id}" data-key="${key}"
                                ${disabled ? 'disabled' : ''}
                                title="${done ? 'Already prayed' : missed ? 'Already marked missed' : notYet ? 'Not yet' : `Mark ${p.name} as missed`}">
                                ${p.name}
                            </button>`;
                        }).join('')}
                    </div>` : ''}
                </div>

                <div class="day-divider"></div>

                <!-- Section: Extras + Qadaa side-by-side as icon cards -->
                <div class="day-section">
                    <div class="day-section-head"><h4>Extras &amp; Qadaa</h4></div>
                    <div class="day-extras-row day-extras-row-5">
                        <!-- Fasting card -->
                        <button type="button" class="day-extra-card${dd.fasting ? ' on' : ''}" data-action="fasting">
                            <div class="dec-circle dec-fasting">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">${dd.fasting ? CHECK_GLYPH : FASTING_GLYPH}</svg>
                            </div>
                            <span class="dec-name">Fasting</span>
                            <span class="dec-sub">${dd.fasting ? 'Observed' : ''}</span>
                        </button>

                        <!-- Duha card -->
                        <button type="button" class="day-extra-card${dd.duha ? ' on' : ''}" data-action="duha">
                            <div class="dec-circle dec-duha">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">${dd.duha ? CHECK_GLYPH : DUHA_GLYPH}</svg>
                            </div>
                            <span class="dec-name">Duha</span>
                            <span class="dec-sub">${dd.duha ? 'Prayed' : ''}</span>
                        </button>

                        <!-- Shaf'a & Witr card -->
                        <button type="button" class="day-extra-card${dd.shafaWitr ? ' on' : ''}" data-action="shafaWitr">
                            <div class="dec-circle dec-shafa-witr">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">${dd.shafaWitr ? CHECK_GLYPH : SHAFA_WITR_GLYPH}</svg>
                            </div>
                            <span class="dec-name">Shaf'a & Witr</span>
                            <span class="dec-sub">${dd.shafaWitr ? 'Prayed' : ''}</span>
                        </button>

                        <!-- Qyaam card -->
                        <button type="button" class="day-extra-card${dd.qyaam ? ' on' : ''}" data-action="qyaam-toggle">
                            <div class="dec-circle dec-qyaam">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">${dd.qyaam ? CHECK_GLYPH : QYAAM_GLYPH}</svg>
                            </div>
                            <span class="dec-name">Qyaam</span>
                            <span class="dec-sub">${dd.qyaam ? `${rakaat} raka${rakaat === 1 ? 'ah' : 'at'}` : ''}</span>
                        </button>

                        <!-- Qadaa card: record DONE qadaa for this day -->
                        ${(() => {
                            const qg = getGoals().find(x => x.type === 'qadaa');
                            const qga = getGoals().find(x => x.type === 'qadaa-auto');
                            const totalRemaining = (qg ? qg.remaining : 0) + (qga ? qga.remaining : 0);
                            const disabled = totalRemaining <= 0;
                            return `
                            <button type="button" class="day-extra-card day-extra-card-qadaa${disabled ? ' disabled' : ''}" data-action="qadaa-record" ${disabled ? 'disabled' : ''}>
                                <div class="dec-circle dec-qadaa">
                                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 2L15.09 8.26L22 9L16 14.74L17.18 21.02L12 18L6.82 21.02L8 14.74L2 9L8.91 8.26L12 2Z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
                                </div>
                                <span class="dec-name">Qadaa</span>
                                <span class="dec-sub">${disabled ? 'All caught up' : `${totalRemaining} remaining`}</span>
                            </button>`;
                        })()}
                    </div>

                    ${dd.qyaam ? `
                    <div class="rakaat-controls">
                        <span class="rkt-label">Raka'at</span>
                        <button type="button" class="rkt-btn" data-rkt="-1" title="-1">−</button>
                        <span class="rkt-num">${rakaat}</span>
                        <button type="button" class="rkt-btn" data-rkt="1" title="+1">+</button>
                        <div class="rkt-presets">
                            <button type="button" class="rkt-preset${rakaat === 2 ? ' active' : ''}" data-rkt-set="2">2</button>
                            <button type="button" class="rkt-preset${rakaat === 4 ? ' active' : ''}" data-rkt-set="4">4</button>
                            <button type="button" class="rkt-preset${rakaat === 8 ? ' active' : ''}" data-rkt-set="8">8</button>
                            <button type="button" class="rkt-preset${rakaat === 11 ? ' active' : ''}" data-rkt-set="11">11</button>
                        </div>
                    </div>` : ''}
                </div>

                <!-- Create a goal shortcut -->
                <div class="day-section">
                    <button type="button" class="day-creategoal-btn" data-action="create-goal">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                        <span>Create a new goal</span>
                    </button>
                </div>
            </div>`;


        
        $$('.modal-prayer-icon', content).forEach(btn => {
            btn.addEventListener('click', () => {
                const pid = btn.dataset.prayer;
                const k = btn.dataset.key;
                const d2 = dayData(k);
                const wasOn = !!d2[pid];
                d2[pid] = !wasOn;

                // If we just marked a prayer as PRAYED and that same prayer was auto-missed
                // on this day, reconcile: clear the flag and decrement the matching qadaa-auto
                // goal so the calendar MISSED badge disappears immediately (no page refresh needed).
                if (!wasOn && d2[pid]) {
                    if (d2[`${pid}_auto_missed`]) {
                        delete d2[`${pid}_auto_missed`];
                        const matchingGoal = getGoals().find(g => {
                            if (g.type !== 'qadaa-auto' || !g.missedOn) return false;
                            const gd = new Date(g.missedOn);
                            const gh = HijriCalendar.gregorianToHijri(gd);
                            const [y, m, day] = k.split('-').map(Number);
                            return gh.year === y && gh.month === m && gh.day === day
                                && ((g.perPrayer && g.perPrayer[pid] > 0) || g.prayerId === pid);
                        });
                        if (matchingGoal) recordQadaaPrayers(matchingGoal, pid, 1);
                    }
                }

                save(KEYS.PRAYERS, S.prayers);
                render();
                openDayModal(k);
            });
        });

        // Mark-missed buttons: flag a prayer as missed for THIS specific day and create
        // a qadaa-auto goal dated to THIS day (so the calendar cell shows MISSED and the
        // goal is anchored to the day the prayer was actually missed — not "today").
        $$('.mmr-btn', content).forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                const pid = btn.dataset.missPrayer;
                const k = btn.dataset.key;
                const d2 = dayData(k);
                if (d2[pid] || d2[`${pid}_auto_missed`]) return;
                d2[`${pid}_auto_missed`] = true;
                // Build an ISO date for noon-of-this-day so Hijri conversion is stable
                const [yy, mm, dd2] = k.split('-').map(Number);
                const gregOfDay = HijriCalendar.hijriToGregorian(yy, mm, dd2);
                gregOfDay.setHours(12, 0, 0, 0);
                addAutoMissedGoal(pid, gregOfDay.toISOString());
                save(KEYS.PRAYERS, S.prayers);
                render();
                openDayModal(k);
                const pName = PRAYER_MAP[pid]?.name || pid;
                toast(`${pName} marked missed`);
            });
        });

        
        content.querySelector('[data-action="qyaam-toggle"]')?.addEventListener('click', () => {
            const d2 = dayData(key);
            d2.qyaam = !d2.qyaam;
            if (d2.qyaam && !d2.qyaamRakaat) d2.qyaamRakaat = 2; // default 2 raka'at
            save(KEYS.PRAYERS, S.prayers);
            render();
            openDayModal(key);
        });

        
        $$('.rkt-btn', content).forEach(btn => {
            btn.addEventListener('click', () => {
                const d2 = dayData(key);
                const delta = parseInt(btn.dataset.rkt);
                d2.qyaamRakaat = Math.max(0, (d2.qyaamRakaat || 0) + delta);
                if (d2.qyaamRakaat === 0) d2.qyaam = false;
                save(KEYS.PRAYERS, S.prayers);
                render();
                openDayModal(key);
            });
        });

        
        $$('.rkt-preset', content).forEach(btn => {
            btn.addEventListener('click', () => {
                const d2 = dayData(key);
                d2.qyaamRakaat = parseInt(btn.dataset.rktSet);
                d2.qyaam = true;
                save(KEYS.PRAYERS, S.prayers);
                render();
                openDayModal(key);
            });
        });

        
        content.querySelector('[data-action="duha"]')?.addEventListener('click', () => toggleExtra(key, 'duha'));
        content.querySelector('[data-action="shafaWitr"]')?.addEventListener('click', () => toggleExtra(key, 'shafaWitr'));

        content.querySelector('[data-action="fasting"]')?.addEventListener('click', () => {
            const d2 = dayData(key);
            if (d2.fasting) {
                // Toggling OFF — just unmark
                d2.fasting = false;
                save(KEYS.PRAYERS, S.prayers);
                render();
                openDayModal(key);
                return;
            }
            // Toggling ON — check if qadaa fasting goal exists
            const fastGoal = getGoals().find(g => g.type === 'qadaa-fast' && g.remaining > 0);
            if (fastGoal) {
                // Ask user: count toward qadaa or voluntary?
                d2.fasting = true;
                save(KEYS.PRAYERS, S.prayers);
                const modal = $('#modal-backdrop');
                const mc = $('#modal-content');
                if (!modal || !mc) return;
                $('#modal-title').textContent = 'Fasting';
                mc.innerHTML = `
                    <div style="display:flex;flex-direction:column;gap:var(--sp-4)">
                        <p style="color:var(--text-secondary);font-size:14px">You have ${fastGoal.remaining} qadaa fasting day${fastGoal.remaining === 1 ? '' : 's'} remaining. Count this toward qadaa?</p>
                        <div style="display:flex;gap:var(--sp-3)">
                            <button type="button" class="btn btn-primary" id="fast-qadaa" style="flex:1">Qadaa</button>
                            <button type="button" class="btn btn-secondary" id="fast-voluntary" style="flex:1">Voluntary</button>
                        </div>
                    </div>`;
                $('#fast-qadaa')?.addEventListener('click', () => {
                    fastGoal.remaining = Math.max(0, fastGoal.remaining - 1);
                    fastGoal.notes = fastGoal.notes || [];
                    fastGoal.notes.push({ date: new Date().toISOString(), text: 'Fasted 1 day', amount: -1 });
                    saveGoals();
                    render();
                    openDayModal(key);
                    toast('Qadaa fasting recorded');
                });
                $('#fast-voluntary')?.addEventListener('click', () => {
                    render();
                    openDayModal(key);
                    toast('Voluntary fast marked');
                });
            } else {
                d2.fasting = true;
                save(KEYS.PRAYERS, S.prayers);
                render();
                openDayModal(key);
            }
        });

        
        content.querySelector('[data-action="alldone"]')?.addEventListener('click', () => {
            const d2 = dayData(key);
            PRAYERS.forEach(p => { if (prayerPassed[p.id]) d2[p.id] = true; });
            save(KEYS.PRAYERS, S.prayers);
            render();
            openDayModal(key);
        });

        content.querySelector('[data-action="clear"]')?.addEventListener('click', () => {
            const d2 = dayData(key);
            PRAYERS.forEach(p => { if (prayerPassed[p.id]) d2[p.id] = false; });
            save(KEYS.PRAYERS, S.prayers);
            render();
            openDayModal(key);
        });

        
        content.querySelector('[data-action="add-qadaa"]')?.addEventListener('click', () => {
            openAddQadaaModal(key);
        });

        // Create a new goal — opens the Add Goal modal with a "Back" trail to this day
        content.querySelector('[data-action="create-goal"]')?.addEventListener('click', () => {
            openAddGoalModal({ backToDay: key });
        });

        // Open Record Qadaa modal — user prayed qadaa for this day
        content.querySelector('[data-action="qadaa-record"]')?.addEventListener('click', () => {
            openRecordQadaaModal(key);
        });

        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
    }

    /* ── Record Qadaa Done modal (user prayed qadaa today) ─────
     * Different from openAddQadaaModal (which adds MISSED prayers).
     * This DECREMENTS the Qadaa goal counters.
     */
    function openRecordQadaaModal(sourceKey) {
        const modal = $('#modal-backdrop');
        const content = $('#modal-content');
        if (!modal || !content) return;

        // All OPEN qadaa-type goals (manual + any per-prayer auto-missed)
        const openGoals = getGoals().filter(g =>
            isQadaaGoal(g) && g.remaining > 0
        );

        let sourceLabel = '';
        if (sourceKey) {
            const [yy, mm, dd2] = sourceKey.split('-').map(Number);
            const md = HijriCalendar.getMonthData(yy, mm);
            sourceLabel = `${md.monthName} ${dd2}`;
        }

        $('#modal-title').textContent = sourceKey ? `Record Qadaa — ${sourceLabel}` : 'Record Qadaa';
        clearModalHeaderActions();

        if (openGoals.length === 0) {
            content.innerHTML = `
                <div class="goals-empty">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><polyline points="20,6 9,17 4,12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    <span>All caught up!</span>
                </div>
                <div class="goal-modal-actions">
                    <button type="button" class="btn btn-primary" id="rec-done" style="flex:1">${sourceKey ? 'Back' : 'Close'}</button>
                </div>`;
            $('#rec-done')?.addEventListener('click', () => {
                if (sourceKey) openDayModal(sourceKey);
                else closeAllModals();
            });
            modal.classList.add('active');
            modal.setAttribute('aria-hidden', 'false');
            return;
        }

        // Picker state — which goal we're recording against
        let targetId = null; // goal index in the full goals array

        function resolveInitialTarget() {
            const goals = getGoals();
            // Prefer a qadaa-auto goal older than others (closest miss first)
            const autos = goals
                .map((g, idx) => ({ g, idx }))
                .filter(x => x.g.type === 'qadaa-auto' && x.g.remaining > 0)
                .sort((a, b) => new Date(a.g.missedOn || 0) - new Date(b.g.missedOn || 0));
            if (autos.length) return autos[0].idx;
            const manual = goals.findIndex(g => g.type === 'qadaa' && g.remaining > 0);
            return manual >= 0 ? manual : 0;
        }

        targetId = resolveInitialTarget();
        const sessionLog = [];

        function getTargetGoal() {
            return getGoals()[targetId];
        }

        function goalLabel(g) {
            if (g.type === 'qadaa-auto') {
                return `${esc(g.name) || 'Missed'}${g.missedOnLabel ? ' · ' + esc(g.missedOnLabel) : ''}`;
            }
            return esc(g.name) || 'Qadaa Prayers';
        }

        // Render whole modal body — re-rendered when target or data changes
        function renderBody() {
            const g = getTargetGoal();
            if (!g) {
                closeAllModals();
                return;
            }
            ensurePerPrayer(g);
            const done = g.total - g.remaining;
            const pct = g.total > 0 ? Math.round((done / g.total) * 100) : 0;
            const isAuto = g.type === 'qadaa-auto';

            // Goal picker — all open qadaa goals
            const allOpen = getGoals()
                .map((x, idx) => ({ g: x, idx }))
                .filter(x => (x.g.type === 'qadaa' || x.g.type === 'qadaa-auto') && x.g.remaining > 0);

            const pickerHTML = allOpen.length > 1 ? `
                <div class="settings-section">
                    <h4>Goal</h4>
                    <select class="app-input recq-goal-select" id="recq-goal-picker">
                        ${allOpen.map(x => `
                            <option value="${x.idx}" ${x.idx === targetId ? 'selected' : ''}>
                                ${goalLabel(x.g)} — ${x.g.remaining} remaining
                            </option>
                        `).join('')}
                    </select>
                </div>` : '';

            const targetGoalBadge = (isAuto && !g.isManual)
                ? '<span class="recq-goal-tag recq-goal-tag-auto">AUTO</span>'
                : '';

            content.innerHTML = `
                <div class="record-qadaa-modal">
                    ${pickerHTML}

                    <!-- Prominent goal header — makes it obvious which goal we're decrementing -->
                    <div class="recq-goal-card recq-goal-card-${isAuto ? 'auto' : 'manual'}">
                        <div class="recq-goal-top">
                            <span class="recq-goal-name">${goalLabel(g)} ${targetGoalBadge}</span>
                            <span class="recq-goal-num"><strong>${done}</strong> / ${g.total}</span>
                        </div>
                        <div class="goal-bar"><div class="goal-bar-fill ${isAuto ? 'fill-danger' : 'fill-blue'}" style="width:${pct}%"></div></div>
                        <div class="recq-goal-footer">
                            <div class="recq-goal-sub">${g.remaining} remaining</div>
                            <button type="button" class="recq-open-goal" id="recq-open-goal" title="Open this goal">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M7 17L17 7M17 7H7M17 7V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                                <span>Goal</span>
                            </button>
                        </div>
                    </div>

                    <div class="settings-section">
                        <h4>${isAuto ? 'Prayer' : 'By prayer'}</h4>
                        <div class="qadaa-prayer-list" id="rec-prayer-list"></div>
                    </div>

                    ${!isAuto ? `
                    <div class="settings-section">
                        <h4>Full days <span class="info-tip" data-hint="One tap = 1 of each prayer (max available).">?</span></h4>
                        <div class="recqadaa-bulk">
                            <button type="button" class="btn btn-secondary" data-days="1">1 day</button>
                            <button type="button" class="btn btn-secondary" data-days="2">2 days</button>
                            <button type="button" class="btn btn-secondary" data-days="3">3 days</button>
                        </div>
                    </div>` : ''}

                    <div class="addqadaa-log">
                        <h4>Recent activity <span class="info-tip" data-hint="Tap any row to undo that action. Session items first, older history below.">?</span></h4>
                        <div class="addqadaa-log-list" id="rec-log"><span class="aq-empty">No activity yet</span></div>
                    </div>

                    <div class="goal-modal-actions">
                        <button type="button" class="btn btn-primary" id="rec-done" style="flex:1">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><polyline points="15,18 9,12 15,6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                            Back
                        </button>
                    </div>
                </div>`;

            refreshPrayerList();
            renderLog();

            // Goal picker
            $('#recq-goal-picker')?.addEventListener('change', (e) => {
                targetId = parseInt(e.target.value);
                renderBody();
            });

            // Open-goal shortcut — jumps to the goal detail.
            // Back-chip returns to Record Qadaa (which itself has its own Back to day).
            $('#recq-open-goal')?.addEventListener('click', () => {
                const backTarget = {
                    label: sourceKey ? 'Back to Qadaa' : 'Back',
                    onClick: () => openRecordQadaaModal(sourceKey),
                };
                const g = getGoals()[targetId];
                if (g && g.type === 'qadaa-auto' && !g.isManual) {
                    openAutoMissedGoalDetail(targetId, { backToDay: backTarget });
                } else {
                    openGoalDetail(targetId, { backToDay: backTarget });
                }
            });

            // Full-day buttons
            $$('[data-days]', content).forEach(btn => {
                btn.addEventListener('click', () => {
                    const days = parseInt(btn.dataset.days);
                    const g2 = getTargetGoal();
                    if (!g2) return;
                    ensurePerPrayer(g2);
                    const snap = { perPrayer: { ...g2.perPrayer }, remaining: g2.remaining, notesLen: (g2.notes||[]).length };
                    let totalDeducted = 0;
                    for (let d = 0; d < days; d++) {
                        const mix = {};
                        let any = false;
                        PRAYERS.forEach(p => {
                            if ((g2.perPrayer[p.id] || 0) >= 1) { mix[p.id] = 1; any = true; }
                        });
                        if (!any) break;
                        const rec = recordQadaaPrayers(g2, mix, 1, { silent: true });
                        totalDeducted += rec;
                    }
                    if (totalDeducted === 0) { toast('Nothing to record'); return; }
                    // One consolidated note
                    g2.notes = g2.notes || [];
                    g2.notes.push({ date: new Date().toISOString(), text: `${totalDeducted} prayers — ${days} day${days === 1 ? '' : 's'}`, amount: -totalDeducted, sourceKey: sourceKey || null });
                    saveGoals();

                    // Mark the source day as "prayed qadaa" for every prayer involved
                    let dayFlagsSet = [];
                    if (sourceKey) {
                        const d2 = dayData(sourceKey);
                        PRAYERS.forEach(p => {
                            if (!d2[`${p.id}_qadaa_recorded`]) {
                                d2[`${p.id}_qadaa_recorded`] = true;
                                dayFlagsSet.push(p.id);
                            }
                        });
                        if (dayFlagsSet.length) save(KEYS.PRAYERS, S.prayers);
                    }

                    sessionLog.push({
                        text: `${totalDeducted} prayer${totalDeducted === 1 ? '' : 's'} — ${days} day${days === 1 ? '' : 's'}`,
                        undo: () => {
                            g2.perPrayer = snap.perPrayer;
                            g2.remaining = snap.remaining;
                            if (g2.notes) g2.notes.length = snap.notesLen;
                            saveGoals();
                            if (dayFlagsSet.length && sourceKey) {
                                const d3 = dayData(sourceKey);
                                dayFlagsSet.forEach(pid => delete d3[`${pid}_qadaa_recorded`]);
                                save(KEYS.PRAYERS, S.prayers);
                            }
                        },
                    });
                    renderBody();
                    renderGoals();
                    renderCalendar();
                });
            });

            $('#rec-done')?.addEventListener('click', () => {
                if (sourceKey) openDayModal(sourceKey);
                else closeAllModals();
            });
        }

        function refreshPrayerList() {
            const list = $('#rec-prayer-list');
            const g = getTargetGoal();
            if (!list || !g) return;
            ensurePerPrayer(g);
            // For auto-missed (per-prayer) goals, only render the prayer that's actually tracked
            const prayersToShow = g.type === 'qadaa-auto'
                ? PRAYERS.filter(p => (g.perPrayer[p.id] || 0) > 0)
                : PRAYERS;
            // Switch to compact grid when showing all 5; keep rows for single-prayer (auto) case
            const useGrid = prayersToShow.length > 1;
            list.className = useGrid ? 'pp-compact-grid' : 'qadaa-prayer-list';
            list.innerHTML = prayersToShow.map(p => {
                const left = g.perPrayer[p.id] || 0;
                const disabled = left <= 0;
                if (useGrid) {
                    return `
                    <div class="pp-cell">
                        <button type="button" class="pp-tap${disabled ? ' disabled' : ''}" data-prayer="${p.id}" ${disabled ? 'disabled' : ''} title="Record 1 ${p.name}">
                            <div class="pp-circle pp-${p.id}">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">${PRAYER_ICONS[p.id]}</svg>
                            </div>
                            <span class="pp-name">${p.name}</span>
                        </button>
                        <div class="pp-row pp-row-readonly">
                            <span class="pp-count">${left}</span>
                        </div>
                    </div>`;
                }
                // Single prayer (auto-missed) — single big card
                return `
                <div class="qadaa-prayer-row">
                    <button type="button" class="qpr-main${disabled ? ' disabled' : ''}" data-prayer="${p.id}" ${disabled ? 'disabled' : ''}>
                        <div class="qpr-circle qpr-${p.id}">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">${PRAYER_ICONS[p.id]}</svg>
                        </div>
                        <span class="qpr-name">${p.name}</span>
                    </button>
                    <div class="qpr-stepper qpr-stepper-readonly">
                        <span class="qpr-count">${left}</span>
                    </div>
                </div>`;
            }).join('');

            
            $$('.pp-tap, .qpr-main', list).forEach(btn => {
                btn.addEventListener('click', () => {
                    const pid = btn.dataset.prayer;
                    const g2 = getTargetGoal();
                    if (!g2 || (g2.perPrayer[pid] || 0) <= 0) return;
                    const snap = { perPrayer: { ...g2.perPrayer }, remaining: g2.remaining, notesLen: (g2.notes||[]).length };
                    recordQadaaPrayers(g2, pid, 1);

                    // Mark the source day on the calendar so the badge shows
                    let dayFlagWasSet = false;
                    if (sourceKey) {
                        const d2 = dayData(sourceKey);
                        if (!d2[`${pid}_qadaa_recorded`]) {
                            d2[`${pid}_qadaa_recorded`] = true;
                            dayFlagWasSet = true;
                            save(KEYS.PRAYERS, S.prayers);
                        }
                    }

                    const pName = PRAYER_MAP[pid].name;
                    sessionLog.push({
                        text: `1 ${pName}`,
                        undo: () => {
                            g2.perPrayer = snap.perPrayer;
                            g2.remaining = snap.remaining;
                            if (g2.notes) g2.notes.length = snap.notesLen;
                            saveGoals();
                            if (dayFlagWasSet && sourceKey) {
                                const d3 = dayData(sourceKey);
                                delete d3[`${pid}_qadaa_recorded`];
                                save(KEYS.PRAYERS, S.prayers);
                            }
                        },
                    });
                    renderBody();
                    renderGoals();
                    renderCalendar();
                });
            });
        }

        function renderLog() {
            const el = $('#rec-log');
            if (!el) return;
            const g = getTargetGoal();
            if (!g) { el.innerHTML = ''; return; }

            // Persistent goal notes (non-session). Filter to record-type notes only.
            const persistentNotes = (g.notes || [])
                .map((n, i) => ({ n, i }))
                .filter(x => x.n && x.n.amount != null && x.n.amount < 0);

            if (sessionLog.length === 0 && persistentNotes.length === 0) {
                el.innerHTML = '<span class="aq-empty">No activity yet</span>';
                return;
            }

            const todayStr = fmtShortDate(new Date());
            const sessionRows = sessionLog.map((entry, i) => `
                <button type="button" class="aq-log-row aq-log-session" data-scope="session" data-i="${i}" title="Tap to undo">
                    <span class="aq-log-text">${entry.text}</span>
                    <span class="aq-log-date">${todayStr}</span>
                    <span class="aq-undo-hint" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 14l-4-4 4-4M5 10h9a5 5 0 0 1 0 10h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </span>
                </button>`).join('');

            // Hide persistent notes that were added during this session (they'd be
            // duplicates of session rows). Keep older history visible.
            const notesBeforeSession = (g.notes || []).length - sessionLog.length;
            const olderNotes = persistentNotes.filter(x => x.i < notesBeforeSession);
            const historyRows = olderNotes.slice(-8).reverse().map(({ n, i }) => {
                const dateStr = n.date ? fmtShortDate(n.date) : '';
                return `
                <button type="button" class="aq-log-row aq-log-history" data-scope="history" data-i="${i}" title="Tap to undo">
                    <span class="aq-log-text">${n.text || '—'}</span>
                    <span class="aq-log-date">${dateStr}</span>
                    <span class="aq-undo-hint" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 14l-4-4 4-4M5 10h9a5 5 0 0 1 0 10h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </span>
                </button>`;
            }).join('');

            const showOlderLabel = sessionRows && olderNotes.length > 3;
            el.innerHTML = sessionRows + (historyRows ? `
                ${showOlderLabel ? '<div class="aq-log-divider">Older</div>' : ''}
                ${historyRows}
            ` : '');

            // Session-row undo
            $$('.aq-log-row[data-scope="session"]', el).forEach(btn => {
                btn.addEventListener('click', () => {
                    const i = parseInt(btn.dataset.i);
                    if (sessionLog[i]) {
                        sessionLog[i].undo();
                        sessionLog.splice(i, 1);
                        renderBody();
                        renderGoals();
                    }
                });
            });

            // History-row undo — reverse the persistent note's amount against the goal
            $$('.aq-log-row[data-scope="history"]', el).forEach(btn => {
                btn.addEventListener('click', () => {
                    if (!btn.classList.contains('confirm')) {
                        btn.classList.add('confirm');
                        btn.querySelector('.aq-log-text').textContent = 'Tap again to undo';
                        setTimeout(() => {
                            if (btn.isConnected) {
                                btn.classList.remove('confirm');
                                renderLog();
                            }
                        }, 3000);
                        return;
                    }
                    const i = parseInt(btn.dataset.i);
                    const g2 = getTargetGoal();
                    if (!g2 || !g2.notes || !g2.notes[i]) return;
                    const note = g2.notes[i];
                    ensurePerPrayer(g2);
                    const reverse = -note.amount;
                    g2.remaining = Math.max(0, Math.min(g2.total, g2.remaining + reverse));
                    if (note.prayer && g2.perPrayer[note.prayer] !== undefined) {
                        g2.perPrayer[note.prayer] = Math.max(0, g2.perPrayer[note.prayer] + reverse);
                    }
                    // Clear qadaa_recorded flags on the source day
                    if (note.sourceKey) {
                        const dd = dayData(note.sourceKey);
                        PRAYERS.forEach(p => { delete dd[`${p.id}_qadaa_recorded`]; });
                        save(KEYS.PRAYERS, S.prayers);
                    }
                    g2.notes.splice(i, 1);
                    saveGoals();
                    renderBody();
                    renderGoals();
                    renderCalendar();
                    toast(`Undone: ${note.text || 'entry'}`);
                });
            });
        }

        renderBody();
        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
    }

    /* ── Add Qadaa modal (from a day) ─────────────────────────
     * Lets the user record missed items for this specific day.
     * Marks them on the calendar AND adds to goals.
     */
    function openAddQadaaModal(key) {
        clearModalHeaderActions();
        const dd = dayData(key);
        const [y, m, d] = key.split('-').map(Number);
        const md = HijriCalendar.getMonthData(y, m);

        const modal = $('#modal-backdrop');
        const content = $('#modal-content');
        if (!modal || !content) return;

        $('#modal-title').textContent = `Record missed: ${md.monthName} ${d}`;

        content.innerHTML = `
            <div class="addqadaa-modal">
                <div class="settings-section">
                    <h4>Missed prayers</h4>
                    <div class="addq-prayer-grid">
                        ${PRAYERS.map(p => {
                            const alreadyAuto = dd[`${p.id}_auto_missed`];
                            const alreadyDone = dd[p.id];
                            return `
                            <button type="button" class="addq-prayer-btn" data-prayer="${p.id}" ${alreadyDone || alreadyAuto ? 'disabled' : ''} title="${alreadyDone ? 'Already prayed' : alreadyAuto ? 'Already auto-missed' : `Mark ${p.name} as missed`}">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">${PRAYER_ICONS[p.id]}</svg>
                                <span>${p.name}</span>
                            </button>`;
                        }).join('')}
                    </div>
                    <div class="addq-bulk-row">
                        <button type="button" class="btn btn-secondary" id="addq-allday">Full day missed (–5)</button>
                    </div>
                </div>

                <div class="settings-section">
                    <h4>Missed fasting</h4>
                    <button type="button" class="day-toggle-btn" id="addq-fasting">
                        <div class="mpi-circle">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">${FASTING_GLYPH}</svg>
                        </div>
                        <div class="dtb-info">
                            <div class="dtb-label">Add to Qadaa Fasting</div>
                        </div>
                    </button>
                </div>

                <div class="modal-actions" style="display:flex;gap:var(--sp-3);margin-top:var(--sp-4)">
                    <button type="button" class="btn btn-secondary" id="addq-done">Done</button>
                </div>
            </div>`;

        // Mark prayer as missed for this day + add to qadaa goal
        $$('.addq-prayer-btn', content).forEach(btn => {
            btn.addEventListener('click', () => {
                const pid = btn.dataset.prayer;
                const d2 = dayData(key);
                d2[`${pid}_missed`] = true; // mark on calendar
                save(KEYS.PRAYERS, S.prayers);
                addQadaaPrayers(pid, 1, 'qadaa', `Missed ${prayerById(pid).name} on ${md.monthName} ${d}`);
                renderGoals();
                renderCalendar();
                btn.disabled = true;
                toast(`${prayerById(pid).name} added to Qadaa`);
            });
        });

        // Full day missed (all 5)
        $('#addq-allday')?.addEventListener('click', () => {
            const d2 = dayData(key);
            const mix = {};
            PRAYERS.forEach(p => {
                if (!d2[p.id] && !d2[`${p.id}_auto_missed`] && !d2[`${p.id}_missed`]) {
                    mix[p.id] = 1;
                    d2[`${p.id}_missed`] = true;
                }
            });
            const total = Object.values(mix).reduce((a, b) => a + b, 0);
            if (total === 0) { toast('Nothing new to add'); return; }
            save(KEYS.PRAYERS, S.prayers);
            addQadaaPrayers(mix, 1, 'qadaa', `Full day missed: ${md.monthName} ${d}`);
            renderGoals();
            renderCalendar();
            openAddQadaaModal(key);
            toast(`${total} added to Qadaa`);
        });

        // Fasting missed
        $('#addq-fasting')?.addEventListener('click', () => {
            const goals = getGoals();
            let fg = goals.find(g => g.type === 'qadaa-fast');
            if (!fg) {
                fg = { type: 'qadaa-fast', name: 'Qadaa Fasting', total: 1, remaining: 1, notes: [], createdAt: new Date().toISOString() };
                goals.push(fg);
            } else {
                fg.total++; fg.remaining++;
            }
            fg.notes = fg.notes || [];
            fg.notes.push({ date: new Date().toISOString(), text: `Missed fasting on ${md.monthName} ${d}`, amount: 1 });
            saveGoals();
            renderGoals();
            toast('Fasting day added');
        });

        $('#addq-done')?.addEventListener('click', () => {
            openDayModal(key);
        });

        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
    }

    function markAllPrayers(key, status) {
        const d = dayData(key);
        PRAYERS.forEach(p => d[p.id] = status);
        save(KEYS.PRAYERS, S.prayers);
        render();
        openDayModal(key);
    }

    /**
     * Create a fresh per-prayer counter object for qadaa goals.
     */
    function emptyPerPrayer() {
        return { fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 };
    }

    /**
     * Ensure goal has a per-prayer map (upgrades legacy goals).
     */
    function ensurePerPrayer(g) {
        if (!g.perPrayer) g.perPrayer = emptyPerPrayer();
        // Fix drift: if perPrayer sum < remaining, redistribute evenly
        const sum = PRAYERS.reduce((s, p) => s + (g.perPrayer[p.id] || 0), 0);
        if (sum < g.remaining) {
            const each = Math.ceil(g.remaining / 5);
            PRAYERS.forEach(p => { g.perPrayer[p.id] = each; });
        }
        return g.perPrayer;
    }

    /**
     * Find or create a qadaa goal of the given type ('qadaa' or 'qadaa-auto').
     */
    function getOrCreateQadaaGoal(type = 'qadaa') {
        const goals = getGoals();
        let g = goals.find(x => x.type === type);
        if (!g) {
            const t = GOAL_TYPES[type];
            g = {
                type, name: t.name, total: 0, remaining: 0,
                perPrayer: emptyPerPrayer(), notes: [],
                createdAt: new Date().toISOString(),
            };
            goals.push(g);
        }
        ensurePerPrayer(g);
        return g;
    }

    /**
     * Add missed prayers to a qadaa goal.
     * - prayerMix: either a prayer id ('fajr') or an object { fajr:2, dhuhr:1, ... } or 'all' for +1 each
     * - n: when prayerMix is a string id, this is the count
     * - targetType: 'qadaa' (default) or 'qadaa-auto'
     * - note: optional activity note
     */
    function addQadaaPrayers(prayerMix, n = 1, targetType = 'qadaa', note = '') {
        const g = getOrCreateQadaaGoal(targetType);
        const mix = {};

        if (prayerMix === 'all') {
            PRAYERS.forEach(p => mix[p.id] = n);
        } else if (typeof prayerMix === 'string') {
            mix[prayerMix] = n;
        } else if (prayerMix && typeof prayerMix === 'object') {
            Object.assign(mix, prayerMix);
        } else {
            // Legacy: no prayer specified, distribute to "unknown"
            mix._ = n;
        }

        let totalAdded = 0;
        Object.entries(mix).forEach(([pid, count]) => {
            if (count <= 0) return;
            totalAdded += count;
            if (g.perPrayer[pid] !== undefined) g.perPrayer[pid] += count;
        });

        g.total += totalAdded;
        g.remaining += totalAdded;

        if (note || totalAdded > 0) {
            g.notes = g.notes || [];
            const label = prayerMix === 'all'
                ? `+${n} of each prayer`
                : typeof prayerMix === 'string'
                    ? `+${n} ${prayerMix}`
                    : Object.entries(mix).map(([k, v]) => `${v} ${k}`).join(', ');
            g.notes.push({ date: new Date().toISOString(), text: note || label, amount: totalAdded });
        }

        saveGoals();
        return g;
    }

    /**
     * Record (complete) prayers on a qadaa goal.
     * mix: object { fajr:1, asr:2 } or prayer id + count.
     */
    function recordQadaaPrayers(g, prayerMix, n = 1, { silent = false } = {}) {
        ensurePerPrayer(g);
        const mix = typeof prayerMix === 'string' ? { [prayerMix]: n } : { ...prayerMix };
        let totalRecorded = 0;
        Object.entries(mix).forEach(([pid, count]) => {
            if (count <= 0) return;
            const available = g.perPrayer[pid] !== undefined ? g.perPrayer[pid] : 0;
            const take = Math.min(available, count);
            if (take > 0) {
                g.perPrayer[pid] -= take;
                totalRecorded += take;
            }
        });
        g.remaining = Math.max(0, g.remaining - totalRecorded);
        const ppSum = PRAYERS.reduce((s, p) => s + (g.perPrayer[p.id] || 0), 0);
        if (g.remaining !== ppSum) g.remaining = ppSum;
        if (totalRecorded > 0 && !silent) {
            g.notes = g.notes || [];
            const parts = Object.entries(mix).filter(([,v]) => v > 0);
            const isFullDay = parts.length === 5 && parts.every(([,v]) => v === 1);
            const label = isFullDay ? 'Full day' : parts.map(([k, v]) => `${v} ${PRAYER_MAP[k]?.name || k}`).join(', ');
            g.notes.push({ date: new Date().toISOString(), text: label, amount: -totalRecorded });
        }
        saveGoals();
        // Auto-archive the goal right after it's fully recorded. Without this, the calendar's
        // MISSED badge would keep showing until renderGoals() eventually swept the zeroed goal.
        if (totalRecorded > 0) archiveCompletedGoals();
        return totalRecorded;
    }

    /**
     * Sweep active goals: any with remaining === 0 moves to archive with { completed: true }.
     * Auto-missed goals are NOT auto-archived when pending — only when manually recorded
     * as prayed or dismissed. Completed goals of any type are archived so stats can include
     * them and the active list stays tidy.
     */
    function archiveCompletedGoals() {
        const goals = getGoals();
        const archive = S.goalsArchive = S.goalsArchive || [];
        let moved = 0;
        for (let i = goals.length - 1; i >= 0; i--) {
            const g = goals[i];
            if (g.remaining <= 0 && g.total > 0 && !g._dontArchive) {
                archive.push({ ...g, archivedAt: new Date().toISOString(), completed: true });
                goals.splice(i, 1);
                moved++;
            }
        }
        if (moved > 0) {
            save(KEYS.GOALS_ARCHIVE, archive);
            saveGoals();
        }
        return moved;
    }

    /* ── Theme ───────────────────────────────────────────────── */
    function setTheme(name) {
        S.theme = name;
        if (name === 'default') document.body.removeAttribute('data-theme');
        else document.body.setAttribute('data-theme', name);
        Storage.set(KEYS.THEME, name);
    }

    /* ── Settings ─────────────────────────────────────────── */
    function getSetting(key, fallback) {
        return S.settings[key] !== undefined ? S.settings[key] : fallback;
    }

    function setSetting(key, value) {
        S.settings[key] = value;
        save(KEYS.SETTINGS, S.settings);
    }

    function openSettingsModal(activeTab = 'general') {
        clearModalHeaderActions();
        const modal = $('#modal-backdrop');
        const content = $('#modal-content');
        if (!modal || !content) return;
        $('#modal-title').textContent = 'Settings';

        const TABS = [
            { id: 'general',   name: 'General' },
            { id: 'dashboard', name: 'Dashboard' },
            { id: 'prayers',   name: 'Prayers' },
            { id: 'data',      name: 'Data' },
            { id: 'about',     name: 'About' },
        ];

        content.innerHTML = `
            <div class="settings-modal">
                <div class="settings-tabs">
                    ${TABS.map(t => `<button type="button" class="settings-tab${t.id === activeTab ? ' active' : ''}" data-tab="${t.id}">${t.name}</button>`).join('')}
                </div>
                <div class="settings-tab-content" id="settings-tab-content">
                    ${renderSettingsTab(activeTab)}
                </div>
            </div>`;

        wireSettingsTab(activeTab);

        $$('.settings-tab', content).forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                $$('.settings-tab', content).forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                $('#settings-tab-content').innerHTML = renderSettingsTab(tab);
                wireSettingsTab(tab);
            });
        });

        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
    }

    function renderSettingsTab(tab) {
        if (tab === 'general') {
            return `
                <div class="settings-section">
                    <h4>Theme</h4>
                    <div class="theme-options theme-options-3">
                        <button type="button" class="theme-option${S.theme === 'default' ? ' active' : ''}" data-theme="default">
                            <span class="theme-swatch swatch-ocean"></span>
                            Ocean
                        </button>
                        <button type="button" class="theme-option${S.theme === 'sunset' ? ' active' : ''}" data-theme="sunset">
                            <span class="theme-swatch swatch-sunset"></span>
                            Sunset
                        </button>
                        <button type="button" class="theme-option${S.theme === 'aurora' ? ' active' : ''}" data-theme="aurora">
                            <span class="theme-swatch swatch-aurora"></span>
                            Aurora
                        </button>
                    </div>
                </div>
                <div class="settings-section">
                    <h4>Language <span class="info-tip" data-hint="More languages coming soon.">?</span></h4>
                    <select class="app-input" data-setting="language">
                        <option value="en" ${getSetting('language', 'en') === 'en' ? 'selected' : ''}>English</option>
                    </select>
                </div>`;
        }

        if (tab === 'dashboard') {
            const weekStart = getSetting('weekStart', 6);
            const showGreg = getSetting('showGregorian', true);
            const showInd = getSetting('showIndicators', true);
            const primaryCal = getSetting('primaryCalendar', 'hijri');
            const hijriOffset = getSetting('hijriOffset', 0);
            const archiveStyle = getSetting('archiveStyle', 'modal');
            return `
                <div class="settings-section">
                    <h4>Primary calendar</h4>
                    <div class="seg-toggle">
                        <button type="button" class="seg-toggle-btn${primaryCal === 'hijri' ? ' active' : ''}" data-setting="primaryCalendar" data-value="hijri">Hijri</button>
                        <button type="button" class="seg-toggle-btn${primaryCal === 'gregorian' ? ' active' : ''}" data-setting="primaryCalendar" data-value="gregorian">Gregorian</button>
                    </div>
                </div>
                <div class="settings-section">
                    <h4>Hijri adjustment <span class="settings-sub">(days)</span> <span class="info-tip" data-hint="Adjust if your local Hijri date differs by a day or two from the app.">?</span></h4>
                    <div class="seg-toggle">
                        <button type="button" class="seg-toggle-btn${hijriOffset === -2 ? ' active' : ''}" data-setting="hijriOffset" data-value="-2">−2</button>
                        <button type="button" class="seg-toggle-btn${hijriOffset === -1 ? ' active' : ''}" data-setting="hijriOffset" data-value="-1">−1</button>
                        <button type="button" class="seg-toggle-btn${hijriOffset === 0 ? ' active' : ''}" data-setting="hijriOffset" data-value="0">0</button>
                        <button type="button" class="seg-toggle-btn${hijriOffset === 1 ? ' active' : ''}" data-setting="hijriOffset" data-value="1">+1</button>
                        <button type="button" class="seg-toggle-btn${hijriOffset === 2 ? ' active' : ''}" data-setting="hijriOffset" data-value="2">+2</button>
                    </div>
                </div>
                <div class="settings-section">
                    <h4>Week starts on</h4>
                    <div class="seg-toggle">
                        <button type="button" class="seg-toggle-btn${weekStart === 0 ? ' active' : ''}" data-setting="weekStart" data-value="0">Sunday</button>
                        <button type="button" class="seg-toggle-btn${weekStart === 1 ? ' active' : ''}" data-setting="weekStart" data-value="1">Monday</button>
                        <button type="button" class="seg-toggle-btn${weekStart === 6 ? ' active' : ''}" data-setting="weekStart" data-value="6">Saturday</button>
                    </div>
                </div>
                <div class="settings-section">
                    <div class="settings-row">
                        <h4>Show Gregorian dates on cells</h4>
                        <label class="setting-toggle">
                            <input type="checkbox" data-setting="showGregorian" ${showGreg ? 'checked' : ''}>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>
                <div class="settings-section">
                    <div class="settings-row">
                        <h4>Show prayer indicators on cells</h4>
                        <label class="setting-toggle">
                            <input type="checkbox" data-setting="showIndicators" ${showInd ? 'checked' : ''}>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>
                <div class="settings-section">
                    <h4>Goal archive display</h4>
                    <div class="seg-toggle">
                        <button type="button" class="seg-toggle-btn${archiveStyle === 'modal' ? ' active' : ''}" data-setting="archiveStyle" data-value="modal">Modal</button>
                        <button type="button" class="seg-toggle-btn${archiveStyle === 'inline' ? ' active' : ''}" data-setting="archiveStyle" data-value="inline">Inline</button>
                    </div>
                </div>`;
        }

        if (tab === 'prayers') {
            const autoMiss = getSetting('autoMarkMissed', true);
            const calcMethod = getSetting('calcMethod', 'ISNA');
            const asrSchool = getSetting('asrSchool', 'standard');
            const iqama = getSetting('iqamaOffsets', {});
            const adjust = getSetting('timeAdjustments', {});
            const notif = getSetting('notifications', false);
            const loc = S.settings.location;
            // Notification sub-settings (each can be toggled independently).
            // Defaults: pre-prayer ON (15min), adhan ON, pre-iqama OFF.
            const notifPre     = getSetting('notifPreEnabled', true);
            const notifPreMin  = getSetting('notifPreMinutes', 15);
            const notifAdhan   = getSetting('notifAdhanEnabled', true);
            const notifPreIqama = getSetting('notifPreIqamaEnabled', false);
            const notifPreIqamaMin = getSetting('notifPreIqamaMinutes', 5);

            return `
                <div class="settings-section">
                    <h4>Location</h4>
                    <div class="settings-location-row">
                        <span class="settings-location-name">${loc ? (loc.name || `${loc.lat.toFixed(3)}, ${loc.lng.toFixed(3)}`) : 'Not set'}</span>
                        <button type="button" class="btn btn-secondary btn-sm" id="set-location-btn">${loc ? 'Change' : 'Set'}</button>
                    </div>
                </div>

                <div class="settings-section">
                    <h4>Calculation method <span class="info-tip" data-hint="Different methods use different Fajr/Isha angles. Pick the one used by your local masjid.">?</span></h4>
                    <select class="app-input" data-setting="calcMethod">
                        ${Object.entries(CALC_METHODS).map(([id, m]) =>
                            `<option value="${id}" ${id === calcMethod ? 'selected' : ''}>${m.name}</option>`
                        ).join('')}
                    </select>
                </div>

                <div class="settings-section">
                    <h4>Asr school <span class="info-tip" data-hint="Hanafi = shadow factor 2 (later Asr). Standard = shadow factor 1.">?</span></h4>
                    <div class="seg-toggle">
                        ${Object.entries(ASR_SCHOOLS).map(([id, s]) =>
                            `<button type="button" class="seg-toggle-btn${id === asrSchool ? ' active' : ''}" data-setting="asrSchool" data-value="${id}">${id === 'standard' ? 'Standard' : 'Hanafi'}</button>`
                        ).join('')}
                    </div>
                </div>

                <div class="settings-section">
                    <h4>Iqama offsets <span class="settings-sub">(minutes after adhan)</span></h4>
                    <div class="iqama-grid">
                        ${PRAYER_RING_IDS.map(id => `
                            <div class="iqama-row">
                                <span class="iqama-name">${PRAYER_TIME_LABELS[id]}</span>
                                <div class="num-stepper stepper-sm" data-stepper="iqama" data-prayer="${id}">
                                    <button type="button" class="num-stepper-btn" data-step="-1" aria-label="Decrease">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
                                    </button>
                                    <input type="number" class="num-stepper-input" data-iqama="${id}" min="0" max="60" value="${iqama[id] !== undefined ? iqama[id] : DEFAULT_IQAMA_OFFSETS[id]}">
                                    <button type="button" class="num-stepper-btn" data-step="1" aria-label="Increase">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
                                    </button>
                                </div>
                                <span class="iqama-unit">min</span>
                            </div>
                        `).join('')}
                    </div>
                </div>

                <div class="settings-section">
                    <h4>Fine adjustments <span class="settings-sub">(± minutes)</span> <span class="info-tip" data-hint="Nudge each prayer a few minutes to match your local masjid's schedule.">?</span></h4>
                    <div class="iqama-grid">
                        ${PRAYER_RING_IDS.map(id => `
                            <div class="iqama-row">
                                <span class="iqama-name">${PRAYER_TIME_LABELS[id]}</span>
                                <div class="num-stepper stepper-sm" data-stepper="adjust" data-prayer="${id}">
                                    <button type="button" class="num-stepper-btn" data-step="-1" aria-label="Decrease">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
                                    </button>
                                    <input type="number" class="num-stepper-input" data-adjust="${id}" min="-30" max="30" value="${adjust[id] || 0}">
                                    <button type="button" class="num-stepper-btn" data-step="1" aria-label="Increase">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
                                    </button>
                                </div>
                                <span class="iqama-unit">min</span>
                            </div>
                        `).join('')}
                    </div>
                </div>

                <div class="settings-section">
                    <div class="settings-row">
                        <h4>Notifications <span class="info-tip" data-hint="Master switch. Fine-tune each event below.">?</span></h4>
                        <label class="setting-toggle">
                            <input type="checkbox" id="notif-toggle" ${notif ? 'checked' : ''}>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>

                    <div class="notif-sub-list ${notif ? '' : 'disabled'}">
                        <div class="notif-sub-row">
                            <div class="notif-sub-info">
                                <div class="notif-sub-name">Before adhan</div>
                            </div>
                            <div class="notif-sub-controls">
                                <div class="num-stepper stepper-sm" data-stepper="notifPre">
                                    <button type="button" class="num-stepper-btn" data-step="-1" aria-label="Decrease">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
                                    </button>
                                    <input type="number" class="num-stepper-input" data-setting-num="notifPreMinutes" min="1" max="60" value="${notifPreMin}">
                                    <button type="button" class="num-stepper-btn" data-step="1" aria-label="Increase">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
                                    </button>
                                </div>
                                <span class="notif-sub-unit">min</span>
                                <label class="setting-toggle">
                                    <input type="checkbox" data-setting="notifPreEnabled" ${notifPre ? 'checked' : ''}>
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                        </div>

                        <div class="notif-sub-row">
                            <div class="notif-sub-info">
                                <div class="notif-sub-name">At adhan</div>
                            </div>
                            <div class="notif-sub-controls">
                                <label class="setting-toggle">
                                    <input type="checkbox" data-setting="notifAdhanEnabled" ${notifAdhan ? 'checked' : ''}>
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                        </div>

                        <div class="notif-sub-row">
                            <div class="notif-sub-info">
                                <div class="notif-sub-name">Before iqama</div>
                            </div>
                            <div class="notif-sub-controls">
                                <div class="num-stepper stepper-sm" data-stepper="notifPreIqama">
                                    <button type="button" class="num-stepper-btn" data-step="-1" aria-label="Decrease">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
                                    </button>
                                    <input type="number" class="num-stepper-input" data-setting-num="notifPreIqamaMinutes" min="1" max="30" value="${notifPreIqamaMin}">
                                    <button type="button" class="num-stepper-btn" data-step="1" aria-label="Increase">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
                                    </button>
                                </div>
                                <span class="notif-sub-unit">min</span>
                                <label class="setting-toggle">
                                    <input type="checkbox" data-setting="notifPreIqamaEnabled" ${notifPreIqama ? 'checked' : ''}>
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="settings-section">
                    <div class="settings-row">
                        <h4>Auto-mark missed <span class="info-tip" data-hint="If you don't log a prayer before the next one comes in, it gets added to your Qadaa goals automatically.">?</span></h4>
                        <label class="setting-toggle">
                            <input type="checkbox" data-setting="autoMarkMissed" ${autoMiss ? 'checked' : ''}>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>

                </div>`;
        }

        if (tab === 'data') {
            const syncSession = typeof Sync !== 'undefined' ? Sync.getSession() : null;
            let syncSection = '';
            if (syncSession) {
                const lastSyncTs = typeof Sync !== 'undefined' ? Sync.getLastSync() : null;
                const lastSync = lastSyncTs ? new Date(lastSyncTs).toLocaleString() : 'never';
                syncSection = `
                <div class="settings-section">
                    <h4>Cloud Sync</h4>
                    <div class="sync-box">
                        <div class="sync-status">✓ <span class="sync-email" id="sync-email-display"></span></div>
                        <div class="sync-meta" id="sync-meta">Last synced: ${lastSync}</div>
                        <div class="sync-actions">
                            <button type="button" class="btn btn-secondary" id="sync-now">Sync now</button>
                            <button type="button" class="btn btn-danger" id="sync-clear-cloud">Clear cloud data</button>
                            <button type="button" class="btn btn-secondary" id="sync-signout">Sign out</button>
                        </div>
                    </div>
                </div>`;
            } else {
                syncSection = `
                <div class="settings-section">
                    <h4>Cloud Sync</h4>
                    <div class="sync-box">
                        <div class="sync-subtitle">Sign in to sync your data across devices</div>
                        <div class="sync-form" id="sync-form">
                            <input type="email" id="sync-email" placeholder="Email" autocomplete="email">
                            <input type="password" id="sync-pass" placeholder="Password" autocomplete="current-password">
                            <div class="sync-form-actions">
                                <button type="button" class="btn btn-secondary" id="sync-signin">Sign in</button>
                                <button type="button" class="btn btn-secondary" id="sync-signup">Create account</button>
                            </div>
                            <a href="#" class="sync-forgot" id="sync-forgot">Forgot password?</a>
                            <div class="sync-error" id="sync-error"></div>
                            <div class="sync-divider"><span>or</span></div>
                            <button type="button" class="btn btn-google" id="sync-google">
                                <svg width="16" height="16" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                                Sign in with Google
                            </button>
                        </div>
                    </div>
                </div>`;
            }
            return syncSection + `
                <div class="settings-section">
                    <h4>Export</h4>
                    <button type="button" class="btn btn-secondary" id="export-data">Download all data (JSON)</button>
                </div>
                <div class="settings-section">
                    <h4>Import</h4>
                    <button type="button" class="btn btn-secondary" id="import-data">Import from file</button>
                    <input type="file" id="import-file" accept=".json" style="display:none">
                </div>
                <div class="settings-section">
                    <h4>Danger zone</h4>
                    <button type="button" class="btn btn-danger" id="clear-data">Clear all data</button>
                </div>`;
        }

        if (tab === 'about') {
            const ver = APP_VERSION;
            const installedAt = Storage.get(KEYS.INSTALLED_AT);
            const installedStr = installedAt ? fmtFullDate(new Date(installedAt)) : 'Unknown';
            const totalDays = Object.keys(S.prayers).length;
            const totalPrayed = Object.values(S.prayers).reduce((sum, d) => sum + PRAYERS.filter(p => d[p.id]).length, 0);
            const totalGoals = getGoals().length + (S.goalsArchive || []).length;
            return `
                <div class="about-header">
                    <div class="about-icon">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                            <path d="M12 2L14.09 8.26L20 10L14.09 11.74L12 18L9.91 11.74L4 10L9.91 8.26L12 2Z" fill="currentColor"/>
                            <path d="M19 14C17.34 14 16 15.34 16 17C16 18.66 17.34 20 19 20C20.66 20 22 18.66 22 17C22 15.34 20.66 14 19 14ZM17.5 17C17.5 16.17 18.17 15.5 19 15.5C19.83 15.5 20.5 16.17 20.5 17C20.5 17.83 19.83 18.5 19 18.5C18.17 18.5 17.5 17.83 17.5 17Z" fill="currentColor"/>
                        </svg>
                    </div>
                    <div class="about-title">Nur</div>
                    <div class="about-version">v${ver}</div>
                </div>
                <div class="about-description">Made to help you stay consistent with your salah, day after day. Prayer times, Hijri calendar, fasting, qadaa goals, and more. Your data stays on your device. No ads, no tracking.</div>
                <div class="about-stats-row">
                    <div class="about-stat"><span class="about-stat-num">${totalDays}</span><span class="about-stat-label">days tracked</span></div>
                    <div class="about-stat"><span class="about-stat-num">${totalPrayed.toLocaleString()}</span><span class="about-stat-label">prayers logged</span></div>
                    <div class="about-stat"><span class="about-stat-num">${totalGoals}</span><span class="about-stat-label">goals created</span></div>
                </div>
                <div class="about-update-row">
                    <button type="button" class="btn btn-secondary" id="check-update">Check for updates</button>
                    <span class="about-update-status" id="update-status"></span>
                </div>
                <div class="about-link-list">
                    <a href="#" id="about-website" class="about-link">Website</a>
                    <a href="#" id="about-contact" class="about-link">Contact Us</a>
                </div>
                <div class="about-footer">Installed ${installedStr}<br>Simple, private, and free.</div>`;
        }

        return '';
    }

    function wireSettingsTab(tab) {
        const content = $('#settings-tab-content');
        if (!content) return;

        if (tab === 'general') {
            $$('.theme-option', content).forEach(btn => {
                btn.addEventListener('click', () => {
                    setTheme(btn.dataset.theme);
                    $$('.theme-option', content).forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                });
            });
            // Language select — currently only English; writes to settings for forward-compat
            $('select[data-setting="language"]', content)?.addEventListener('change', (e) => {
                setSetting('language', e.target.value);
            });
            return;
        }

        // Segmented toggles (primary calendar, week start, indicator style, etc.)
        $$('.seg-toggle-btn', content).forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.setting;
                let val = btn.dataset.value;
                if (!isNaN(parseInt(val))) val = parseInt(val);
                setSetting(key, val);
                // Update visual
                const group = btn.parentElement;
                $$('.seg-toggle-btn', group).forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                // Re-render dashboard if relevant
                if (key === 'primaryCalendar') {
                    // Anchor to today when switching between Hijri/Gregorian
                    calToday();
                    // Refresh the header date stack so primary/secondary flip immediately
                    updateClock();
                } else if (key === 'hijriOffset') {
                    HijriCalendar.setOffset(val);
                    calToday();
                    updateClock();
                    render();
                } else if (['weekStart', 'showGregorian', 'showIndicators'].includes(key)) {
                    renderCalendar();
                }
                if (key === 'archiveStyle') {
                    renderGoals();
                }
            });
        });

        // Checkbox toggles
        $$('input[type="checkbox"][data-setting]', content).forEach(cb => {
            cb.addEventListener('change', () => {
                setSetting(cb.dataset.setting, cb.checked);
                if (['showGregorian', 'showIndicators'].includes(cb.dataset.setting)) {
                    renderCalendar();
                }
            });
        });

        if (tab === 'prayers') {
            // Calculation method select
            $('select[data-setting="calcMethod"]', content)?.addEventListener('change', (e) => {
                setSetting('calcMethod', e.target.value);
                S.settings._methodManuallySet = true;
                save(KEYS.SETTINGS, S.settings);
                refreshAllTimes();
            });
            // Asr school segmented buttons trigger recompute via re-wire above — add recompute hook
            $$('.seg-toggle-btn[data-setting="asrSchool"]', content).forEach(btn => {
                btn.addEventListener('click', () => refreshAllTimes());
            });
            // Iqama + fine-adjust inputs (direct typing)
            const persistIqama = (id, val) => {
                const cur = getSetting('iqamaOffsets', {}) || {};
                cur[id] = val;
                setSetting('iqamaOffsets', cur);
                refreshAllTimes();
            };
            const persistAdjust = (id, val) => {
                const cur = getSetting('timeAdjustments', {}) || {};
                cur[id] = val;
                setSetting('timeAdjustments', cur);
                refreshAllTimes();
            };
            $$('input[data-iqama]', content).forEach(inp => {
                inp.addEventListener('change', () => persistIqama(inp.dataset.iqama, parseInt(inp.value) || 0));
            });
            $$('input[data-adjust]', content).forEach(inp => {
                inp.addEventListener('change', () => persistAdjust(inp.dataset.adjust, parseInt(inp.value) || 0));
            });

            // Persist a plain numeric setting (e.g. notifPreMinutes). Saves + re-schedules.
            const persistNumSetting = (key, val) => {
                S.settings[key] = val;
                save(KEYS.SETTINGS, S.settings);
                if (S.settings.notifications) schedulePrayerNotifications();
            };
            // Save a boolean setting from a checkbox (e.g. notifPreEnabled)
            const persistBoolSetting = (key, val) => {
                S.settings[key] = val;
                save(KEYS.SETTINGS, S.settings);
                if (S.settings.notifications) schedulePrayerNotifications();
            };
            // Raw number inputs (used by notif sub-settings)
            $$('input[data-setting-num]', content).forEach(inp => {
                inp.addEventListener('change', () => {
                    persistNumSetting(inp.dataset.settingNum, parseInt(inp.value) || 0);
                });
            });
            // Bool toggles with data-setting (notifPreEnabled, notifAdhanEnabled, etc)
            $$('input[type="checkbox"][data-setting]', content).forEach(cb => {
                cb.addEventListener('change', () => {
                    persistBoolSetting(cb.dataset.setting, cb.checked);
                });
            });

            // Stepper +/- buttons on iqama, fine-adjust, and notif sub-rows
            $$('.num-stepper[data-stepper] .num-stepper-btn', content).forEach(btn => {
                btn.addEventListener('click', () => {
                    const stepper = btn.closest('.num-stepper');
                    const kind = stepper.dataset.stepper;       // 'iqama' | 'adjust' | 'notifPre' | 'notifPreIqama'
                    const prayerId = stepper.dataset.prayer;
                    const inp = stepper.querySelector('input');
                    const step = parseInt(btn.dataset.step);
                    const min = parseInt(inp.min);
                    const max = parseInt(inp.max);
                    const next = Math.max(min, Math.min(max, (parseInt(inp.value) || 0) + step));
                    inp.value = next;
                    if (kind === 'iqama') persistIqama(prayerId, next);
                    else if (kind === 'adjust') persistAdjust(prayerId, next);
                    else if (inp.dataset.settingNum) persistNumSetting(inp.dataset.settingNum, next);
                });
            });
            // Notification toggle (same behavior as the button on Times page)
            $('#notif-toggle', content)?.addEventListener('change', (e) => {
                e.preventDefault();
                // togglePrayerNotifications does permission flow + toast
                togglePrayerNotifications();
            });
            // Set-location shortcut
            $('#set-location-btn', content)?.addEventListener('click', () => {
                closeAllModals();
                openCityPicker();
            });
        }

        if (tab === 'data') {
            // Cloud sync events
            const syncSignin = $('#sync-signin');
            const syncSignup = $('#sync-signup');
            const syncNow = $('#sync-now');
            const syncClearCloud = $('#sync-clear-cloud');
            const syncSignout = $('#sync-signout');
            const syncError = $('#sync-error');

            // Safely set email text to prevent XSS
            const syncEmailDisplay = $('#sync-email-display');
            if (syncEmailDisplay && typeof Sync !== 'undefined') {
                const sess = Sync.getSession();
                if (sess && sess.user) syncEmailDisplay.textContent = sess.user.email;
            }

            async function handleAuth(action) {
                const email = $('#sync-email')?.value.trim();
                const pass = $('#sync-pass')?.value;
                if (!email || !pass) { if (syncError) syncError.textContent = 'Enter email and password'; return; }
                if (syncError) syncError.textContent = '';
                try {
                    if (action === 'signup') await Sync.signUp(email, pass);
                    else await Sync.signIn(email, pass);
                    // Re-render to show logged-in state
                    $('#settings-tab-content').innerHTML = renderSettingsTab('data');
                    wireSettingsTab('data');
                } catch (e) {
                    if (syncError) syncError.textContent = e.message;
                }
            }

            syncSignin?.addEventListener('click', () => handleAuth('signin'));
            syncSignup?.addEventListener('click', () => handleAuth('signup'));

            $('#sync-google')?.addEventListener('click', async () => {
                try {
                    if (typeof Sync !== 'undefined') await Sync.signInWithGoogle();
                } catch (e) {
                    console.warn('Google sign-in failed:', e);
                    if (syncError) syncError.textContent = 'Google sign-in failed. Please try again.';
                }
            });

            $('#sync-forgot')?.addEventListener('click', async (e) => {
                e.preventDefault();
                const email = $('#sync-email')?.value.trim();
                if (!email) { if (syncError) syncError.textContent = 'Enter your email first'; return; }
                try {
                    await Sync.resetPassword(email);
                    if (syncError) { syncError.style.color = '#68d391'; syncError.textContent = 'Reset link sent — check your email'; }
                } catch (err) {
                    if (syncError) syncError.textContent = err.message;
                }
            });

            syncNow?.addEventListener('click', async () => {
                syncNow.disabled = true;
                syncNow.textContent = 'Syncing...';
                try {
                    const pulled = await Sync.pullFromCloud();
                    if (!pulled) await Sync.pushToCloud(true);
                    const meta = $('#sync-meta');
                    if (meta) meta.textContent = 'Last synced: just now';
                } catch (e) {
                    toast('Sync failed: ' + e.message);
                } finally {
                    syncNow.disabled = false;
                    syncNow.textContent = 'Sync now';
                }
            });

            syncClearCloud?.addEventListener('click', async () => {
                if (!syncClearCloud.classList.contains('confirm')) {
                    syncClearCloud.classList.add('confirm');
                    syncClearCloud.textContent = 'Tap again to confirm';
                    setTimeout(() => { syncClearCloud.classList.remove('confirm'); syncClearCloud.textContent = 'Clear cloud data'; }, 3000);
                    return;
                }
                try {
                    await Sync.clearCloud();
                    toast('Cloud data cleared');
                    const meta = $('#sync-meta');
                    if (meta) meta.textContent = 'Last synced: never';
                } catch (e) {
                    toast('Failed: ' + e.message);
                }
            });

            syncSignout?.addEventListener('click', async () => {
                await Sync.signOut();
                $('#settings-tab-content').innerHTML = renderSettingsTab('data');
                wireSettingsTab('data');
                toast('Signed out');
            });

            $('#export-data')?.addEventListener('click', exportData);
            $('#import-data')?.addEventListener('click', () => $('#import-file')?.click());
            $('#import-file')?.addEventListener('change', importData);
            $('#clear-data')?.addEventListener('click', () => {
                const btn = $('#clear-data');
                if (!btn.classList.contains('confirm')) {
                    btn.classList.add('confirm');
                    btn.textContent = 'Tap again to confirm';
                    setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = 'Clear all data'; }, 3000);
                    return;
                }
                Storage.clearAll();
                location.reload();
            });
        }

        if (tab === 'about') {
            $('#check-update')?.addEventListener('click', checkForUpdates);
            $('#about-website')?.addEventListener('click', (e) => { e.preventDefault(); openUrl('https://nur-prayer-app.github.io/releases/'); });
            $('#about-contact')?.addEventListener('click', (e) => { e.preventDefault(); openUrl('https://nur-prayer-app.github.io/releases/contact.html'); });
        }
    }

    function openUrl(url) {
        if (window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
        else window.open(url, '_blank');
    }

    /* ── Update Checker ────────────────────────────────────── */
    function compareVersions(a, b) {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const na = pa[i] || 0, nb = pb[i] || 0;
            if (na > nb) return 1;
            if (na < nb) return -1;
        }
        return 0;
    }

    async function checkForUpdates() {
        const statusEl = $('#update-status');
        const btn = $('#check-update');
        if (statusEl) statusEl.textContent = 'Checking...';
        if (btn) btn.disabled = true;
        try {
            const resp = await fetch(UPDATE_URL, { cache: 'no-store' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const cmp = compareVersions(data.version, APP_VERSION);
            if (cmp > 0) {
                if (statusEl) statusEl.innerHTML = `<strong>v${data.version} available</strong>`;
                if (btn) { btn.textContent = 'Download update'; btn.disabled = false; btn.onclick = () => {
                    openUrl(data.url || 'https://nur-prayer-app.github.io/releases/');
                }; }
            } else {
                if (statusEl) statusEl.textContent = 'You\'re up to date';
                if (btn) btn.disabled = false;
            }
        } catch {
            if (statusEl) statusEl.textContent = 'Couldn\'t check for updates';
            if (btn) btn.disabled = false;
        }
    }

    async function checkForUpdatesSilent() {
        try {
            const resp = await fetch(UPDATE_URL, { cache: 'no-store' });
            if (!resp.ok) return;
            const data = await resp.json();
            if (compareVersions(data.version, APP_VERSION) > 0) {
                toast(`Update available: v${data.version}`);
            }
        } catch { /* silent */ }
    }

    function exportData() {
        const data = Storage.exportAll();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `nur-backup-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('Data exported');
    }

    function importData(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                Storage.importAll(JSON.parse(reader.result));
                toast('Data imported — reloading…');
                setTimeout(() => location.reload(), 800);
            } catch {
                toast('Import failed: invalid file');
            }
        };
        reader.readAsText(file);
    }

    /* ── Calendar Nav ────────────────────────────────────────── */
    function calNext() {
        const primary = S.settings.primaryCalendar || 'hijri';
        if (primary === 'gregorian') {
            S.gregM++; if (S.gregM > 11) { S.gregM = 0; S.gregY++; }
        } else {
            S.calM++; if (S.calM > 12) { S.calM = 1; S.calY++; }
        }
        S.highlightHijriMonth = null;
        updateCalendar();
    }
    function calPrev() {
        const primary = S.settings.primaryCalendar || 'hijri';
        if (primary === 'gregorian') {
            S.gregM--; if (S.gregM < 0) { S.gregM = 11; S.gregY--; }
        } else {
            S.calM--; if (S.calM < 1) { S.calM = 12; S.calY--; }
        }
        S.highlightHijriMonth = null;
        updateCalendar();
    }

    /* ── Statistics ──────────────────────────────────────────── */
    function renderStats() {
        const grid = $('#stats-grid');
        if (!grid) return;

        // Time-range picker state: 7, 14, or 30 days. Defaults to 7.
        // This picker drives EVERY card below — period-vs-previous-period comparisons,
        // volunteer counts, on-time %, etc. all scale to the chosen window so the page
        // reads as one coherent "last N days" view.
        const RANGE_DAYS = S.settings.statsRange || 7;

        // Render the global stats toolbar (range picker) OUTSIDE the cards grid so it reads
        // as a page-level control — not a card control. Mounted once into the stats page.
        const statsPage = grid.parentElement;
        let toolbar = $('#stats-toolbar');
        if (!toolbar && statsPage) {
            toolbar = document.createElement('div');
            toolbar.id = 'stats-toolbar';
            toolbar.className = 'stats-toolbar';
            statsPage.insertBefore(toolbar, grid);
        }
        if (toolbar) {
            toolbar.innerHTML = `
                <div class="stats-toolbar-label">Viewing last</div>
                <div class="range-picker" role="group" aria-label="Time range">
                    ${[7, 14, 30].map(n => `
                        <button type="button" class="range-btn ${n === RANGE_DAYS ? 'active' : ''}" data-range="${n}">${n}d</button>
                    `).join('')}
                </div>
            `;
            $$('.range-btn', toolbar).forEach(btn => {
                btn.addEventListener('click', () => {
                    S.settings.statsRange = parseInt(btn.dataset.range, 10);
                    save(KEYS.SETTINGS, S.settings);
                    renderStats();
                });
            });
        }

        // ── Prayer color tokens (match the timeline so stats feel cohesive) ──
        const PRAYER_COLORS = {
            fajr: '#818cf8', dhuhr: '#fbd38d', asr: '#fb923c',
            maghrib: '#c8a2ff', isha: '#6366f1',
        };

        const today = new Date();
        const dayDataForOffset = (offset) => {
            const d = new Date(today);
            d.setDate(d.getDate() - offset);
            const h = HijriCalendar.gregorianToHijri(d);
            const raw = S.prayers[hk(h.year, h.month, h.day)];
            if (!raw) return { date: d, data: undefined };
            const hasActivity = PRAYERS.some(p => raw[p.id]) || raw.qyaam || raw.duha || raw.shafaWitr || raw.fasting;
            return { date: d, data: hasActivity ? raw : undefined };
        };

        // ── Range-scoped stats (uses the RANGE_DAYS picker value: 7 / 14 / 30) ──
        // "On-time" fallback: no timestamp in data model, so we count a prayer as on-time
        // if it's marked done AND NOT flagged `${id}_auto_missed`. An auto-miss flag means
        // the user didn't log it before the next adhan — i.e. it's being paid back as qadaa.
        const rangePerPrayer = { fajr:0, dhuhr:0, asr:0, maghrib:0, isha:0 };
        const rangeOnTimePer = { fajr:0, dhuhr:0, asr:0, maghrib:0, isha:0 };
        let rangeTrackedDays = 0;
        let rangeFastingDays = 0;
        let rangeDuhaDays = 0;
        let rangeShafaWitrNights = 0;
        let rangeQyaamNights = 0;
        let rangeQyaamRakaat = 0;
        let rangeCompleted = 0;
        let rangeOnTime = 0;
        let rangeTotalSlots = 0;
        let rangeOnTimeSlots = 0;

        const todayPassed = computePassedPrayers(new Date());

        for (let i = 0; i < RANGE_DAYS; i++) {
            const { data } = dayDataForOffset(i);
            if (!data) continue;
            const isToday = i === 0;
            const hasPrayers = PRAYERS.some(p => data[p.id]);
            if (hasPrayers) {
                rangeTrackedDays++;
                PRAYERS.forEach(p => {
                    if (isToday && !todayPassed[p.id]) return;
                    rangeTotalSlots++;
                    if (data[p.id]) {
                        rangePerPrayer[p.id]++;
                        rangeCompleted++;
                        if (!data[`${p.id}_auto_missed`]) {
                            rangeOnTimePer[p.id]++;
                            rangeOnTime++;
                            rangeOnTimeSlots++;
                        }
                    }
                });
            }
            if (data.fasting) rangeFastingDays++;
            if (data.duha) rangeDuhaDays++;
            if (data.shafaWitr) rangeShafaWitrNights++;
            if (data.qyaam) {
                rangeQyaamNights++;
                rangeQyaamRakaat += data.qyaamRakaat || 0;
            }
        }
        const activeDays = Math.max(1, rangeTrackedDays);
        const rangeSlotTotal = Math.max(1, rangeTotalSlots);
        const overallOnTimePct = Math.round((rangeOnTime / rangeSlotTotal) * 100);

        // ── Qadaa remaining (all qadaa + qadaa-auto goals combined) ──
        const goals = getGoals();
        const qadaaGoals = goals.filter(isQadaaGoal);
        const qadaaRemaining = qadaaGoals.reduce((sum, g) => sum + (g.remaining || 0), 0);
        const qadaaTotal = qadaaGoals.reduce((sum, g) => sum + (g.total || 0), 0);
        const qadaaDone = qadaaTotal - qadaaRemaining;
        const qadaaPct = qadaaTotal > 0 ? Math.round((qadaaDone / qadaaTotal) * 100) : 0;

        const qadaaPaces = [];
        if (qadaaRemaining > 0) {
            [{ rate: 1, label: 'At 1/day' }, { rate: 5, label: 'At 5/day' }].forEach(p => {
                const days = Math.ceil(qadaaRemaining / p.rate);
                const d = new Date(); d.setDate(d.getDate() + days);
                qadaaPaces.push({ label: p.label, date: fmtShortDate(d), days });
            });
        }

        // ── Volunteer acts: only things actually tracked in the data model ──
        // Qyaam (tahajjud/night prayer) + fasting. No fake counters for untracked items.
        const volunteerActs = [
            { id: 'duha', name: 'Duha prayers', value: rangeDuhaDays, sub: `in last ${RANGE_DAYS}d`, color: '#fbbf24' },
            { id: 'shafaWitr', name: "Shaf'a & Witr", value: rangeShafaWitrNights, sub: `in last ${RANGE_DAYS}d`, color: '#2dd4bf' },
            { id: 'qyaam', name: 'Qyaam nights', value: rangeQyaamNights, sub: `${rangeQyaamRakaat} raka'at`, color: '#c8a2ff' },
            { id: 'fasting', name: 'Fasting days', value: rangeFastingDays, sub: `in last ${RANGE_DAYS}d`, color: '#68d391' },
        ];
        // ── Render ──
        const volunteerHtml = `
                <div class="punct-volunteer-divider"></div>
                <div class="punct-volunteer">
                    ${volunteerActs.map(v => `
                        <div class="pv-item" data-vol="${v.id}">
                            <span class="pv-value">${v.value}</span>
                            <span class="pv-name">${v.name}</span>
                            <span class="pv-sub">${v.sub}</span>
                        </div>
                    `).join('')}
                </div>`;

        grid.innerHTML = `
            <!-- Card 1: Punctuality + per-prayer reliability + volunteer acts -->
            <div class="stat-card stat-card-wide stat-card-full stat-punct-card">
                <div class="stat-card-header">
                    <h3>Punctuality &amp; reliability</h3>
                    <span class="stat-card-hint-inline">${rangeTrackedDays} / ${RANGE_DAYS} days tracked</span>
                </div>
                <div class="punct-row">
                    <div class="punct-ring-wrap">
                        <svg class="donut-svg" viewBox="0 0 100 100" width="180" height="180">
                            <defs>
                                <linearGradient id="punct-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                                    <stop offset="0%" stop-color="#68d391"/>
                                    <stop offset="100%" stop-color="#63b3ed"/>
                                </linearGradient>
                            </defs>
                            <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="10"/>
                            <circle cx="50" cy="50" r="42" fill="none" stroke="url(#punct-grad)" stroke-width="10" stroke-linecap="round"
                                stroke-dasharray="${Math.round((overallOnTimePct / 100) * 263.9)} 263.9"
                                transform="rotate(-90 50 50)"/>
                        </svg>
                        <div class="donut-center">
                            <div class="donut-pct">${overallOnTimePct}%</div>
                            <div class="donut-sub">completed</div>
                        </div>
                    </div>
                    <div class="punct-bars">
                        ${PRAYERS.map(p => {
                            const done = rangeOnTimePer[p.id];
                            const denom = todayPassed[p.id] ? activeDays : Math.max(1, activeDays - 1);
                            const pct = denom > 0 ? Math.round((done / denom) * 100) : 0;
                            const color = PRAYER_COLORS[p.id];
                            return `
                            <div class="prayer-bar-row">
                                <span class="pbr-name" style="color:${color}">${p.name}</span>
                                <div class="pbr-track">
                                    <div class="pbr-fill" style="width:${pct}%;background:linear-gradient(90deg, ${color}, ${color}cc)"></div>
                                </div>
                                <span class="pbr-pct">${pct}%</span>
                                <span class="pbr-ratio">${done}/${denom}</span>
                            </div>`;
                        }).join('')}
                    </div>
                </div>
                ${volunteerHtml}
            </div>

            <!-- Card 2: Qadaa remaining + estimated finish date -->
            <div class="stat-card stat-card-wide stat-card-full stat-qadaa-card">
                <div class="stat-card-header">
                    <h3>Qadaa remaining</h3>
                    <span class="stat-card-hint-inline">${qadaaGoals.length} goal${qadaaGoals.length === 1 ? '' : 's'} tracked</span>
                </div>
                ${qadaaTotal === 0 ? `
                    <div class="stat-empty">
                        <div class="stat-empty-icon">✓</div>
                        <div class="stat-empty-text">No qadaa goals yet — you're all caught up.</div>
                    </div>
                ` : `
                    <div class="qadaa-big-stat">
                        <div class="qbs-number">${qadaaRemaining.toLocaleString()}</div>
                        <div class="qbs-label">prayer${qadaaRemaining === 1 ? '' : 's'} left</div>
                        <div class="qbs-sub">${qadaaRemaining === 0 ? 'All caught up' : `${qadaaGoals.length} goal${qadaaGoals.length === 1 ? '' : 's'} active`}</div>
                    </div>
                    <div class="qadaa-progress-bar">
                        <div class="qadaa-progress-fill" style="width:${qadaaPct}%"></div>
                    </div>
                    <div class="qadaa-bar-label">${qadaaDone.toLocaleString()} of ${qadaaTotal.toLocaleString()} made up · ${qadaaPct}%</div>
                    ${qadaaPaces.length > 0 ? `
                    <div class="goal-pace-list">
                        ${qadaaPaces.map(p => `
                        <div class="goal-pace-row">
                            <span class="pace-label">${p.label}</span>
                            <span class="pace-date"><strong>${p.date}</strong></span>
                            <span class="pace-days">${p.days} ${p.days === 1 ? 'day' : 'days'}</span>
                        </div>`).join('')}
                    </div>` : `<div class="qadaa-finish">All caught up</div>`}
                `}
            </div>
        `;
    }

    /* ── Prayer Times (calculated) ───────────────────────────────
     * Astronomical prayer time calculation.
     * Supports multiple calculation methods and both Asr schools.
     * Returns times as Date objects (computeRawTimes) or formatted strings (calculatePrayerTimes).
     * Reference: PrayTimes.js formulas (Hamid Zarrabi-Zadeh, public domain).
     * ────────────────────────────────────────────────────────── */

    // Calculation methods: fajrAngle, ishaAngle, ishaInterval (if > 0 replaces angle — minutes after maghrib)
    const CALC_METHODS = {
        ISNA:         { name: 'ISNA (North America)',       fajr: 15,   isha: 15,   ishaInterval: 0  },
        MWL:          { name: 'Muslim World League',         fajr: 18,   isha: 17,   ishaInterval: 0  },
        Egypt:        { name: 'Egyptian General Authority',  fajr: 19.5, isha: 17.5, ishaInterval: 0  },
        Makkah:       { name: 'Umm al-Qura, Makkah',        fajr: 18.5, isha: 0,    ishaInterval: 90 },
        Karachi:      { name: 'Karachi (Sindh Univ.)',       fajr: 18,   isha: 18,   ishaInterval: 0  },
        Tehran:       { name: 'Tehran (Inst. of Geophysics)',fajr: 17.7, isha: 14,   ishaInterval: 0, maghribAngle: 4.5 },
        Jafari:       { name: 'Shia Ithna-Ashari, Jafari',  fajr: 16,   isha: 14,   ishaInterval: 0, maghribAngle: 4  },
        Dubai:        { name: 'Dubai (UAE)',                 fajr: 18.2, isha: 18.2, ishaInterval: 0  },
        Turkey:       { name: 'Turkey (Diyanet)',            fajr: 18,   isha: 17,   ishaInterval: 0  },
        Kuwait:       { name: 'Kuwait',                      fajr: 18,   isha: 17.5, ishaInterval: 0  },
    };

    // Asr schools: shadow factor applied to object height
    const ASR_SCHOOLS = {
        standard: { name: 'Standard (Shafi, Maliki, Hanbali)', factor: 1 },
        hanafi:   { name: 'Hanafi',                            factor: 2 },
    };

    function deg2rad(d) { return d * Math.PI / 180; }
    function rad2deg(r) { return r * 180 / Math.PI; }

    /** Compute raw prayer times as Date objects for the given location + date.
     *  Options: { method: 'ISNA'|..., asrSchool: 'standard'|'hanafi', adjustments: {fajr, dhuhr, asr, maghrib, isha} }
     *  Adjustments are in minutes (positive = later). */
    let _rawTimesCache = {};
    function computeRawTimesCached(lat, lng, date, opts) {
        const k = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${lat}-${lng}-${opts.method}-${opts.asrSchool}`;
        if (_rawTimesCache[k]) return _rawTimesCache[k];
        const v = computeRawTimes(lat, lng, date, opts);
        _rawTimesCache[k] = v;
        if (Object.keys(_rawTimesCache).length > 5) {
            const first = Object.keys(_rawTimesCache)[0];
            delete _rawTimesCache[first];
        }
        return v;
    }
    function invalidateRawTimesCache() { _rawTimesCache = {}; }

    function computeRawTimes(lat, lng, date, opts = {}) {
        const method = CALC_METHODS[opts.method] || CALC_METHODS.ISNA;
        const asr = ASR_SCHOOLS[opts.asrSchool] || ASR_SCHOOLS.standard;
        const adj = opts.adjustments || {};

        const Y = date.getFullYear();
        const M = date.getMonth() + 1;
        const D = date.getDate();

        // Julian Day at 0h UT
        let a = Math.floor((14 - M) / 12);
        let y = Y + 4800 - a;
        let m = M + 12 * a - 3;
        const jd = D + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4)
                 - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
        const T = (jd - 2451545.0) / 36525.0;

        // Solar geometry
        const L = (280.46646 + 36000.76983 * T) % 360;
        const Mean = (357.52911 + 35999.05029 * T) % 360;
        const C = Math.sin(deg2rad(Mean)) * (1.914602 - T * 0.004817)
                + Math.sin(deg2rad(2 * Mean)) * (0.019993 - T * 0.000101)
                + Math.sin(deg2rad(3 * Mean)) * 0.000289;
        const trueLong = L + C;
        const obliq = 23.43929111 - T * 0.01300417;
        const decl = rad2deg(Math.asin(Math.sin(deg2rad(obliq)) * Math.sin(deg2rad(trueLong))));
        const eqTime = 4 * (L - 0.0057183 - rad2deg(
            Math.atan2(Math.cos(deg2rad(obliq)) * Math.sin(deg2rad(trueLong)), Math.cos(deg2rad(trueLong)))
        ));

        const tz = -date.getTimezoneOffset() / 60;
        const noon = 12 - eqTime / 60 - lng / 15 + tz; // Dhuhr in decimal hours (local)

        const hourAngle = (angle) => {
            const A = -angle;
            const cosH = (Math.sin(deg2rad(A)) - Math.sin(deg2rad(lat)) * Math.sin(deg2rad(decl)))
                       / (Math.cos(deg2rad(lat)) * Math.cos(deg2rad(decl)));
            const clamped = Math.max(-1, Math.min(1, cosH));
            return rad2deg(Math.acos(clamped)) / 15;
        };

        const asrAngle = -rad2deg(Math.atan(1 / (asr.factor + Math.tan(deg2rad(Math.abs(lat - decl))))));

        const raw = {
            fajr:    noon - hourAngle(method.fajr),
            sunrise: noon - hourAngle(0.833),
            dhuhr:   noon + 1 / 60,
            asr:     noon + hourAngle(asrAngle),
            maghrib: noon + hourAngle(method.maghribAngle || 0.833),
            isha:    method.ishaInterval > 0
                ? (noon + hourAngle(method.maghribAngle || 0.833)) + method.ishaInterval / 60
                : noon + hourAngle(method.isha),
        };

        // Apply user adjustments (minutes → decimal hours)
        Object.keys(raw).forEach(k => {
            if (adj[k]) raw[k] += adj[k] / 60;
        });

        // Decimal hours → Date objects on the same calendar date
        const result = {};
        Object.entries(raw).forEach(([k, hh]) => {
            const normalized = ((hh % 24) + 24) % 24;
            const hours = Math.floor(normalized);
            const mins = Math.round((normalized - hours) * 60);
            const d = new Date(date);
            d.setHours(hours, mins, 0, 0);
            // If wrapped past midnight (isha next-day in extreme latitudes), shift
            if (hh >= 24) d.setDate(d.getDate() + 1);
            if (hh < 0) d.setDate(d.getDate() - 1);
            result[k] = d;
        });
        return result;
    }

    /** Pull the user's current time-calc options from settings, with defaults. */
    function getTimesOptions() {
        return {
            method: S.settings.calcMethod || 'ISNA',
            asrSchool: S.settings.asrSchool || 'standard',
            adjustments: S.settings.timeAdjustments || {},
        };
    }

    /** Default iqama offsets (minutes after adhan). Maghrib is shorter because of dusk. */
    const DEFAULT_IQAMA_OFFSETS = { fajr: 20, dhuhr: 20, asr: 20, maghrib: 10, isha: 20 };

    /** Resolve iqama offset for a prayer: user value (if set) → default. */
    function getIqamaOffset(prayerId) {
        const user = (S.settings.iqamaOffsets || {})[prayerId];
        if (user !== undefined && user !== null) return user;
        return DEFAULT_IQAMA_OFFSETS[prayerId] || 0;
    }

    function formatTime12(date) {
        const h = date.getHours();
        const m = date.getMinutes();
        const h12 = h % 12 || 12;
        const ampm = h >= 12 ? 'PM' : 'AM';
        return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
    }

    // City presets for quick picking
    // Country → default calculation method. Applied automatically when user picks a city.
    const COUNTRY_METHOD = {
        'Saudi Arabia': 'Makkah',
        'Egypt':        'Egypt',
        'Turkey':       'Turkey',
        'UAE':          'Dubai',
        'Kuwait':       'Kuwait',
        'Iran':         'Tehran',
        'Pakistan':     'Karachi',
        'Bangladesh':   'Karachi',
        'India':        'Karachi',
        'Indonesia':    'MWL',
        'Malaysia':     'MWL',
        'Morocco':      'MWL',
        'Algeria':      'MWL',
        'Tunisia':      'MWL',
        'Palestine':    'Egypt',
        'Jordan':       'Egypt',
        'Lebanon':      'Egypt',
        'Syria':        'Egypt',
        'Iraq':         'Egypt',
        'Qatar':        'Makkah',
        'UK':           'MWL',
        'France':       'MWL',
        'Germany':      'MWL',
        'USA':          'ISNA',
        'Canada':       'ISNA',
        'Australia':    'MWL',
    };

    const CITY_PRESETS = [
        { name: 'Makkah',     country: 'Saudi Arabia',        lat: 21.3891,  lng: 39.8579 },
        { name: 'Madinah',    country: 'Saudi Arabia',        lat: 24.4672,  lng: 39.6111 },
        { name: 'Jerusalem',  country: 'Palestine',           lat: 31.7683,  lng: 35.2137 },
        { name: 'Istanbul',   country: 'Turkey',              lat: 41.0082,  lng: 28.9784 },
        { name: 'Cairo',      country: 'Egypt',               lat: 30.0444,  lng: 31.2357 },
        { name: 'Dubai',      country: 'UAE',                 lat: 25.2048,  lng: 55.2708 },
        { name: 'Riyadh',     country: 'Saudi Arabia',        lat: 24.7136,  lng: 46.6753 },
        { name: 'Doha',       country: 'Qatar',               lat: 25.2854,  lng: 51.5310 },
        { name: 'Kuwait City',country: 'Kuwait',              lat: 29.3759,  lng: 47.9774 },
        { name: 'Amman',      country: 'Jordan',              lat: 31.9454,  lng: 35.9284 },
        { name: 'Beirut',     country: 'Lebanon',             lat: 33.8938,  lng: 35.5018 },
        { name: 'Damascus',   country: 'Syria',               lat: 33.5138,  lng: 36.2765 },
        { name: 'Baghdad',    country: 'Iraq',                lat: 33.3152,  lng: 44.3661 },
        { name: 'Tehran',     country: 'Iran',                lat: 35.6892,  lng: 51.3890 },
        { name: 'Karachi',    country: 'Pakistan',            lat: 24.8607,  lng: 67.0011 },
        { name: 'Lahore',     country: 'Pakistan',            lat: 31.5204,  lng: 74.3587 },
        { name: 'Islamabad',  country: 'Pakistan',            lat: 33.6844,  lng: 73.0479 },
        { name: 'Dhaka',      country: 'Bangladesh',          lat: 23.8103,  lng: 90.4125 },
        { name: 'Jakarta',    country: 'Indonesia',           lat: -6.2088,  lng: 106.8456 },
        { name: 'Kuala Lumpur',country: 'Malaysia',           lat: 3.1390,   lng: 101.6869 },
        { name: 'Mumbai',     country: 'India',               lat: 19.0760,  lng: 72.8777 },
        { name: 'Delhi',      country: 'India',               lat: 28.7041,  lng: 77.1025 },
        { name: 'Casablanca', country: 'Morocco',             lat: 33.5731,  lng: -7.5898 },
        { name: 'Algiers',    country: 'Algeria',             lat: 36.7538,  lng: 3.0588 },
        { name: 'Tunis',      country: 'Tunisia',             lat: 36.8065,  lng: 10.1815 },
        { name: 'London',     country: 'UK',                  lat: 51.5074,  lng: -0.1278 },
        { name: 'Paris',      country: 'France',              lat: 48.8566,  lng: 2.3522 },
        { name: 'Berlin',     country: 'Germany',             lat: 52.5200,  lng: 13.4050 },
        { name: 'New York',   country: 'USA',                 lat: 40.7128,  lng: -74.0060 },
        { name: 'Chicago',    country: 'USA',                 lat: 41.8781,  lng: -87.6298 },
        { name: 'Toronto',    country: 'Canada',              lat: 43.6532,  lng: -79.3832 },
        { name: 'Sydney',     country: 'Australia',           lat: -33.8688, lng: 151.2093 },
    ];

    function openCityPicker() {
        const modal = $('#modal-backdrop');
        const content = $('#modal-content');
        if (!modal || !content) return;
        $('#modal-title').textContent = 'Choose a city';
        clearModalHeaderActions?.();

        content.innerHTML = `
            <div class="city-picker">
                <input type="search" id="city-search" class="app-input" placeholder="Search cities..." autocomplete="off">
                <div class="city-list" id="city-list"></div>
                <div class="city-picker-footer">
                    <button type="button" class="btn btn-secondary" id="use-gps">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="10" r="3" stroke="currentColor" stroke-width="1.5"/></svg>
                        Use my GPS
                    </button>
                </div>
            </div>`;

        function render(filter = '') {
            const list = $('#city-list');
            if (!list) return;
            const q = filter.trim().toLowerCase();
            const matches = q
                ? CITY_PRESETS.filter(c => c.name.toLowerCase().includes(q) || c.country.toLowerCase().includes(q))
                : CITY_PRESETS;
            if (matches.length === 0) {
                list.innerHTML = '<div class="city-empty">No matches</div>';
                return;
            }
            list.innerHTML = matches.map((c, i) => `
                <button type="button" class="city-row" data-idx="${CITY_PRESETS.indexOf(c)}">
                    <div class="city-name">${c.name}</div>
                    <div class="city-country">${c.country}</div>
                </button>`).join('');
            $$('.city-row', list).forEach(btn => {
                btn.addEventListener('click', () => {
                    const c = CITY_PRESETS[parseInt(btn.dataset.idx)];
                    S.settings.location = { lat: c.lat, lng: c.lng, name: `${c.name}, ${c.country}` };
                    // Auto-set calculation method based on country (only if user hasn't manually changed it)
                    const defaultMethod = COUNTRY_METHOD[c.country];
                    if (defaultMethod && !S.settings._methodManuallySet) {
                        S.settings.calcMethod = defaultMethod;
                    }
                    save(KEYS.SETTINGS, S.settings);
                    closeAllModals();
                    invalidatePrayerTimesCache();
                    refreshAllTimes();
                    render();
                    if (S.settings.notifications) schedulePrayerNotifications();
                    toast(`Location: ${c.name}`);
                });
            });
        }

        render();
        $('#city-search')?.addEventListener('input', (e) => render(e.target.value));
        $('#use-gps')?.addEventListener('click', () => {
            closeAllModals();
            requestLocation();
        });

        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
    }

    /* ── Prayer Times Page ─────────────────────────────────────
     * Rich dashboard showing:
     *  - Hero countdown to next prayer
     *  - Current-window progress bar (elapsed from previous to next)
     *  - Ring grid: 5 small rings, one per prayer, filling as its window elapses
     *  - Per-prayer list: adhan + iqama (adhan + user offset)
     *  - Quick stats: time since last, time to next, window length
     * Auto-refreshes every second via startTimesTicker().
     * ────────────────────────────────────────────────────────── */

    const PRAYER_TIME_IDS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
    const _BASE_TIME_LABELS = { fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
    const PRAYER_TIME_LABELS = new Proxy(_BASE_TIME_LABELS, {
        get(target, prop) {
            if (prop === 'dhuhr' && new Date().getDay() === 5) return "Jumu'ah";
            return target[prop];
        }
    });
    // Prayer-ring window order (Sunrise excluded — it's not a prayer, just a time marker)
    const PRAYER_RING_IDS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

    let _timesTicker = null;
    let _tickEls = null; // cached DOM refs for tickTimes — populated by renderPrayerTimes
    // Day the timeline is viewing (0 = today, -1 = yesterday, +1 = tomorrow, etc.)
    // Hero + schedule always show today; only the daybar re-renders when this changes.
    let _dayOffset = 0;

    /* Cache today's prayer times — computeRawTimes does expensive trig and gets called
       via tickTimes every second. Invalidated when the calendar date changes. */
    let _todayTimesCache = { key: '', value: null };
    function getTodayPrayerTimes() {
        const loc = S.settings.location;
        if (!loc) return null;
        const now = new Date();
        const POST_ISHA_ROLL_MS = 60 * 60 * 1000;
        const opts = getTimesOptions();
        const todayRaw = computeRawTimesCached(loc.lat, loc.lng, now, opts);
        const shouldRoll = now > new Date(todayRaw.isha.getTime() + POST_ISHA_ROLL_MS);
        const cacheKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${shouldRoll ? 'R' : 'D'}`;
        if (_todayTimesCache.key === cacheKey && _todayTimesCache.value) {
            return _todayTimesCache.value;
        }
        const baseDate = new Date(now);
        if (shouldRoll) baseDate.setDate(baseDate.getDate() + 1);
        const base = shouldRoll
            ? computeRawTimesCached(loc.lat, loc.lng, baseDate, opts)
            : todayRaw;
        const nextDay = new Date(baseDate); nextDay.setDate(nextDay.getDate() + 1);
        const tomorrowTimes = computeRawTimesCached(loc.lat, loc.lng, nextDay, opts);
        const result = { today: base, tomorrowFajr: tomorrowTimes.fajr, rolled: shouldRoll, baseDate };
        _todayTimesCache = { key: cacheKey, value: result };
        return result;
    }
    function invalidatePrayerTimesCache() { _todayTimesCache = { key: '', value: null }; invalidateRawTimesCache(); }


    /** Build a sorted array of prayer events (Date ascending) to find current + next.
     * Sunrise is included as an event so the hero countdown can target Sunrise between
     * Fajr and Dhuhr — reflecting the Islamic rule that Fajr window ends at sunrise and
     * praying after sunrise is makruh until Dhuhr zawal. */
    function buildPrayerSchedule(times) {
        const events = PRAYER_RING_IDS.map(id => ({ id, name: PRAYER_TIME_LABELS[id], at: times.today[id] }));
        // Include Sunrise so the chain is Fajr → Sunrise → Dhuhr (no gap where
        // the hero jumps past Sunrise to Dhuhr).
        events.push({ id: 'sunrise', name: 'Sunrise', at: times.today.sunrise, isSunrise: true });
        // Tomorrow's Fajr is in the schedule (for the post-Isha overnight countdown) but we label it
        // plainly as "Fajr" in the UI — no "(tomorrow)" clutter.
        events.push({ id: 'fajr-next', name: 'Fajr', at: times.tomorrowFajr });
        events.sort((a, b) => a.at - b.at);
        return events;
    }

    /** Find index of the next-upcoming event in the schedule. Returns -1 if all past (shouldn't happen with tomorrow's Fajr). */
    function findNextPrayerIdx(schedule, now = new Date()) {
        return schedule.findIndex(e => e.at > now);
    }

    function formatDuration(ms, { compact = false } = {}) {
        if (ms < 0) ms = 0;
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (compact) {
            if (h > 0) return `${h}h ${m}m`;
            if (m > 0) return `${m}m ${s}s`;
            return `${s}s`;
        }
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function renderPrayerTimes() {
        const page = $('#times-page');
        if (!page) return;

        const loc = S.settings.location;
        if (!loc) {
            page.innerHTML = `
                <div class="page-placeholder-card">
                    <div class="pph-icon">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="10" r="3" stroke="currentColor" stroke-width="1.5"/></svg>
                    </div>
                    <h2>Prayer Times</h2>
                    <p>Set your location to calculate accurate prayer times.</p>
                    <div class="location-btn-row">
                        <button type="button" class="btn btn-primary" id="enable-location">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="10" r="3" stroke="currentColor" stroke-width="1.5"/></svg>
                            Use my GPS
                        </button>
                        <button type="button" class="btn btn-secondary" id="pick-city">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/><path d="m21 21-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                            Pick a city
                        </button>
                    </div>
                    <p class="times-privacy-note">Your coordinates stay on this device.</p>
                </div>`;
            $('#enable-location')?.addEventListener('click', requestLocation);
            $('#pick-city')?.addEventListener('click', openCityPicker);
            stopTimesTicker();
            return;
        }

        const times = getTodayPrayerTimes();
        const schedule = buildPrayerSchedule(times);
        const methodName = CALC_METHODS[S.settings.calcMethod || 'ISNA'].name;
        const asrName = ASR_SCHOOLS[S.settings.asrSchool || 'standard'].name;
        const iqamaOffsets = S.settings.iqamaOffsets || {};
        const notifOn = !!S.settings.notifications;
        const hijriNow = HijriCalendar.gregorianToHijri(new Date());
        const isRamadan = hijriNow.month === 9;
        const fastingOn = S.settings.fastingTracker !== undefined ? !!S.settings.fastingTracker : isRamadan;

        // Build the static skeleton — dynamic parts updated by tick()
        // Settings live in the global gear icon (top header) — no duplicate controls here.
        page.innerHTML = `
            <div class="times-page-wrap">
                <!-- Header: location + notification toggle -->
                <div class="times-header">
                    <div>
                        <p class="times-location">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="10" r="3" stroke="currentColor" stroke-width="1.5"/></svg>
                            ${loc.name || `${loc.lat.toFixed(3)}, ${loc.lng.toFixed(3)}`}
                        </p>
                    </div>
                    <div class="times-header-actions">
                        <button type="button" class="icon-btn" id="toggle-notif" title="${notifOn ? 'Prayer notifications are ON — click to mute all' : 'Prayer notifications are OFF — click to enable'}" aria-pressed="${notifOn}">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                                ${notifOn
                                    ? '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.73 21a2 2 0 0 1-3.46 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
                                    : '<path d="M13.73 21a2 2 0 0 1-3.46 0M18.63 13A17.89 17.89 0 0 1 18 8M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.33-5M1 1l22 22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'}
                            </svg>
                        </button>
                        <button type="button" class="icon-btn" id="toggle-fasting" title="${fastingOn ? 'Fasting tracker ON — click to hide' : 'Show fasting tracker'}" aria-pressed="${fastingOn}">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                                ${fastingOn
                                    ? '<path d="M6 2h12M6 22h12M6 2c0 4 4 5 4 8s-4 4-4 8h12c0-4-4-5-4-8s4-4 4-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
                                    : '<path d="M6 2h12M6 22h12M6 2c0 4 4 5 4 8s-4 4-4 8h12c0-4-4-5-4-8s4-4 4-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.4"/>'}
                            </svg>
                        </button>
                        <button type="button" class="icon-btn" id="change-location" title="Change location">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/><path d="m21 21-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                        </button>
                    </div>
                </div>

                <!-- 1. Timeline on top: most information-dense element, sets context for everything else -->
                <div class="times-daybar-wrap">
                    <div class="times-daybar" id="times-daybar"></div>
                    <!-- Overlay popover (absolute, no content push) -->
                    <div class="tl-popover" id="tl-popover" role="dialog" aria-hidden="true"></div>
                </div>

                <!-- Fasting tracker bar -->
                <div class="fasting-bar-wrap${fastingOn ? '' : ' hidden'}" id="fasting-bar-wrap">
                    <div class="fasting-hero-label" id="fasting-label">FASTING</div>
                    <div class="fasting-hero-countdown" id="fasting-time">--:--:--</div>
                    <div class="fasting-hero-bar-row">
                        <div class="fhl-edge">
                            ${prayerIconSvg('fajr', 14)}
                            <span class="fhl-name">FAJR</span>
                            <span class="fhl-time" id="fasting-start-time"></span>
                        </div>
                        <div class="fasting-hero-bar">
                            <div class="fasting-hero-fill" id="fasting-fill"></div>
                        </div>
                        <div class="fhl-edge fhl-right">
                            ${prayerIconSvg('maghrib', 14)}
                            <span class="fhl-name">MAGHRIB</span>
                            <span class="fhl-time" id="fasting-end-time"></span>
                        </div>
                    </div>
                    <div class="fasting-hero-elapsed" id="fasting-elapsed"></div>
                </div>

                <!-- 2. Main row: hero on left, schedule on right -->
                <div class="times-main-row">
                    <div class="times-hero" data-mode="countdown">
                        <div class="hero-label" id="hero-label">Time until next prayer</div>
                        <div class="hero-countdown" id="hero-countdown">--:--:--</div>
                        <div class="hero-progress">
                            <div class="hero-progress-labels hero-progress-labels-top">
                                <span class="hpl-side">
                                    <span class="hpl-name" id="hero-progress-from">—</span>
                                    <span class="hpl-time" id="hero-progress-from-time">—</span>
                                </span>
                                <span class="hpl-side hpl-right">
                                    <span class="hpl-name" id="hero-progress-to">—</span>
                                    <span class="hpl-time" id="hero-progress-to-time">—</span>
                                </span>
                            </div>
                            <div class="hero-progress-bar"><div class="hero-progress-fill" id="hero-progress-fill" style="width:0%"></div></div>
                        </div>
                        <!-- Secondary counters row (below the main progress bar).
                             - Since-last: always visible, elapsed HH:MM:SS since previous adhan (neutral)
                             - Iqama: appears only in the post-adhan window (between adhan and iqama),
                                      counts down to iqama. Hides automatically once iqama passes. -->
                        <div class="hero-sub-counters">
                            <div class="hero-sub-counter" id="hsub-since">
                                <div class="hsub-val" id="hsub-since-val">—</div>
                                <div class="hsub-label" id="hsub-since-label">Since last</div>
                            </div>
                            <div class="hero-sub-counter hero-sub-iqama" id="hsub-iqama" hidden>
                                <div class="hsub-val" id="hsub-iqama-val">—</div>
                                <div class="hsub-label" id="hsub-iqama-label">Iqama in</div>
                            </div>
                        </div>

                        <!-- Two side-by-side window cards: CURRENT and NEXT -->
                        <div class="hero-windows">
                            <div class="hw-card hw-current" id="hw-current" data-tone="prayer">
                                <div class="hw-label">Current window</div>
                                <div class="hw-name" id="hw-cur-name">—</div>
                                <div class="hw-count" id="hw-cur-count">—</div>
                                <div class="hw-sub" id="hw-cur-sub">—</div>
                            </div>
                            <div class="hw-card hw-next" id="hw-next">
                                <div class="hw-label">Next window</div>
                                <div class="hw-name" id="hw-nxt-name">—</div>
                                <div class="hw-count" id="hw-nxt-count">—</div>
                                <div class="hw-sub" id="hw-nxt-sub">—</div>
                            </div>
                        </div>
                    </div>

                    <!-- Schedule: adhan + iqama for all prayers.
                         After Isha+1hr the heading switches to "Tomorrow's Schedule" so the
                         user sees the upcoming day's lineup instead of a stale today list. -->
                    <div class="times-timeline">
                        <div class="times-timeline-head">
                            <h3>${times.rolled ? "Tomorrow's Schedule" : "Today's Schedule"}</h3>
                            <div class="times-timeline-sub">Adhan</div>
                        </div>
                        <div class="times-timeline-list" id="times-timeline-list"></div>
                    </div>
                </div>

                <p class="times-footnote">
                    ${methodName} · ${asrName}
                </p>
            </div>`;

        // Static: timeline rows — 5 prayers + Sunrise as a subtle reference row.
        // Each prayer row has a prayer icon on the left and a per-prayer notification toggle
        // on the right so the user can mute specific prayers. Sunrise is informational only.
        const perPrayerNotifs = S.settings.prayerNotifs || {
            fajr: true, dhuhr: true, asr: true, maghrib: true, isha: true,
        };
        const list = $('#times-timeline-list');
        if (list) {
            list.innerHTML = PRAYER_TIME_IDS.map(id => {
                const at = times.today[id];
                const isRef = id === 'sunrise';
                const notifOn = perPrayerNotifs[id] !== false;
                const iconSvg = `<svg class="time-row-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">${PRAYER_ICONS[id] || '<circle cx="12" cy="12" r="4" fill="currentColor"/>'}</svg>`;
                const notifBtn = isRef ? '' : `
                    <button type="button" class="time-row-notif ${notifOn ? 'on' : 'off'}" data-notif-prayer="${id}" title="${notifOn ? 'Notifications on' : 'Notifications muted'} for ${PRAYER_TIME_LABELS[id]}" aria-label="Toggle ${PRAYER_TIME_LABELS[id]} notifications">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                            ${notifOn
                                ? '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.73 21a2 2 0 0 1-3.46 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
                                : '<path d="M13.73 21a2 2 0 0 1-3.46 0M18.63 13A17.89 17.89 0 0 1 18 8M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.33-5M1 1l22 22" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'}
                        </svg>
                    </button>`;
                return `
                <div class="time-row${isRef ? ' time-row-ref' : ''}" data-timeline-id="${id}">
                    ${iconSvg}
                    <span class="time-name">${PRAYER_TIME_LABELS[id]}</span>
                    <span class="time-adhan">${formatTime12(at)}</span>
                    ${notifBtn}
                </div>`;
            }).join('');

            
            $$('.time-row-notif', list).forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const pid = btn.dataset.notifPrayer;
                    const current = S.settings.prayerNotifs || { fajr: true, dhuhr: true, asr: true, maghrib: true, isha: true };
                    current[pid] = !(current[pid] !== false);
                    S.settings.prayerNotifs = current;
                    save(KEYS.SETTINGS, S.settings);
                    // Update JUST this button's visuals — avoid a full page re-render that
                    // would reset the timeline scroll position (the "glitch" user saw).
                    const nowOn = current[pid] !== false;
                    btn.classList.toggle('on', nowOn);
                    btn.classList.toggle('off', !nowOn);
                    btn.title = `${nowOn ? 'Notifications on' : 'Notifications muted'} for ${PRAYER_TIME_LABELS[pid]}`;
                    btn.innerHTML = `
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                            ${nowOn
                                ? '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.73 21a2 2 0 0 1-3.46 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
                                : '<path d="M13.73 21a2 2 0 0 1-3.46 0M18.63 13A17.89 17.89 0 0 1 18 8M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.33-5M1 1l22 22" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'}
                        </svg>`;
                    if (S.settings.notifications) schedulePrayerNotifications();
                    toast(`${PRAYER_TIME_LABELS[pid]} ${nowOn ? 'on' : 'muted'}`);
                });
            });
        }

        // Event wiring
        $('#change-location')?.addEventListener('click', openCityPicker);
        $('#toggle-notif')?.addEventListener('click', togglePrayerNotifications);
        $('#toggle-fasting')?.addEventListener('click', () => {
            S.settings.fastingTracker = !S.settings.fastingTracker;
            save(KEYS.SETTINGS, S.settings);
            const wrap = $('#fasting-bar-wrap');
            const btn = $('#toggle-fasting');
            const on = !!S.settings.fastingTracker;
            if (wrap) wrap.classList.toggle('hidden', !on);
            if (btn) {
                btn.setAttribute('aria-pressed', on);
                btn.title = on ? 'Fasting tracker ON — click to hide' : 'Show fasting tracker';
                btn.querySelector('svg').innerHTML = on
                    ? '<path d="M6 2h12M6 22h12M6 2c0 4 4 5 4 8s-4 4-4 8h12c0-4-4-5-4-8s4-4 4-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
                    : '<path d="M6 2h12M6 22h12M6 2c0 4 4 5 4 8s-4 4-4 8h12c0-4-4-5-4-8s4-4 4-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.4"/>';
            }
            if (on) tickFasting();
        });

        // Day timeline skeleton: 24h scale with tinted windows (Duha / Karaha / Last-Third)
        // + prayer markers. Track is wider than the card (200% base) so the user can slide
        // horizontally to see past/future — no day-nav buttons needed.
        const timelineEl = $('#times-daybar');
        if (timelineEl) {
            const renderNow = new Date();
            const dayTimes = times;
            const todayMidnight = new Date(renderNow.getFullYear(), renderNow.getMonth(), renderNow.getDate());

            // ── Continuous 3-day slide: yesterday + today + tomorrow mapped onto a 72h range.
            // Track is 300% width; each day occupies 100% (so 1% ≈ 14.4 minutes).
            // pctOf3Day(d) returns position 0-100 across the 3-day window.
            const slideStart = new Date(todayMidnight); slideStart.setDate(slideStart.getDate() - 1);
            const TOTAL_MS = 72 * 3600 * 1000;
            const pctOfDay = (d) => ((d - slideStart) / TOTAL_MS) * 100; // name kept for call-sites
            const clampPct = (p) => Math.max(0, Math.min(100, p));

            // Build 3 consecutive days (yest/today/tom) of prayer times for rendering.
            // If location is missing we skip the render entirely (guarded upstream).
            const loc0 = S.settings.location;
            const opts = getTimesOptions();
            const yestDate = new Date(todayMidnight); yestDate.setDate(yestDate.getDate() - 1);
            const tomDate = new Date(todayMidnight); tomDate.setDate(tomDate.getDate() + 1);
            const dayAfterDate = new Date(todayMidnight); dayAfterDate.setDate(dayAfterDate.getDate() + 2);
            const yestTimes = computeRawTimesCached(loc0.lat, loc0.lng, yestDate, opts);
            const tomTimes = computeRawTimesCached(loc0.lat, loc0.lng, tomDate, opts);
            const dayAfterTimes = computeRawTimesCached(loc0.lat, loc0.lng, dayAfterDate, opts);

            // Each rendered day: its prayer times + the Fajr of the day after (for night-window math).
            // Order matters — must match the 3-day slide (yesterday at 0-33%, today at 33-67%, tomorrow at 67-100%).
            const days = [
                { times: yestTimes, nextFajr: times.today.fajr, label: 'Yesterday', dateKey: 'yest' },
                { times: times.today, nextFajr: times.tomorrowFajr, label: 'Today',     dateKey: 'today' },
                { times: tomTimes,  nextFajr: dayAfterTimes.fajr,  label: 'Tomorrow',  dateKey: 'tom' },
            ];

            // Today's times (the hero/schedule context — still used for popover fallbacks)
            const t = times.today;

            // windowEnds for TODAY specifically (used by popovers/click handlers that still exist today-only)
            const windowEnds = {
                fajr: t.sunrise,
                dhuhr: t.asr,
                asr: t.maghrib,
                maghrib: t.isha,
                isha: dayTimes.tomorrowFajr,
            };

            // ── Build renderable arrays across all 3 days ──
            const prayerBandsAll = [];
            const duhaSegsAll = [];
            const karahaSegsAll = [];
            const thirdSegsAll = [];
            const markerSpecsAll = [];

            days.forEach((day) => {
                const dt = day.times;
                const winEnds = {
                    fajr: dt.sunrise, dhuhr: dt.asr, asr: dt.maghrib, maghrib: dt.isha, isha: day.nextFajr,
                };

                // Prayer bands — no day clamp, isha's band naturally spans into next day's slot on the 3-day track
                PRAYER_RING_IDS.forEach(id => {
                    const startAt = dt[id];
                    const endAt = winEnds[id];
                    prayerBandsAll.push({
                        id, day: day.dateKey,
                        name: PRAYER_TIME_LABELS[id],
                        fromPct: clampPct(pctOfDay(startAt)),
                        toPct: clampPct(pctOfDay(endAt)),
                        dur: formatDuration(endAt - startAt, { compact: true }),
                        startAt, endAt,
                    });
                });

                // Duha — ends exactly when Zawal karaha starts (no gap between windows)
                const duhaStart = new Date(dt.sunrise.getTime() + 15 * 60 * 1000);
                const duhaEnd = new Date(dt.dhuhr.getTime() - 10 * 60 * 1000);
                duhaSegsAll.push({
                    fromPct: clampPct(pctOfDay(duhaStart)),
                    toPct: clampPct(pctOfDay(duhaEnd)),
                    startAt: duhaStart, endAt: duhaEnd,
                    dur: formatDuration(duhaEnd - duhaStart, { compact: true }),
                });

                // Karaha (3 windows per day) — store duration so tooltip/popover can surface it
                [
                    { from: dt.sunrise, to: new Date(dt.sunrise.getTime() + 15 * 60 * 1000), label: 'after sunrise' },
                    { from: new Date(dt.dhuhr.getTime() - 10 * 60 * 1000), to: dt.dhuhr, label: 'before zawal' },
                    { from: new Date(dt.maghrib.getTime() - 15 * 60 * 1000), to: dt.maghrib, label: 'before sunset' },
                ].forEach(k => {
                    karahaSegsAll.push({
                        fromPct: clampPct(pctOfDay(k.from)),
                        toPct: clampPct(pctOfDay(k.to)),
                        startAt: k.from, endAt: k.to,
                        dur: formatDuration(k.to - k.from, { compact: true }),
                        label: k.label,
                    });
                });

                // Last third (maghrib → next fajr, may cross into next day's slot)
                const nightMs = day.nextFajr - dt.maghrib;
                const lastStart = new Date(dt.maghrib.getTime() + (2/3) * nightMs);
                thirdSegsAll.push({
                    fromPct: clampPct(pctOfDay(lastStart)),
                    toPct: clampPct(pctOfDay(day.nextFajr)),
                    startAt: lastStart, endAt: day.nextFajr,
                    dur: formatDuration(day.nextFajr - lastStart, { compact: true }),
                });

                // Markers — prayers + sunrise
                PRAYER_RING_IDS.forEach(id => {
                    markerSpecsAll.push({
                        id, day: day.dateKey, at: dt[id], leftPct: pctOfDay(dt[id]),
                        endAt: winEnds[id], label: PRAYER_TIME_LABELS[id],
                    });
                });
                markerSpecsAll.push({
                    id: 'sunrise', day: day.dateKey, at: dt.sunrise, leftPct: pctOfDay(dt.sunrise),
                    label: 'Sunrise', isSunrise: true,
                });
            });

            // Add synthetic Isha band from midnight to yesterday's Fajr (previous night's Isha continuation)
            const yestFajrPct = clampPct(pctOfDay(yestTimes.fajr));
            if (yestFajrPct > 0.1) {
                prayerBandsAll.unshift({
                    id: 'isha', day: 'yest-night',
                    name: PRAYER_TIME_LABELS['isha'],
                    fromPct: 0,
                    toPct: yestFajrPct,
                    dur: formatDuration(yestTimes.fajr - slideStart, { compact: true }),
                    startAt: slideStart, endAt: yestTimes.fajr,
                });
            }

            const prayerBands = prayerBandsAll;
            const duhaSegs = duhaSegsAll;
            const karahaSegs = karahaSegsAll;
            const thirdSegs = thirdSegsAll;

            timelineEl.innerHTML = `
                <!-- Top bar: legend icon only (recenter chip now lives below the track) -->
                <div class="daybar-topbar">
                    <button type="button" class="daybar-info-btn" id="daybar-info" aria-label="Show timeline legend" title="What do the colors mean?">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.6"/>
                            <path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                        </svg>
                    </button>
                </div>

                <!-- Scroll container: 3-day track; drag to see yesterday / tomorrow -->
                <div class="daybar-scroll" id="daybar-scroll">
                    <div class="daybar-track">
                        <!-- Day dividers + labels at 33.33% and 66.67% -->
                        <div class="daybar-day-divider" style="left:33.333%"></div>
                        <div class="daybar-day-divider" style="left:66.667%"></div>
                        ${days.map((d, i) => {
                            const centerPct = (i * 100 / 3) + (100 / 6);
                            return `<div class="daybar-day-label" data-day="${d.dateKey}" style="left:${centerPct}%">${d.label}</div>`;
                        }).join('')}

                        <!-- Prayer window bands across all 3 days.
                             Threshold lowered so even short windows (Fajr→Sunrise, Maghrib→Isha)
                             show their duration text. -->
                        ${prayerBands.map(b => {
                            const w = Math.max(0.15, b.toPct - b.fromPct);
                            return `
                            <div class="daybar-window daybar-window-${b.id}"
                                 data-day="${b.day}"
                                 style="left:${b.fromPct}%;width:${w}%"
                                 title="${b.name} · ${b.dur}">
                                ${w > 0.6 ? `<span class="daybar-win-dur">${b.dur}</span>` : ''}
                            </div>
                        `;}).join('')}

                        <!-- Duha (one per day) -->
                        ${duhaSegs.map(s => {
                            const w = Math.max(0, s.toPct - s.fromPct);
                            return `
                            <div class="daybar-seg daybar-seg-duha"
                                 style="left:${s.fromPct}%;width:${w}%"
                                 title="Duha · ${s.dur}">
                                ${w > 1.5 ? `<span class="daybar-seg-name">Duha</span>` : ''}
                                ${w > 3 ? `<span class="daybar-seg-dur">${s.dur}</span>` : ''}
                            </div>
                        `;}).join('')}

                        <!-- Karaha (3 per day) — strips are too narrow for inline text; tooltip
                             surfaces duration + label. Click opens full popover with start/end time. -->
                        ${karahaSegs.map(s => {
                            const w = Math.max(0.15, s.toPct - s.fromPct);
                            return `
                            <div class="daybar-seg daybar-seg-karaha"
                                 style="left:${s.fromPct}%;width:${w}%"
                                 title="Karaha ${s.label} · ${s.dur} · avoid praying"></div>
                        `;}).join('')}

                        <!-- Last third (one per day) -->
                        ${thirdSegs.map(s => {
                            const w = Math.max(0, s.toPct - s.fromPct);
                            return `
                            <div class="daybar-seg daybar-seg-third"
                                 style="left:${s.fromPct}%;width:${w}%"
                                 title="Last third · ${s.dur}">
                                ${w > 1.5 ? `<span class="daybar-seg-name">Last third</span>` : ''}
                                ${w > 3 ? `<span class="daybar-seg-dur">${s.dur}</span>` : ''}
                            </div>
                        `;}).join('')}

                        <!-- NOW line (pulsing, emphasized) -->
                        <div class="daybar-now" id="daybar-now" style="left:0%">
                            <span class="daybar-now-label">NOW</span>
                        </div>

                        <!-- Prayer markers -->
                        <div class="daybar-markers" id="daybar-markers"></div>

                        <!-- Hour labels: every 3h so user has real density (8 per day × 3 days = 24).
                             Midnight boundaries (00:00) get a prominent style so tomorrow/today/yesterday
                             boundaries are visually obvious. -->
                        <div class="daybar-labels-inner">
                            ${(() => {
                                const out = [];
                                for (let dayIdx = 0; dayIdx < 3; dayIdx++) {
                                    [0, 3, 6, 9, 12, 15, 18, 21].forEach(h => {
                                        const pct = (dayIdx * 100 / 3) + ((h / 24) * (100 / 3));
                                        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
                                        const ampm = h < 12 ? 'AM' : 'PM';
                                        const label = `${h12} ${ampm}`;
                                        const midnight = h === 0 ? ' daybar-hour-midnight' : '';
                                        out.push(`<span class="daybar-hour-label${midnight}" style="left:${pct}%">${label}</span>`);
                                    });
                                }
                                return out.join('');
                            })()}
                        </div>
                    </div>
                </div>

                <!-- Legend popover (hidden until 'i' clicked) -->
                <div class="daybar-legend-pop" id="daybar-legend-pop" role="dialog" aria-hidden="true">
                    <div class="dlp-title">Timeline legend</div>
                    <div class="dlp-group">
                        <div class="dlp-group-label">Prayer windows</div>
                        <div class="dlp-items">
                            <span class="daybar-legend-item"><span class="dbl-swatch dbl-fajr"></span>Fajr</span>
                            <span class="daybar-legend-item"><span class="dbl-swatch dbl-dhuhr"></span>Dhuhr</span>
                            <span class="daybar-legend-item"><span class="dbl-swatch dbl-asr"></span>Asr</span>
                            <span class="daybar-legend-item"><span class="dbl-swatch dbl-maghrib"></span>Maghrib</span>
                            <span class="daybar-legend-item"><span class="dbl-swatch dbl-isha"></span>Isha</span>
                        </div>
                    </div>
                    <div class="dlp-group">
                        <div class="dlp-group-label">Special windows</div>
                        <div class="dlp-items">
                            <span class="daybar-legend-item"><span class="dbl-swatch dbl-duha"></span>Duha · Sunnah</span>
                            <span class="daybar-legend-item"><span class="dbl-swatch dbl-third"></span>Last third · Tahajjud</span>
                            <span class="daybar-legend-item"><span class="dbl-swatch dbl-karaha"></span>Karaha · Avoid praying</span>
                        </div>
                    </div>
                </div>`;

            // Info-icon toggle. When legend is open, also add `legend-open` to the daybar card
            // so its z-index rises above sibling cards (hero, schedule) — otherwise the popover
            // renders behind them due to adjacent stacking contexts.
            const legendPop = $('#daybar-legend-pop');
            const infoBtn = $('#daybar-info');
            const syncStack = (open) => {
                timelineEl.classList.toggle('legend-open', !!open);
                legendPop?.setAttribute('aria-hidden', open ? 'false' : 'true');
            };
            infoBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = legendPop?.classList.toggle('active');
                syncStack(isOpen);
            });
            document.addEventListener('click', (e) => {
                if (!legendPop || !legendPop.classList.contains('active')) return;
                if (!legendPop.contains(e.target) && e.target !== infoBtn && !infoBtn?.contains(e.target)) {
                    legendPop.classList.remove('active');
                    syncStack(false);
                }
            });

            // Prayer markers — thin vertical bars with text labels above the track.
            // Render markers for all 3 days (yesterday + today + tomorrow).
            const markers = $('#daybar-markers');
            if (markers) {
                markers.innerHTML = markerSpecsAll.map(m => {
                    const extra = m.isSunrise ? ' daybar-marker-sunrise' : '';
                    const label = m.isSunrise ? 'Sunrise' : m.label;
                    return `<button type="button" class="daybar-marker${extra}" style="left:${m.leftPct}%" data-marker="${m.id}" data-day="${m.day}" aria-label="${label} at ${formatTime12(m.at)}" title="${label} · ${formatTime12(m.at)}">
                        <span class="daybar-marker-label">${label}</span>
                        <span class="daybar-marker-bar"></span>
                    </button>`;
                }).join('');

                // Click markers / bands → open the floating popover with details.
                // Popover is absolute-positioned above the daybar track, anchored by `left: X%`.
                // We clamp to [10%, 90%] so it never overflows the viewport.
                const pop = $('#tl-popover');
                const closePop = () => { if (pop) { pop.classList.remove('active'); pop.setAttribute('aria-hidden', 'true'); } };
                const openPop = (html, leftPct) => {
                    if (!pop) return;
                    pop.innerHTML = html + `<button type="button" class="tl-popover-close" aria-label="Close">×</button>`;
                    // The track is wider than the viewport; compute the popover's screen-space X
                    // by projecting `leftPct` of the track through current scroll offset.
                    const scroller = $('#daybar-scroll');
                    const track = scroller?.querySelector('.daybar-track');
                    if (scroller && track) {
                        const trackW = track.offsetWidth;
                        const viewportW = scroller.clientWidth;
                        const pxOnTrack = (leftPct / 100) * trackW;
                        const pxOnScreen = pxOnTrack - scroller.scrollLeft;
                        const clampedPx = Math.max(100, Math.min(viewportW - 100, pxOnScreen));
                        pop.style.left = `${clampedPx}px`;
                        pop.style.removeProperty('right');
                    } else {
                        pop.style.left = `${Math.max(15, Math.min(85, leftPct))}%`;
                    }
                    pop.classList.add('active');
                    pop.setAttribute('aria-hidden', 'false');
                    pop.querySelector('.tl-popover-close')?.addEventListener('click', closePop);
                };
                // Esc closes
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape' && pop?.classList.contains('active')) closePop();
                });

                // Helper: render a popover with name + range + duration
                const rangePopHtml = (title, from, to, hint) => {
                    const durMs = to - from;
                    const dur = formatDuration(durMs, { compact: true });
                    return `
                        <div class="tl-popover-title">${title}</div>
                        <div class="tl-popover-time">${formatTime12(from)} – ${formatTime12(to)}</div>
                        <div class="tl-popover-dur">Lasts ${dur}</div>
                        ${hint ? `<div class="tl-popover-hint">${hint}</div>` : ''}
                    `;
                };

                // Prayer marker click → find matching spec (marker id + day key), show details
                $$('.daybar-marker', markers).forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const id = btn.dataset.marker;
                        const day = btn.dataset.day;
                        const spec = markerSpecsAll.find(m => m.id === id && m.day === day);
                        if (!spec) return;
                        const dayLabel = day === 'today' ? '' : ` · ${days.find(d => d.dateKey === day)?.label || ''}`;
                        if (spec.isSunrise) {
                            const html = `
                                <div class="tl-popover-title">Sunrise${dayLabel}</div>
                                <div class="tl-popover-time">${formatTime12(spec.at)}</div>
                                <div class="tl-popover-hint">Fajr window ends</div>
                            `;
                            openPop(html, spec.leftPct);
                            return;
                        }
                        const endAt = spec.endAt;
                        const durMs = endAt - spec.at;
                        const html = `
                            <div class="tl-popover-title">${spec.label}${dayLabel}</div>
                            <div class="tl-popover-time">${formatTime12(spec.at)}</div>
                            <div class="tl-popover-dur">Window: ${formatDuration(durMs, { compact: true })}</div>
                            <div class="tl-popover-hint">Until ${formatTime12(endAt)}</div>
                        `;
                        openPop(html, spec.leftPct);
                    });
                });

                // Band click — match DOM element back to its data record via position.
                // For each segment, we look up by (left%, className) against the appropriate array.
                $$('.daybar-seg', timelineEl).forEach(seg => {
                    seg.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const leftPct = parseFloat(seg.style.left) + parseFloat(seg.style.width) / 2;
                        const segLeft = parseFloat(seg.style.left);
                        let html = '';
                        if (seg.classList.contains('daybar-seg-duha')) {
                            const match = duhaSegs.find(s => Math.abs(s.fromPct - segLeft) < 0.01);
                            if (match) html = rangePopHtml('Duha', match.startAt, match.endAt, 'Sunnah prayer time');
                        } else if (seg.classList.contains('daybar-seg-third')) {
                            const match = thirdSegs.find(s => Math.abs(s.fromPct - segLeft) < 0.01);
                            if (match) html = rangePopHtml('Last third of night', match.startAt, match.endAt, 'Best time for Tahajjud');
                        } else if (seg.classList.contains('daybar-seg-karaha')) {
                            const match = karahaSegs.find(s => Math.abs(s.fromPct - segLeft) < 0.01);
                            if (match) html = rangePopHtml('Karaha', match.startAt, match.endAt, 'Avoid praying during this time');
                        }
                        if (html) openPop(html, leftPct);
                    });
                });

                // Prayer window band click → look up matching band by day + prayer id
                $$('.daybar-window', timelineEl).forEach(seg => {
                    seg.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const leftPct = parseFloat(seg.style.left) + parseFloat(seg.style.width) / 2;
                        const pCls = [...seg.classList].find(c => c.startsWith('daybar-window-') && c !== 'daybar-window');
                        const pid = pCls ? pCls.replace('daybar-window-', '') : null;
                        const day = seg.dataset.day;
                        const match = prayerBands.find(b => b.id === pid && b.day === day);
                        if (!match) return;
                        const dayLabel = day === 'today' ? '' : ` · ${days.find(d => d.dateKey === day)?.label || ''}`;
                        const html = rangePopHtml(`${match.name} window${dayLabel}`, match.startAt, match.endAt, 'From adhan to next prayer');
                        openPop(html, leftPct);
                    });
                });

                
                document.addEventListener('click', (e) => {
                    if (!pop) return;
                    if (!pop.contains(e.target) && !timelineEl.contains(e.target)) closePop();
                }, { capture: true });
            }

            // ── Drag-to-pan the timeline ──
            const scroller = $('#daybar-scroll');
            const centerOnNow = (smooth) => {
                if (!scroller) return;
                const nowEl = $('#daybar-now');
                const track = scroller.querySelector('.daybar-track');
                if (!nowEl || !track) { scroller.scrollLeft = 0; return; }
                const pct = parseFloat(nowEl.style.left) || 50;
                const nowX = (pct / 100) * track.offsetWidth;
                scroller.scrollTo({ left: Math.max(0, nowX - scroller.clientWidth / 2), behavior: smooth ? 'smooth' : 'instant' });
            };
            if (scroller) {
                setTimeout(() => centerOnNow(false), 50);
                const nowLabel = timelineEl.querySelector('.daybar-now-label');
                nowLabel?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    centerOnNow(true);
                });
                // Transform the SAME NOW pill into an edge-stuck chip when NOW is scrolled off.
                // The pill converts: 'NOW' → '‹ NOW' (left edge) or 'NOW ›' (right edge).
                // When NOW scrolls back into view, pill reverts to centered normal chip.
                const nowEl = $('#daybar-now');
                const updateNowChip = () => {
                    if (!nowEl || !nowLabel) return;
                    const track = scroller.querySelector('.daybar-track');
                    if (!track) return;
                    const pct = parseFloat(nowEl.style.left) || 0;
                    const nowX = (pct / 100) * track.offsetWidth;
                    const viewStart = scroller.scrollLeft;
                    const viewEnd = viewStart + scroller.clientWidth;
                    const PAD = 30;
                    if (nowX < viewStart + PAD) {
                        // NOW off-screen LEFT — label positions relative to NOW line (which is off to the left).
                        // Offset to place label at viewport's left edge: (viewStart + 8) - nowX
                        nowEl.dataset.stuck = 'left';
                        nowLabel.textContent = '‹ NOW';
                        nowLabel.style.left = `${(viewStart + 8) - nowX}px`;
                        nowLabel.style.right = 'auto';
                    } else if (nowX > viewEnd - PAD) {
                        // NOW off-screen RIGHT — offset to place label at viewport's right edge.
                        nowEl.dataset.stuck = 'right';
                        nowLabel.textContent = 'NOW ›';
                        nowLabel.style.left = `${(viewEnd - 8) - nowX}px`;
                        nowLabel.style.right = 'auto';
                    } else {
                        // NOW visible — pill returns to normal centered state above the NOW line
                        delete nowEl.dataset.stuck;
                        nowLabel.textContent = 'NOW';
                        nowLabel.style.left = '';
                        nowLabel.style.right = '';
                    }
                };
                scroller.addEventListener('scroll', updateNowChip, { passive: true });
                setTimeout(updateNowChip, 80);
                setTimeout(updateNowChip, 300);

                // Day labels (Yesterday / Today / Tomorrow) track with the scroll — each label
                // pins to the middle of whatever portion of its day-slot is currently visible.
                // If yesterday's slot is only half visible, the "Yesterday" label centers on that half.
                // This keeps labels anchored near the day junctions as the user slides.
                const DAY_BOUNDS = { yest: [0, 33.333], today: [33.333, 66.667], tom: [66.667, 100] };
                const updateActiveDay = () => {
                    const track = scroller.querySelector('.daybar-track');
                    if (!track) return;
                    const trackW = track.offsetWidth;
                    const viewStartPct = (scroller.scrollLeft / trackW) * 100;
                    const viewEndPct = ((scroller.scrollLeft + scroller.clientWidth) / trackW) * 100;
                    const centerPct = (viewStartPct + viewEndPct) / 2;

                    let active;
                    if (centerPct < 33.333) active = 'yest';
                    else if (centerPct < 66.667) active = 'today';
                    else active = 'tom';

                    $$('.daybar-day-label', track).forEach(el => {
                        const day = el.dataset.day;
                        const [from, to] = DAY_BOUNDS[day] || [0, 100];
                        // Intersect day-slot with visible range
                        const visFrom = Math.max(from, viewStartPct);
                        const visTo = Math.min(to, viewEndPct);
                        if (visTo > visFrom) {
                            const midPct = (visFrom + visTo) / 2;
                            el.style.left = `${midPct}%`;
                            el.style.opacity = '';
                        } else {
                            // Day slot out of view — hide label rather than park it at an edge
                            el.style.opacity = '0';
                        }
                        el.classList.toggle('active', day === active);
                    });
                };
                scroller.addEventListener('scroll', updateActiveDay, { passive: true });
                setTimeout(updateActiveDay, 60);

                // Drag to pan
                let isDown = false, startX = 0, scrollStart = 0, dragged = false;
                scroller.addEventListener('mousedown', (e) => {
                    isDown = true; dragged = false;
                    startX = e.pageX;
                    scrollStart = scroller.scrollLeft;
                    scroller.classList.add('dragging');
                });
                window.addEventListener('mousemove', (e) => {
                    if (!isDown) return;
                    const dx = e.pageX - startX;
                    if (Math.abs(dx) > 3) dragged = true;
                    scroller.scrollLeft = scrollStart - dx;
                });
                window.addEventListener('mouseup', () => {
                    if (!isDown) return;
                    isDown = false;
                    scroller.classList.remove('dragging');
                    // If a real drag happened, swallow the next click so markers don't fire
                    if (dragged) {
                        const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
                        scroller.addEventListener('click', swallow, { capture: true, once: true });
                    }
                });
                
                scroller.addEventListener('touchstart', (e) => {
                    isDown = true;
                    startX = e.touches[0].pageX;
                    scrollStart = scroller.scrollLeft;
                }, { passive: true });
                scroller.addEventListener('touchmove', (e) => {
                    if (!isDown) return;
                    scroller.scrollLeft = scrollStart - (e.touches[0].pageX - startX);
                }, { passive: true });
                scroller.addEventListener('touchend', () => { isDown = false; });
            }
        }

        // Kick off the ticker
        // Cache DOM refs used by tickTimes — avoids 15+ querySelector calls per second
        _tickEls = {
            hero: $('.times-hero'),
            heroLabel: $('#hero-label'),
            heroCountdown: $('#hero-countdown'),
            fill: $('#hero-progress-fill'),
            fromEl: $('#hero-progress-from'),
            toEl: $('#hero-progress-to'),
            fromTimeEl: $('#hero-progress-from-time'),
            toTimeEl: $('#hero-progress-to-time'),
            sinceVal: $('#hsub-since-val'),
            sinceLabel: $('#hsub-since-label'),
            iqamaWrap: $('#hsub-iqama'),
            iqamaVal: $('#hsub-iqama-val'),
            iqamaLabel: $('#hsub-iqama-label'),
            hwCurCard: $('#hw-current'),
            hwCurName: $('#hw-cur-name'),
            hwCurCount: $('#hw-cur-count'),
            hwCurSub: $('#hw-cur-sub'),
            hwNxtCard: $('#hw-next'),
            hwNxtName: $('#hw-nxt-name'),
            hwNxtCount: $('#hw-nxt-count'),
            hwNxtSub: $('#hw-nxt-sub'),
        };
        tickFasting();
        startTimesTicker();
        tickTimes();
    }

    /** Re-render the Times page (if visible) and re-schedule notifications after settings change. */
    function refreshAllTimes() {
        invalidatePrayerTimesCache();
        _yestTimesCache = { key: '', value: null };
        if ($('.page.active')?.dataset.page === 'times') renderPrayerTimes();
        if (S.settings.notifications) schedulePrayerNotifications();
        updateClock();
    }

    function startTimesTicker() {
        stopTimesTicker();
        _timesTicker = setInterval(tickTimes, 1000);
    }

    function stopTimesTicker() {
        if (_timesTicker) { clearInterval(_timesTicker); _timesTicker = null; }
    }

    /* Cache yesterday's computed prayer times keyed by calendar date — tickTimes
       runs every second and would otherwise recompute trig-heavy times twice per tick.
       Invalidated automatically when the date key changes. */
    let _yestTimesCache = { key: '', value: null };
    function getYesterdayTimes(now) {
        const loc = S.settings.location;
        if (!loc) return null;
        const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
        if (_yestTimesCache.key === key && _yestTimesCache.value) return _yestTimesCache.value;
        const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
        const value = computeRawTimesCached(loc.lat, loc.lng, yesterday, getTimesOptions());
        _yestTimesCache = { key, value };
        return value;
    }

    /** Per-second render — only touches dynamic values (no re-innerHTML of the whole page). */
    function tickTimes() {
        const page = $('#times-page');
        if (!page || !page.isConnected) return;
        const activePage = $('.page.active')?.dataset.page;
        if (activePage !== 'times') return; // pause when off-screen

        const times = getTodayPrayerTimes();
        if (!times) return;
        const schedule = buildPrayerSchedule(times);
        const now = new Date();
        const nextIdx = findNextPrayerIdx(schedule, now);
        if (nextIdx < 0) return;

        const next = schedule[nextIdx];
        // If nothing before 'next' in today's schedule, fall back to YESTERDAY'S ISHA
        // (this happens when now is between midnight and today's Fajr).
        let prev = nextIdx > 0 ? schedule[nextIdx - 1] : null;
        if (!prev) {
            const yt = getYesterdayTimes(now);
            if (yt) prev = { id: 'isha', name: 'Isha', at: yt.isha };
        }
        const msToNext = next.at - now;
        const windowStart = prev ? prev.at : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const windowMs = next.at - windowStart;
        const elapsedMs = now - windowStart;
        const pct = Math.max(0, Math.min(100, (elapsedMs / windowMs) * 100));

        const sinceMs = prev ? (now - prev.at) : Infinity;
        const el = _tickEls || {};
        const { hero, heroLabel, heroCountdown, fill, fromEl, toEl, fromTimeEl, toTimeEl } = el;

        // Hero always shows countdown to next prayer/event — clean, predictable.
        // The secondary "Since last" counter below handles elapsed-time display.
        if (hero) hero.dataset.mode = 'countdown';
        if (heroLabel) heroLabel.textContent = `Time to ${next.name}`;
        if (heroCountdown) heroCountdown.textContent = formatDuration(msToNext);
        if (fill) fill.style.width = `${pct.toFixed(1)}%`;
        const prevId = prev ? (prev.id === 'fajr-next' ? 'fajr' : prev.id) : null;
        const nextId = next.id === 'fajr-next' ? 'fajr' : next.id;
        if (fromEl) fromEl.innerHTML = prev ? `${prayerIconSvg(prevId, 16)}<span>${prev.name}</span>` : 'Midnight';
        if (fromTimeEl) fromTimeEl.textContent = prev ? formatTime12(prev.at) : '12:00 AM';
        if (toEl) toEl.innerHTML = `${prayerIconSvg(nextId, 16)}<span>${next.name}</span>`;
        if (toTimeEl) toTimeEl.textContent = formatTime12(next.at);

        // Iqama counter: visible only when we're within iqama offset of the previous prayer
        const POST_ADHAN_WINDOW_MS = 40 * 60 * 1000;
        const prevIsPrayer = prev && prev.id !== 'sunrise';
        const inPostAdhan = prevIsPrayer && sinceMs <= POST_ADHAN_WINDOW_MS;
        const prevBaseId = prev?.id === 'fajr-next' ? 'fajr' : prev?.id;
        const prevIqamaOffset = prev && PRAYER_RING_IDS.includes(prevBaseId) ? getIqamaOffset(prevBaseId) : 0;
        const prevIqamaAt = prevIqamaOffset > 0 && prev ? new Date(prev.at.getTime() + prevIqamaOffset * 60 * 1000) : null;
        const iqamaVisible = inPostAdhan && prevIqamaAt && prevIqamaAt > now;

        const hsSinceVal = el.sinceVal;
        const hsSinceLabel = el.sinceLabel;
        if (hsSinceVal) hsSinceVal.textContent = prev ? formatDuration(sinceMs) : '—';
        if (hsSinceLabel) hsSinceLabel.textContent = prev ? `Since ${prev.name} adhan` : 'Since last';

        const hsIqamaWrap = el.iqamaWrap;
        const hsIqamaVal = el.iqamaVal;
        const hsIqamaLabel = el.iqamaLabel;
        if (hsIqamaWrap) hsIqamaWrap.hidden = !iqamaVisible;
        if (iqamaVisible) {
            if (hsIqamaVal) hsIqamaVal.textContent = formatDuration(prevIqamaAt - now);
            if (hsIqamaLabel) hsIqamaLabel.textContent = `${prev.name} iqama · ${formatTime12(prevIqamaAt)}`;
        }

        // ── Current / Next window cards ──
        // Build a unified list of ALL windows (prayer + Duha + Karaha + Last third) and find
        // (1) whichever window contains NOW and (2) the next one after NOW. This fixes the
        // empty-Current-card bug at times like 8:40 AM when you're in Duha (not a prayer window).
        const loc = S.settings.location;
        const yestT = loc ? getYesterdayTimes(now) : null;
        if (loc && yestT) {
            const todayT = times.today;
            const tomFajr = times.tomorrowFajr;

            const windows = [
                { kind: 'prayer', name: 'Fajr', tone: 'prayer', start: todayT.fajr, end: todayT.sunrise, prayerId: 'fajr' },
                { kind: 'prayer', name: 'Dhuhr', tone: 'prayer', start: todayT.dhuhr, end: todayT.asr, prayerId: 'dhuhr' },
                { kind: 'prayer', name: 'Asr', tone: 'prayer', start: todayT.asr, end: todayT.maghrib, prayerId: 'asr' },
                { kind: 'prayer', name: 'Maghrib', tone: 'prayer', start: todayT.maghrib, end: todayT.isha, prayerId: 'maghrib' },
                { kind: 'prayer', name: 'Isha', tone: 'prayer', start: todayT.isha, end: tomFajr, prayerId: 'isha' },
                { kind: 'prayer', name: 'Isha', tone: 'prayer', start: yestT.isha, end: todayT.fajr, prayerId: 'isha' },
                { kind: 'duha', name: 'Duha', tone: 'duha', start: new Date(todayT.sunrise.getTime() + 15*60*1000), end: new Date(todayT.dhuhr.getTime() - 10*60*1000) },
                { kind: 'karaha', name: 'Karaha (sunrise)', tone: 'karaha', start: todayT.sunrise, end: new Date(todayT.sunrise.getTime() + 15*60*1000) },
                { kind: 'karaha', name: 'Karaha (zawal)', tone: 'karaha', start: new Date(todayT.dhuhr.getTime() - 10*60*1000), end: todayT.dhuhr },
                { kind: 'karaha', name: 'Karaha (sunset)', tone: 'karaha', start: new Date(todayT.maghrib.getTime() - 15*60*1000), end: todayT.maghrib },
                { kind: 'third', name: 'Last third', tone: 'third', start: new Date(yestT.maghrib.getTime() + (2/3) * (todayT.fajr - yestT.maghrib)), end: todayT.fajr },
                { kind: 'third', name: 'Last third', tone: 'third', start: new Date(todayT.maghrib.getTime() + (2/3) * (tomFajr - todayT.maghrib)), end: tomFajr },
            ];

            // CURRENT = any window containing NOW. If multiple overlap (e.g. Dhuhr window + Karaha zawal),
            // prefer the more specific (non-prayer) one so user sees the karaha warning first.
            const containing = windows.filter(w => now >= w.start && now < w.end);
            const currentWin = containing.find(w => w.kind !== 'prayer') || containing[0];

            // NEXT = first upcoming window that isn't the currently-containing one.
            // Prefer a special window if it's within 4h; otherwise next prayer.
            const upcoming = windows.filter(w => w.start > now).sort((a, b) => a.start - b.start);
            const nextSpecial = upcoming.find(w => w.kind !== 'prayer');
            const nextPrayerWin = upcoming.find(w => w.kind === 'prayer');
            const FOUR_H = 4 * 3600 * 1000;
            const nextWin = (nextSpecial && (nextSpecial.start - now) < FOUR_H) ? nextSpecial : (nextPrayerWin || nextSpecial);

            // ── Populate CURRENT card ──
            const hwCurCard = el.hwCurCard;
            const hwCurName = el.hwCurName;
            const hwCurCount = el.hwCurCount;
            const hwCurSub = el.hwCurSub;
            if (hwCurCard) {
                if (currentWin) {
                    hwCurCard.dataset.tone = currentWin.tone;
                    const displayName = currentWin.kind === 'prayer' ? `${currentWin.name} window` : currentWin.name;
                    if (hwCurName) hwCurName.textContent = displayName;
                    if (hwCurCount) hwCurCount.textContent = formatDuration(currentWin.end - now, { compact: true });
                    if (hwCurSub) hwCurSub.textContent = `ends ${formatTime12(currentWin.end)}`;
                } else {
                    if (hwCurName) hwCurName.textContent = '—';
                    if (hwCurCount) hwCurCount.textContent = '—';
                    if (hwCurSub) hwCurSub.textContent = '';
                }
            }

            // ── Populate NEXT card ──
            // Different info shape from CURRENT (which shows live countdown to end).
            // NEXT shows: the clock TIME the next window starts at, with "lasts Xh Ym" below.
            const hwNxtCard = el.hwNxtCard;
            const hwNxtName = el.hwNxtName;
            const hwNxtCount = el.hwNxtCount;
            const hwNxtSub = el.hwNxtSub;
            if (hwNxtCard && nextWin) {
                hwNxtCard.dataset.tone = nextWin.tone;
                if (hwNxtName) hwNxtName.textContent = nextWin.name;
                if (hwNxtCount) hwNxtCount.textContent = formatTime12(nextWin.start);
                if (hwNxtSub) {
                    const dur = formatDuration(nextWin.end - nextWin.start, { compact: true });
                    hwNxtSub.textContent = `lasts ${dur}`;
                }
            }
        }

        // Move the "now" pointer on the 3-day timeline (yest/today/tom = 300% track).
        // Today's 00:00 is at 33.33%; each hour is ~1.389%.
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const slideStart = new Date(todayMidnight); slideStart.setDate(slideStart.getDate() - 1);
        const dayPct3 = ((now - slideStart) / (72 * 3600 * 1000)) * 100;
        const daybarNow = $('#daybar-now');
        if (daybarNow) daybarNow.style.left = `${dayPct3.toFixed(3)}%`;

        // Mark current/past prayer markers on the timeline (only "today"-marked markers follow schedule)
        $$('.daybar-marker').forEach(m => {
            const id = m.dataset.marker;
            const mDay = m.dataset.day;
            if (!id) return;
            m.classList.remove('past', 'current', 'next');
            // Only apply current/next highlighting to today's markers; past days are opaque dimmed separately.
            if (mDay === 'yest') { m.classList.add('past'); return; }
            if (mDay === 'tom') return; // tomorrow's markers have no state yet
            const selfIdx = schedule.findIndex(e => e.id === id);
            if (selfIdx < 0) return;
            const startAt = schedule[selfIdx].at;
            const endAt = schedule[selfIdx + 1]?.at || new Date(startAt.getTime() + 4 * 3600 * 1000);
            if (now >= startAt && now < endAt) m.classList.add('current');
            else if (now >= endAt) m.classList.add('past');
            else if (id === next.id || (id === 'fajr' && next.id === 'fajr-next')) m.classList.add('next');
        });

        const tlRows = $$('.time-row[data-timeline-id]');
        tlRows.forEach(r => {
            const id = r.dataset.timelineId;
            const selfIdx = schedule.findIndex(e => e.id === id);
            r.classList.remove('current', 'past', 'next');
            if (selfIdx < 0) return;
            const startAt = schedule[selfIdx].at;
            const endAt = schedule[selfIdx + 1]?.at || new Date(startAt.getTime() + 4 * 3600 * 1000);
            if (now >= startAt && now < endAt) r.classList.add('current');
            else if (now >= endAt) r.classList.add('past');
            else if (id === next.id || (id === 'fajr' && next.id === 'fajr-next')) r.classList.add('next');
        });

        const floatEl = $('#next-prayer-text');
        if (floatEl) floatEl.textContent = `${next.name} in ${formatDuration(msToNext, { compact: true })}`;

        tickFasting();
    }

    function tickFasting() {
        const wrap = $('#fasting-bar-wrap');
        if (!wrap || wrap.classList.contains('hidden')) return;

        const times = getTodayPrayerTimes();
        if (!times) return;

        const now = new Date();
        const fajr = times.today.fajr;
        const maghrib = times.today.maghrib;
        const label = $('#fasting-label');
        const timeEl = $('#fasting-time');
        const fill = $('#fasting-fill');
        const startMarker = $('#fasting-start-time');
        const endMarker = $('#fasting-end-time');
        const elapsedEl = $('#fasting-elapsed');

        if (!label || !timeEl || !fill) return;

        if (startMarker) startMarker.innerHTML = formatTime12(fajr);
        if (endMarker) endMarker.innerHTML = formatTime12(maghrib);

        const totalMs = maghrib - fajr;

        const fastIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 2h12M6 22h12M6 2c0 4 4 5 4 8s-4 4-4 8h12c0-4-4-5-4-8s4-4 4-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

        if (now < fajr) {
            label.innerHTML = `${fastIcon} Fasting begins in`;
            timeEl.textContent = formatDuration(fajr - now, { compact: false });
            fill.style.width = '0%';
            if (elapsedEl) elapsedEl.textContent = '';
        } else if (now >= fajr && now < maghrib) {
            const elapsed = now - fajr;
            const remaining = maghrib - now;
            const pct = Math.min(100, (elapsed / totalMs) * 100);
            const hrs = Math.floor(elapsed / 3600000);
            const mins = Math.floor((elapsed % 3600000) / 60000);
            label.innerHTML = `${fastIcon} Fasting`;
            timeEl.textContent = formatDuration(remaining, { compact: false });
            fill.style.width = `${pct.toFixed(1)}%`;
            if (elapsedEl) elapsedEl.textContent = `${hrs}h ${mins}m elapsed`;
        } else {
            const hrs = Math.floor(totalMs / 3600000);
            const mins = Math.floor((totalMs % 3600000) / 60000);
            label.innerHTML = `${fastIcon} Fasting complete`;
            timeEl.textContent = `${hrs}h ${mins}m`;
            fill.style.width = '100%';
            if (elapsedEl) elapsedEl.textContent = '';
        }
    }

    function requestLocation() {
        if (!navigator.geolocation) {
            toast('Geolocation not supported');
            return;
        }
        toast('Requesting location…');
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                S.settings.location = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    name: `${pos.coords.latitude.toFixed(3)}, ${pos.coords.longitude.toFixed(3)}`,
                };
                save(KEYS.SETTINGS, S.settings);
                refreshAllTimes();
                render();
                if (S.settings.notifications) schedulePrayerNotifications();
                toast('Location saved');
            },
            () => toast('Location denied or unavailable')
        );
    }

    /* ── Notifications (prayer alerts) ─────────────────────────
     * Uses Web Notifications API. We schedule:
     *   - "15 minutes until <prayer>" reminder
     *   - "<prayer> time" alert at the adhan
     * Scheduler runs once at load and re-arms at midnight.
     * Only active when S.settings.notifications === true and permission granted.
     * ────────────────────────────────────────────────────────── */

    const _notifTimers = [];

    function clearScheduledNotifications() {
        while (_notifTimers.length) clearTimeout(_notifTimers.pop());
    }

    const isElectron = !!window.electronAPI?.showNotification;

    function updateNotifToggleBtn() {
        const btn = $('#toggle-notif');
        if (!btn) return;
        const on = !!S.settings.notifications;
        btn.setAttribute('aria-pressed', on);
        btn.title = on ? 'Prayer notifications are ON — click to mute all' : 'Prayer notifications are OFF — click to enable';
        btn.querySelector('svg').innerHTML = on
            ? '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.73 21a2 2 0 0 1-3.46 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
            : '<path d="M13.73 21a2 2 0 0 1-3.46 0M18.63 13A17.89 17.89 0 0 1 18 8M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.33-5M1 1l22 22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
    }

    async function togglePrayerNotifications() {
        if (!isElectron && !('Notification' in window)) {
            toast('Notifications not supported');
            return;
        }
        if (S.settings.notifications) {
            S.settings.notifications = false;
            save(KEYS.SETTINGS, S.settings);
            clearScheduledNotifications();
            toast('Prayer notifications off');
            updateNotifToggleBtn();
            return;
        }
        // Electron: no permission needed — native toasts always work
        if (!isElectron) {
            let perm = Notification.permission;
            if (perm === 'default') perm = await Notification.requestPermission();
            if (perm !== 'granted') {
                toast('Notifications permission denied');
                return;
            }
        }
        S.settings.notifications = true;
        save(KEYS.SETTINGS, S.settings);
        schedulePrayerNotifications();
        toast('Prayer notifications on');
        updateNotifToggleBtn();
    }

    function schedulePrayerNotifications() {
        clearScheduledNotifications();
        if (!S.settings.notifications) return;
        if (!isElectron && typeof Notification !== 'undefined' && Notification.permission !== 'granted') return;
        if (!S.settings.location) return;

        const times = getTodayPrayerTimes();
        if (!times) return;
        const now = Date.now();

        // Read sub-settings — each controls one kind of alert
        const preOn       = S.settings.notifPreEnabled       !== false;
        const preMin      = Math.max(1, parseInt(S.settings.notifPreMinutes, 10) || 15);
        const adhanOn     = S.settings.notifAdhanEnabled     !== false;
        const preIqamaOn  = S.settings.notifPreIqamaEnabled  === true;
        const preIqamaMin = Math.max(1, parseInt(S.settings.notifPreIqamaMinutes, 10) || 5);

        const perPrayer = S.settings.prayerNotifs || {};
        PRAYER_RING_IDS.forEach(id => {
            // Skip prayers muted via the per-prayer toggle in the schedule card
            if (perPrayer[id] === false) return;
            const at = times.today[id].getTime();
            const name = PRAYER_TIME_LABELS[id];

            // Pre-prayer reminder
            if (preOn) {
                const preAt = at - preMin * 60 * 1000;
                if (preAt > now) {
                    const t = setTimeout(() => {
                        showPrayerNotification(`${name} · ${preMin} min`, `Prepare for prayer`);
                    }, preAt - now);
                    _notifTimers.push(t);
                }
            }
            // Adhan alert
            if (adhanOn && at > now) {
                const t = setTimeout(() => {
                    showPrayerNotification(`${name} Adhan`, formatTime12(times.today[id]));
                }, at - now);
                _notifTimers.push(t);
            }
            // Pre-iqama alert (adhan + iqama-offset − preIqamaMin)
            if (preIqamaOn) {
                const iqamaOffset = getIqamaOffset(id);
                if (iqamaOffset > 0) {
                    const iqamaAt = at + iqamaOffset * 60 * 1000;
                    const preIqamaAt = iqamaAt - preIqamaMin * 60 * 1000;
                    if (preIqamaAt > now) {
                        const t = setTimeout(() => {
                            showPrayerNotification(`${name} Iqama · ${preIqamaMin} min`, formatTime12(new Date(iqamaAt)));
                        }, preIqamaAt - now);
                        _notifTimers.push(t);
                    }
                }
            }
        });

        // Re-schedule at local midnight for tomorrow's prayers
        const nextMidnight = new Date();
        nextMidnight.setHours(24, 0, 30, 0); // 30s safety margin
        const msToMidnight = nextMidnight.getTime() - now;
        const midnightTimer = setTimeout(() => schedulePrayerNotifications(), msToMidnight);
        _notifTimers.push(midnightTimer);
    }

    function showPrayerNotification(title, body) {
        // Electron: use native Windows toast (always works, no permission prompt)
        if (window.electronAPI?.showNotification) {
            window.electronAPI.showNotification(title, body);
            return;
        }
        // Browser fallback
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try { new Notification(title, { body, tag: 'nur-prayer' }); } catch (_) {}
        }
    }

    /* ── Auto-missed prayers ─────────────────────────────────── */
    /** Returns today's prayer times in "minutes since midnight" form for auto-missed logic. */
    function getPrayerMinutes() {
        const loc = S.settings.location;
        if (!loc) {
            // Fallback defaults if user hasn't set a location yet
            return { fajr: 315, dhuhr: 750, asr: 945, maghrib: 1100, isha: 1200 };
        }
        const times = computeRawTimesCached(loc.lat, loc.lng, new Date(), getTimesOptions());
        const out = {};
        PRAYER_RING_IDS.forEach(id => {
            out[id] = times[id].getHours() * 60 + times[id].getMinutes();
        });
        return out;
    }

    /**
     * Create a per-prayer auto-missed goal. Each missed prayer gets its own goal
     * so it shows up as a distinct line (e.g. "Missed Fajr · Apr 26").
     */
    function addAutoMissedGoal(prayerId, onDate, opts = {}) {
        const p = PRAYER_MAP[prayerId];
        if (!p) return;
        const isManual = !!opts.manual;
        const greg = new Date(onDate);
        const goals = getGoals();
        const nowIso = new Date().toISOString();

        // Dedup: one goal per (prayer, calendar day). If the existing one was
        // completed, reopen it instead of creating a second.
        const sameDayIso = greg.toDateString();
        const duplicate = goals.find(g =>
            g.type === 'qadaa-auto' &&
            g.missedPrayer === prayerId &&
            g.missedOn &&
            new Date(g.missedOn).toDateString() === sameDayIso
        );
        if (duplicate) {
            if (duplicate.remaining <= 0) {
                duplicate.remaining = 1;
                duplicate.total = Math.max(duplicate.total, 1);
                if (duplicate.perPrayer) duplicate.perPrayer[prayerId] = 1;
                duplicate.notes = duplicate.notes || [];
                duplicate.notes.push({ date: nowIso, text: 'Re-opened', amount: 1, prayer: prayerId });
                saveGoals();
            }
            return;
        }

        goals.push({
            type: 'qadaa-auto',
            name: `Missed ${p.name}`,
            total: 1,
            remaining: 1,
            perPrayer: { fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0, [prayerId]: 1 },
            missedPrayer: prayerId,
            missedOn: greg.toISOString(),
            isManual,
            notes: [{
                date: nowIso,
                text: isManual ? 'Added manually as missed' : 'Auto-flagged as missed',
                amount: 1,
                prayer: prayerId,
                auto: !isManual,
            }],
            createdAt: nowIso,
        });
        saveGoals();
    }

    function runAutoMissedCheck() {
        if (!getSetting('autoMarkMissed', true)) return;
        if (!S.settings.location) return;

        const installedAt = new Date(Storage.get(KEYS.INSTALLED_AT) || Date.now());
        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        // Only check today's day (auto-miss only happens forward, never backfill old days)
        const todayH = HijriCalendar.gregorianToHijri(now);
        const todayStartOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (todayStartOfDay < installedAt && todayStartOfDay.toDateString() !== installedAt.toDateString()) return;

        const key = hk(todayH.year, todayH.month, todayH.day);
        const d = dayData(key);
        let added = 0;
        let missedNames = [];
        const prayerMinsToday = getPrayerMinutes();

        // Miss is confirmed only when the NEXT prayer's adhan has passed —
        // i.e. user can no longer pray the current one in-window. This is the Islamic
        // definition of a missed prayer (prayed outside its window = qadaa).
        // For Isha, "next" is tomorrow's Fajr.
        const nextPrayerMin = {
            fajr: prayerMinsToday.dhuhr,
            dhuhr: prayerMinsToday.asr,
            asr: prayerMinsToday.maghrib,
            maghrib: prayerMinsToday.isha,
            // Isha window closes at tomorrow Fajr — but we only need to flag it
            // "after midnight" as a reasonable cutoff. Use 24*60 = next day's 00:00.
            isha: 24 * 60,
        };

        PRAYERS.forEach(p => {
            if (d[p.id]) return; // already marked done
            if (d[`${p.id}_auto_missed`]) return; // already auto-missed

            const cutoff = nextPrayerMin[p.id];
            if (nowMinutes >= cutoff) {
                d[`${p.id}_auto_missed`] = true;
                addAutoMissedGoal(p.id, now.toISOString());
                added++;
                missedNames.push(p.name);
            }
        });

        if (added > 0) {
            save(KEYS.PRAYERS, S.prayers);
            renderGoals();
            toast(`Missed: ${missedNames.join(', ')}`);
        }
    }

    /* ── Clock ───────────────────────────────────────────────── */
    function updateClock() {
        const now = new Date();
        const h = now.getHours(), m = now.getMinutes();
        const h12 = h % 12 || 12;
        const ampm = h >= 12 ? 'PM' : 'AM';

        const timeEl = $('#header-time');
        if (timeEl) timeEl.textContent = `${h12}:${String(m).padStart(2,'0')} ${ampm}`;

        const dateEl = $('#header-date-label');
        if (dateEl) {
            const hd = HijriCalendar.gregorianToHijri(now);
            const md = HijriCalendar.getMonthData(hd.year, hd.month);
            const gregStr = fmtShortDate(now);
            const hijriStr = `${md.monthName} ${hd.day}, ${hd.year}`;
            const primary = S.settings.primaryCalendar || 'hijri';
            // Stacked: primary on its own line (accent), secondary below (muted)
            const primaryStr = primary === 'gregorian' ? gregStr : hijriStr;
            const secondaryStr = primary === 'gregorian' ? hijriStr : gregStr;
            dateEl.innerHTML =
                `<div class="header-date-primary">${primaryStr}</div>` +
                `<div class="header-date-secondary">${secondaryStr}</div>`;
        }

        const nextEl = $('#next-prayer-text');
        if (nextEl) {
            // Only overwrite the float if tickTimes() isn't already driving it
            if ($('.page.active')?.dataset.page !== 'times') {
                const times = getTodayPrayerTimes();
                if (times) {
                    const schedule = buildPrayerSchedule(times);
                    const idx = findNextPrayerIdx(schedule, now);
                    if (idx >= 0) {
                        const next = schedule[idx];
                        nextEl.textContent = `${next.name} in ${formatDuration(next.at - now, { compact: true })}`;
                    } else {
                        nextEl.textContent = 'Next: —';
                    }
                } else {
                    nextEl.textContent = 'Set location for prayer times';
                }
            }
        }

        updateTray();
    }

    /* ── Electron tray integration ─────────────────────────────
     * Pushes prayer data to the main process every 30s (via updateClock)
     * so the tray tooltip + right-click menu stay current. */
    function updateTray() {
        if (!window.electronAPI?.updateTray) return;
        const times = getTodayPrayerTimes();
        if (!times) {
            window.electronAPI.updateTray({ noLocation: true });
            return;
        }
        const schedule = buildPrayerSchedule(times);
        const now = new Date();
        const nextIdx = findNextPrayerIdx(schedule, now);

        let nextPrayer = null, nextIn = null, currentPrayer = null;
        if (nextIdx >= 0) {
            const next = schedule[nextIdx];
            nextPrayer = next.name;
            nextIn = formatDuration(next.at - now, { compact: true });
        }

        let activePrayerId = null;
        for (let i = nextIdx - 1; i >= 0; i--) {
            if (schedule[i].id !== 'sunrise') {
                const id = schedule[i].id === 'fajr-next' ? 'fajr' : schedule[i].id;
                activePrayerId = id;
                break;
            }
        }
        if (!activePrayerId && times.rolled) activePrayerId = 'isha';

        const tk = dashboardKey();
        const dd = dayData(tk);
        const done = completed(dd);

        let currentPrayerDone = false;
        if (activePrayerId) {
            currentPrayer = PRAYER_TIME_LABELS[activePrayerId] || PRAYER_MAP[activePrayerId]?.name || null;
            currentPrayerDone = !!dd[activePrayerId];
        }

        // Full schedule with active marker
        const prayers = PRAYER_TIME_IDS
            .filter(id => id !== 'sunrise')
            .map(id => ({
                name: PRAYER_TIME_LABELS[id],
                time: formatTime12(times.today[id]),
                active: id === activePrayerId,
            }));

        window.electronAPI.updateTray({ nextPrayer, nextIn, currentPrayer, currentPrayerDone, done, prayers });
    }

    if (window.electronAPI?.onQuickLog) {
        window.electronAPI.onQuickLog((prayerName) => {
            const prayer = PRAYERS.find(p => p.name === prayerName);
            if (!prayer) return;
            const tk = dashboardKey();
            const dd = dayData(tk);
            if (dd[prayer.id]) return;
            dd[prayer.id] = true;
            save(KEYS.PRAYERS, S.prayers);
            render();
            toast(`${prayer.name} logged`);
            updateTray();
        });
    }

    // Navigate to a page from tray menu
    if (window.electronAPI?.onNavigate) {
        window.electronAPI.onNavigate((page) => {
            const tab = $(`.nav-tab[data-page="${page}"]`);
            if (tab) tab.click();
        });
    }

    /* ── Toasts ──────────────────────────────────────────────── */
    let toastTimer = null;
    function toast(message, action) {
        let el = $('#toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'toast';
            el.className = 'toast';
            document.body.appendChild(el);
        }
        el.innerHTML = `<span>${message}</span>${action ? `<button type="button" class="toast-action">${action.label}</button>` : ''}`;
        el.classList.add('active');
        if (action) {
            el.querySelector('.toast-action').addEventListener('click', () => {
                action.fn();
                el.classList.remove('active');
            });
        }
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('active'), 4000);
    }

    /* ── Modal System ────────────────────────────────────────── */
    function closeAllModals() {
        $$('.modal-backdrop').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-hidden', 'true');
        });
        clearModalHeaderActions();
    }

    /** Remove any injected header action buttons (e.g. the Delete icon on goal detail). */
    function clearModalHeaderActions() {
        $$('.modal-header-action').forEach(n => n.remove());
    }

    /** Resolve a backToDay target (string day key OR { label, onClick }) into { label, run }. */
    function resolveBackTarget(target) {
        if (!target) return null;
        if (typeof target === 'string') {
            return { label: 'Back to day', run: () => openDayModal(target) };
        }
        return {
            label: target.label || 'Back',
            run: target.onClick || (() => closeAllModals()),
        };
    }

    /* ── Context Menu ────────────────────────────────────────── */
    let ctxKey = null;
    function initContext() {
        document.addEventListener('contextmenu', e => {
            const cell = e.target.closest('.cal-cell');
            if (cell?.dataset.key) {
                e.preventDefault();
                ctxKey = cell.dataset.key;
                const menu = $('#context-menu');
                if (!menu) return;
                menu.style.left = e.pageX + 'px';
                menu.style.top = e.pageY + 'px';
                menu.classList.add('active');
            }
        });
        document.addEventListener('click', () => {
            $('#context-menu')?.classList.remove('active');
        });
        $('#ctx-mark-complete')?.addEventListener('click', () => {
            if (ctxKey) { markAllPrayers(ctxKey, true); }
        });
        $('#ctx-mark-incomplete')?.addEventListener('click', () => {
            if (ctxKey) {
                const d = dayData(ctxKey);
                PRAYERS.forEach(p => d[p.id] = false);
                save(KEYS.PRAYERS, S.prayers);
                render();
            }
        });
    }

    /* ── Event Listeners ─────────────────────────────────────── */
    function initEvents() {
        // Info-tip (?) click handler — shows a small popover bubble on click, hides on second click or outside
        document.addEventListener('click', (e) => {
            const tip = e.target.closest('.info-tip');
            // Close any open tip first
            const open = document.querySelector('.info-tip-pop.active');
            if (open) { open.remove(); }
            if (!tip) return;
            e.stopPropagation();
            const text = tip.dataset.hint;
            if (!text) return;
            const pop = document.createElement('div');
            pop.className = 'info-tip-pop active';
            pop.textContent = text;
            document.body.appendChild(pop);
            // Position: fixed, clamped to viewport
            const rect = tip.getBoundingClientRect();
            const popW = pop.offsetWidth;
            const popH = pop.offsetHeight;
            let left = rect.left + rect.width / 2 - popW / 2;
            left = Math.max(8, Math.min(left, window.innerWidth - popW - 8));
            let top = rect.bottom + 6;
            if (top + popH > window.innerHeight - 8) top = rect.top - popH - 6;
            pop.style.top = top + 'px';
            pop.style.left = left + 'px';
            setTimeout(() => {
                const close = () => { pop.remove(); document.removeEventListener('click', close); };
                document.addEventListener('click', close, { once: true });
            }, 10);
        });

        $('#settings-btn')?.addEventListener('click', () => openSettingsModal());
        $('#cal-prev')?.addEventListener('click', calPrev);

        // Page switching
        $$('.nav-tab[data-page]').forEach(tab => {
            tab.addEventListener('click', () => {
                const pageId = tab.dataset.page;
                $$('.nav-tab').forEach(t => {
                    t.classList.remove('active');
                    t.setAttribute('aria-pressed', 'false');
                });
                tab.classList.add('active');
                tab.setAttribute('aria-pressed', 'true');
                $$('.page').forEach(p => p.classList.remove('active'));
                const page = $(`.page[data-page="${pageId}"]`);
                if (page) page.classList.add('active');
                if (pageId === 'stats') renderStats();
                if (pageId === 'times') renderPrayerTimes();
                else stopTimesTicker();
            });
        });
        $('#cal-next')?.addEventListener('click', calNext);
        $('#cal-today')?.addEventListener('click', calToday);

        // Goals card
        $('#goals-add-btn')?.addEventListener('click', e => {
            e.stopPropagation();
            openAddGoalModal();
        });

        // Modal close
        $$('.close-btn').forEach(b => b.addEventListener('click', e => {
            e.stopPropagation();
            closeAllModals();
        }));
        $$('.modal-backdrop').forEach(b => b.addEventListener('mousedown', e => {
            if (e.target === b || !e.target.closest('.modal')) closeAllModals();
        }));

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closeAllModals();
        });
    }

    /* ── Init ────────────────────────────────────────────────── */
    function init() {
        // Electron: mark body so CSS can show the custom title bar
        if (window.electronAPI) {
            document.body.classList.add('electron');
            $('#tb-min')?.addEventListener('click', () => window.electronAPI.winMinimize());
            $('#tb-max')?.addEventListener('click', () => window.electronAPI.winMaximize());
            $('#tb-close')?.addEventListener('click', () => window.electronAPI.winClose());
        }

        if (S.theme !== 'default') document.body.setAttribute('data-theme', S.theme);
        // Migrate old qadaa data to goals
        if (S.qadaa.remaining || S.qadaa.counter) {
            const rem = S.qadaa.remaining || S.qadaa.counter || 0;
            const tot = S.qadaa.startTotal || S.qadaa.startCount || rem;
            const goals = getGoals();
            if (!goals.find(g => g.type === 'qadaa') && rem > 0) {
                goals.push({ type: 'qadaa', name: 'Qadaa Prayers', total: tot, remaining: rem });
                saveGoals();
            }
            Storage.remove(KEYS.QADAA);
        }
        // Migrate legacy fasting-data → prayer-data.fasting per day
        const legacyFasting = Storage.get(KEYS.LEGACY_FASTING, {});
        Object.keys(legacyFasting).forEach(k => {
            if (legacyFasting[k] && k.endsWith('-fasting')) {
                dayData(k.replace('-fasting', '')).fasting = true;
            }
        });
        if (Object.keys(legacyFasting).length > 0) {
            Storage.remove(KEYS.LEGACY_FASTING);
            save(KEYS.PRAYERS, S.prayers);
        }

        initEvents();
        initContext();
        render();
        updateClock();
        runAutoMissedCheck();
        setInterval(updateClock, 30000);
        setInterval(runAutoMissedCheck, 5 * 60 * 1000); // every 5 min

        if (S.settings.notifications) schedulePrayerNotifications();

        setTimeout(checkForUpdatesSilent, 5000);
    }

    // Re-render data tab when OAuth callback completes (from Electron deep link)
    window.addEventListener('sync-auth-changed', () => {
        const tabContent = $('#settings-tab-content');
        if (tabContent) {
            tabContent.innerHTML = renderSettingsTab('data');
            wireSettingsTab('data');
        }
        toast('Signed in with Google');
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
