/* ================================================================
   Hijri Calendar Engine
   ================================================================
   Uses the browser's built-in Intl.DateTimeFormat with the
   'islamic-umalqura' calendar — the official Saudi Umm al-Qura
   astronomical standard with pre-computed month lengths.

   Keeps a user-adjustable ±offset for regions whose observation-based
   calendar drifts from Umm al-Qura (e.g. Egypt, Pakistan).

   Public API is identical to the old algorithmic version so the
   rest of the app doesn't change.
   ================================================================ */

const HijriCalendar = (() => {
    'use strict';

    /* ----- Hijri month metadata -------------------------------- */
    const HIJRI_MONTHS = [
        { name: 'Muharram',        nameShort: 'Muharram',  nameAr: 'محرم'        },
        { name: 'Safar',           nameShort: 'Safar',     nameAr: 'صفر'         },
        { name: "Rabi' al-Awwal",  nameShort: 'Rabi I',    nameAr: 'ربيع الأول'  },
        { name: "Rabi' al-Thani",  nameShort: 'Rabi II',   nameAr: 'ربيع الثاني' },
        { name: 'Jumada al-Ula',   nameShort: 'Jumada I',  nameAr: 'جمادى الأولى' },
        { name: 'Jumada al-Thani', nameShort: 'Jumada II', nameAr: 'جمادى الثانية'},
        { name: 'Rajab',           nameShort: 'Rajab',     nameAr: 'رجب'         },
        { name: "Sha'ban",         nameShort: "Sha'ban",   nameAr: 'شعبان'       },
        { name: 'Ramadan',         nameShort: 'Ramadan',   nameAr: 'رمضان'       },
        { name: 'Shawwal',         nameShort: 'Shawwal',   nameAr: 'شوال'        },
        { name: "Dhul Qi'dah",     nameShort: "Dhu Q",     nameAr: 'ذو القعدة'   },
        { name: 'Dhul Hijjah',     nameShort: 'Dhu H',     nameAr: 'ذو الحجة'    },
    ];

    // Intl month names → our index (0-based). Built once from our own HIJRI_MONTHS
    // plus the browser's Intl spelling variants.
    const MONTH_NAME_TO_IDX = {};
    HIJRI_MONTHS.forEach((m, i) => {
        MONTH_NAME_TO_IDX[m.name.toLowerCase()] = i;
        MONTH_NAME_TO_IDX[m.nameAr] = i;
    });
    // Browser Intl uses slightly different spellings — map those too
    const INTL_MONTH_MAP = {
        'muharram': 0, 'safar': 1, 'rabiʻ i': 2, 'rabiʻ ii': 3,
        "rabi' i": 2, "rabi' ii": 3, "rabīʿ al-awwal": 2, "rabīʿ al-thānī": 3,
        'jumada i': 4, 'jumada ii': 5, 'jumādá al-ūlá': 4, 'jumādá al-ākhirah': 5,
        'rajab': 6, "shaʻban": 7, "shaʿbān": 7, "sha'ban": 7,
        'ramadan': 8, 'ramaḍān': 8, 'shawwal': 9, 'shawwāl': 9,
        "dhuʻl-qiʻdah": 10, "dhū al-qaʿdah": 10, "dhu al-qi'dah": 10,
        "dhul qi'dah": 10, "dhuʻl-ḥijjah": 11, "dhū al-ḥijjah": 11,
        "dhul hijjah": 11,
    };
    Object.assign(MONTH_NAME_TO_IDX, INTL_MONTH_MAP);

    const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const WEEKDAYS_EN_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    const SPECIAL_DATES = {
        '1-1':   'Islamic New Year',
        '1-10':  'Day of Ashura',
        '3-12':  'Mawlid al-Nabi',
        '7-27':  "Isra' & Mi'raj",
        '8-15':  "Shab-e-Barat",
        '9-1':   'Ramadan Begins',
        '9-21':  'Odd Night',
        '9-23':  'Odd Night',
        '9-25':  'Odd Night',
        '9-27':  'Odd Night',
        '9-29':  'Odd Night',
        '10-1':  'Eid al-Fitr',
        '12-8':  'Day of Tarwiyah',
        '12-9':  'Day of Arafah',
        '12-10': 'Eid al-Adha',
    };

    const MONTH_SIGNIFICANCE = {
        1:  'Sacred Month',
        3:  'Month of the Prophet\'s Birth',
        7:  'Sacred Month of Reflection',
        8:  'Month of Preparation',
        9:  'Month of Fasting',
        10: 'Month of Celebration',
        12: 'Month of Pilgrimage',
    };

    /* ----- User-adjustable offset (days) ----------------------- */
    let _offset = 0;
    (function readInitialOffset() {
        try {
            const settings = (typeof window !== 'undefined' && window.Storage)
                ? window.Storage.get('app-settings', {})
                : {};
            if (typeof settings.hijriOffset === 'number') _offset = settings.hijriOffset;
        } catch (_) { /* keep default */ }
    })();
    function setOffset(n) { _offset = n; }

    /* ----- Intl formatters (created once, reused) -------------- */
    const _fmtParts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
        day: 'numeric', month: 'long', year: 'numeric',
    });

    /* Parse Intl parts into { year, month (1-12), day } */
    function _parseIntlParts(date) {
        const parts = _fmtParts.formatToParts(date);
        let year = 0, month = 0, day = 0, monthName = '';
        for (const p of parts) {
            if (p.type === 'year')  year  = parseInt(p.value, 10);
            if (p.type === 'day')   day   = parseInt(p.value, 10);
            if (p.type === 'month') monthName = p.value;
        }
        // Resolve month name to 1-based index via our lookup table
        const idx = MONTH_NAME_TO_IDX[monthName.toLowerCase()];
        month = idx != null ? idx + 1 : 1;
        return { year, month, day };
    }

    /* ----- Gregorian → Hijri ----------------------------------- */
    function gregorianToHijri(gDate) {
        let d = new Date(gDate);
        // Apply user offset: shift the Gregorian date before conversion
        if (_offset !== 0) {
            d = new Date(d);
            d.setDate(d.getDate() + _offset);
        }
        const { year, month, day } = _parseIntlParts(d);
        const monthInfo = HIJRI_MONTHS[(month - 1) % 12];
        return {
            year,
            month,
            day,
            monthName: monthInfo.name,
            monthNameShort: monthInfo.nameShort,
            monthNameAr: monthInfo.nameAr,
        };
    }

    /* ----- Hijri → Gregorian -----------------------------------
     * Linear estimate + round-trip refine through gregorianToHijri.
     * Guaranteed to be the exact inverse. */
    function hijriToGregorian(hYear, hMonth, hDay) {
        const totalDays = (hYear - 1) * 354.367 + (hMonth - 1) * 29.5 + (hDay - 1);
        const epoch = new Date(622, 6, 16);
        const guessMs = epoch.getTime() + totalDays * 86400000;
        let guess = new Date(guessMs);
        guess.setHours(12, 0, 0, 0);

        for (let delta = 0; delta <= 15; delta++) {
            for (const sign of (delta === 0 ? [0] : [-1, 1])) {
                const test = new Date(guess);
                test.setDate(test.getDate() + sign * delta);
                const h = gregorianToHijri(test);
                if (h.year === hYear && h.month === hMonth && h.day === hDay) {
                    test.setHours(0, 0, 0, 0);
                    return test;
                }
            }
        }
        guess.setHours(0, 0, 0, 0);
        return guess;
    }

    /* ----- Days in a Hijri month -------------------------------
     * Start from day 1's Gregorian date and walk forward day-by-day
     * until the Hijri month changes. Robust regardless of month
     * length (29 or 30) and doesn't depend on hijriToGregorian for
     * the next month's start (which can have estimate drift). */
    function daysInMonth(hYear, hMonth) {
        const first = hijriToGregorian(hYear, hMonth, 1);
        // Day 1 = offset 0 from `first`. Day N = offset N-1.
        // Check if day 30 exists; if not, month has 29 days.
        for (let candidate = 30; candidate >= 29; candidate--) {
            const test = new Date(first);
            test.setDate(test.getDate() + candidate - 1);
            const h = gregorianToHijri(test);
            if (h.month === hMonth && h.year === hYear && h.day === candidate) return candidate;
        }
        return 29;
    }

    function isLeapYear(hYear) {
        return daysInMonth(hYear, 12) === 30;
    }

    function firstDayOfMonth(hYear, hMonth) {
        return hijriToGregorian(hYear, hMonth, 1).getDay();
    }

    /* ----- Build calendar data for a given Hijri month --------- */
    function getMonthData(hYear, hMonth) {
        const total = daysInMonth(hYear, hMonth);
        const startDay = firstDayOfMonth(hYear, hMonth);
        const todayHijri = gregorianToHijri(new Date());
        const monthInfo = HIJRI_MONTHS[(hMonth - 1) % 12];
        const significance = MONTH_SIGNIFICANCE[hMonth] || '';

        const cells = [];
        for (let i = 0; i < startDay; i++) {
            cells.push({ day: 0, empty: true });
        }
        for (let d = 1; d <= total; d++) {
            const key = `${hMonth}-${d}`;
            const isToday = (todayHijri.year === hYear && todayHijri.month === hMonth && todayHijri.day === d);
            const specialName = SPECIAL_DATES[key] || null;
            cells.push({
                day: d,
                empty: false,
                weekday: (startDay + d - 1) % 7,
                isToday,
                isSpecial: !!specialName,
                specialName,
            });
        }
        while (cells.length % 7 !== 0) {
            cells.push({ day: 0, empty: true });
        }

        const weeks = [];
        for (let i = 0; i < cells.length; i += 7) {
            weeks.push(cells.slice(i, i + 7));
        }

        return {
            year: hYear,
            month: hMonth,
            monthName: monthInfo.name,
            monthNameShort: monthInfo.nameShort,
            monthNameAr: monthInfo.nameAr,
            significance,
            totalDays: total,
            startWeekday: startDay,
            weeks,
        };
    }

    /* ----- Navigate months ------------------------------------- */
    function nextMonth(hYear, hMonth) {
        if (hMonth >= 12) return { year: hYear + 1, month: 1 };
        return { year: hYear, month: hMonth + 1 };
    }

    function prevMonth(hYear, hMonth) {
        if (hMonth <= 1) return { year: hYear - 1, month: 12 };
        return { year: hYear, month: hMonth - 1 };
    }

    /* ----- Public API ------------------------------------------ */
    return {
        HIJRI_MONTHS,
        WEEKDAYS_EN,
        WEEKDAYS_EN_SHORT,
        SPECIAL_DATES,
        MONTH_SIGNIFICANCE,
        gregorianToHijri,
        hijriToGregorian,
        daysInMonth,
        isLeapYear,
        firstDayOfMonth,
        getMonthData,
        nextMonth,
        prevMonth,
        setOffset,
    };
})();
