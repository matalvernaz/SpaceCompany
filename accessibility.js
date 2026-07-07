// Accessibility layer for Space Company (fork addition; not in upstream).
//
// Interaction model: on-demand, silent by default. A screen-reader user pulls
// game state with hotkeys whenever they want; nothing is announced automatically
// except discrete events (resource unlocks, toasts, new-content markers), which
// are routed through a throttled polite live region so a burst can never
// firehose the reader. Hotkeys are Ctrl+Alt chords (NVDA browse mode consumes
// bare letters as quick-nav; bare letters still work in focus mode) plus a
// visually-hidden button toolbar. An optional periodic status announcement is
// toggled with Ctrl+Alt+A and persisted across sessions.
//
// This is deliberate: the main game loop repaints resource counts ~60x/second, so
// a naive aria-live on those nodes would make a screen reader unusable. Instead we
// read the model directly on demand via getResource/getProduction/getStorage.
//
// Everything a11y lives in this one file plus small static index.html fixes
// (real <button> gather controls, img alt attributes, lang). Game logic is
// untouched: upstream functions (Game.resources.unlock, PNotify, newUnlock,
// newNavUnlock) are wrapped at runtime rather than edited in place.
Game.a11y = (function () {

    var instance = {};

    // Floor between spoken milestone bursts. Multiple events inside this window
    // are coalesced into a single utterance.
    var MILESTONE_MIN_INTERVAL_MS = 1200;

    // Drop milestone announcements fired during initial game boot so the player
    // isn't greeted by a wall of "X unlocked" from save-load / starting state.
    var SUPPRESS_ON_LOAD_MS = 2500;

    // Cadence of the optional periodic status line (A key toggles).
    var PERIODIC_INTERVAL_MS = 15000;

    // Iteration ceiling for Buy Max — a safety net, not a gameplay limit.
    var BUY_MAX_CAP = 5000;

    var PERIODIC_STORAGE_KEY = 'spacecompany.a11y.periodicAnnounce';

    // Energy-type resources are not part of the global `resources` array, so they
    // are prepended to keep the summary in the game's own left-nav order.
    var ENERGY_RESOURCES = ['energy', 'plasma', 'uranium', 'lava'];

    var politeRegion = null;   // event announcements (throttled, coalesced)
    var statusRegion = null;   // on-demand query output (summary, help, buys)

    var milestoneQueue = [];
    var lastMilestoneAt = 0;
    var flushScheduled = false;
    var suppressUntil = 0;

    var periodicTimer = null;

    // Machines discovered while injecting bulk-buy buttons:
    // [{fnName, counterName, label}] — also drives the B (buildings) hotkey.
    var machineRegistry = [];

    // ---------------------------------------------------------------------------
    // live regions
    // ---------------------------------------------------------------------------

    // Visually-hidden style (clip pattern): removed from layout and paint but
    // still exposed to assistive tech, and focusable where relevant.
    var VISUALLY_HIDDEN_CSS = 'position:absolute;width:1px;height:1px;margin:-1px;' +
        'padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);' +
        'clip-path:inset(50%);white-space:nowrap;';

    // Build an off-screen live region. The status region is assertive: it only
    // ever carries the answer to something the user just asked for, and that
    // must interrupt whatever the screen reader was saying. Event announcements
    // stay polite.
    function createLiveRegion(id, politeness) {
        var el = document.createElement('div');
        el.id = id;
        el.setAttribute('aria-live', politeness);
        el.setAttribute('aria-atomic', 'true');
        el.style.cssText = VISUALLY_HIDDEN_CSS;
        document.body.appendChild(el);
        return el;
    }

    // Announce text through a region. Never clear-then-fill: an empty atomic
    // update can be spoken as "blank" or cut speech, and stacked timers race.
    // A zero-width space forces re-announcement when the text is unchanged.
    function speak(region, text) {
        if (!region || !text) {
            return;
        }
        if (region.textContent === text) {
            text += '\u200B';
        }
        region.textContent = text;
    }

    // ---------------------------------------------------------------------------
    // event announcer (throttled + coalesced)
    // ---------------------------------------------------------------------------

    function doFlush() {
        flushScheduled = false;
        if (!milestoneQueue.length || !politeRegion) {
            return;
        }
        var text = milestoneQueue.join('. ');
        milestoneQueue = [];
        lastMilestoneAt = Date.now();
        speak(politeRegion, text);
    }

    function scheduleFlush() {
        if (flushScheduled) {
            return;
        }
        var wait = Math.max(0, MILESTONE_MIN_INTERVAL_MS - (Date.now() - lastMilestoneAt));
        flushScheduled = true;
        window.setTimeout(doFlush, wait);
    }

    // Queue a discrete event for polite announcement. Bursts within
    // MILESTONE_MIN_INTERVAL_MS are merged into one utterance; exact repeats
    // already waiting in the queue are dropped.
    instance.announce = function (message) {
        if (!message || Date.now() < suppressUntil) {
            return;
        }
        message = String(message);
        if (milestoneQueue.indexOf(message) !== -1) {
            return;
        }
        milestoneQueue.push(message);
        scheduleFlush();
    };

    // ---------------------------------------------------------------------------
    // on-demand readers
    // ---------------------------------------------------------------------------

    function summaryResourceIds() {
        return ENERGY_RESOURCES.concat(typeof resources !== 'undefined' ? resources : []);
    }

    // A resource is worth reading if the player has discovered it, holds any, or
    // is producing/consuming it. Guards against reading locked, far-future tiers.
    function isRelevant(id) {
        var data = Game.resources.getResourceData(id);
        if (!data) {
            return false;
        }
        return data.unlocked === true || getResource(id) > 0 || getProduction(id) !== 0;
    }

    function describeResource(id) {
        var data = Game.resources.getResourceData(id);
        var name = (data && data.name) ? data.name : id;

        var current = Game.settings.format(getResource(id));

        var prod = getProduction(id);
        var sign = prod > 0 ? '+' : '';   // negative values already carry '-'
        var prodStr = sign + Game.settings.format(prod) + '/s';

        var storage = getStorage(id);
        // -1 signals uncapped storage (e.g. science, rocket fuel).
        var storageStr = (storage >= 0) ? (', max ' + Game.settings.format(storage)) : '';

        return name + ' ' + current + ' (' + prodStr + storageStr + ')';
    }

    // Speak every relevant resource: amount, rate, and cap. This is the primary
    // way a screen-reader user reads their economy.
    instance.speakResourceSummary = function () {
        var ids = summaryResourceIds();
        var parts = [];
        for (var i = 0; i < ids.length; i++) {
            if (isRelevant(ids[i])) {
                parts.push(describeResource(ids[i]));
            }
        }
        speak(statusRegion, parts.length ? parts.join('. ') : 'No resources unlocked yet.');
    };

    // Compact energy report: the number every decision in this game hangs on.
    instance.speakEnergyStatus = function () {
        var current = getResource(RESOURCE.Energy);
        var cap = getStorage(RESOURCE.Energy);
        var net = getProduction(RESOURCE.Energy);
        var sign = net > 0 ? '+' : '';
        var text = 'Energy ' + Game.settings.format(current) +
            ' of ' + Game.settings.format(cap) +
            ', net ' + sign + Game.settings.format(net) + ' per second';
        if (Game.resources.getResourceData(RESOURCE.Plasma) &&
            Game.resources.getResourceData(RESOURCE.Plasma).unlocked) {
            text += '. Plasma ' + Game.settings.format(getResource(RESOURCE.Plasma)) +
                ' of ' + Game.settings.format(getStorage(RESOURCE.Plasma));
        }
        speak(statusRegion, text);
    };

    // Owned machines, from the registry built during bulk-buy injection.
    instance.speakBuildings = function () {
        var parts = [];
        for (var i = 0; i < machineRegistry.length; i++) {
            var m = machineRegistry[i];
            var owned = window[m.counterName];
            if (typeof owned === 'number' && owned > 0) {
                parts.push(m.label + ': ' + Game.settings.format(owned));
            }
        }
        speak(statusRegion, parts.length ? ('Machines owned. ' + parts.join('. ')) : 'No machines owned yet.');
    };

    // Read every visible progress bar (rocket launch, wonders...).
    instance.speakProgress = function () {
        var bars = document.querySelectorAll('.progress-bar');
        var parts = [];
        for (var i = 0; i < bars.length; i++) {
            var bar = bars[i];
            if (bar.offsetParent === null) {
                continue;   // hidden
            }
            var pct = (bar.style.width || '').trim() || (bar.textContent || '').trim();
            if (!pct) {
                continue;
            }
            var label = '';
            var row = bar.closest('tr, .panel, .tab-pane');
            if (row) {
                var heading = row.querySelector('h1,h2,h3,h4');
                if (heading) {
                    label = heading.textContent.replace(/\s+/g, ' ').trim();
                }
            }
            parts.push((label ? label + ' ' : 'Progress ') + pct);
        }
        speak(statusRegion, parts.length ? parts.join('. ') : 'No progress bars active.');
    };

    instance.speakHelp = function () {
        speak(statusRegion,
            'Accessibility keys, all pressed with Control plus Alt. ' +
            'S: read all resources with rates and caps. ' +
            'E: energy status. ' +
            'B: machines owned. ' +
            'P: active progress bars. ' +
            'A: toggle periodic status announcements. ' +
            'H: this help. ' +
            'The same letters work alone in screen reader focus mode, and a ' +
            'Game status button group at the top of the page offers every ' +
            'command as a button. ' +
            'Side navigation rows are focusable; Enter activates them. ' +
            'Buy buttons have Buy 10 and Buy Max companions.');
    };

    // ---------------------------------------------------------------------------
    // periodic status (opt-in, persisted)
    // ---------------------------------------------------------------------------

    function periodicEnabled() {
        try {
            return window.localStorage.getItem(PERIODIC_STORAGE_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function setPeriodicEnabled(on) {
        try {
            window.localStorage.setItem(PERIODIC_STORAGE_KEY, on ? '1' : '0');
        } catch (e) { /* private mode: toggle still works for this session */ }
        if (on) {
            startPeriodic();
        } else {
            stopPeriodic();
        }
    }

    function periodicTick() {
        var net = getProduction(RESOURCE.Energy);
        var sign = net > 0 ? '+' : '';
        var text = 'Energy ' + Game.settings.format(getResource(RESOURCE.Energy)) +
            ', net ' + sign + Game.settings.format(net) + ' per second';

        // Flag anything sitting at cap — production is being wasted.
        var capped = [];
        var ids = summaryResourceIds();
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            if (!isRelevant(id)) {
                continue;
            }
            var storage = getStorage(id);
            if (storage >= 0 && getResource(id) >= storage && getProduction(id) > 0) {
                var data = Game.resources.getResourceData(id);
                capped.push((data && data.name) ? data.name : id);
            }
        }
        if (capped.length) {
            text += '. At capacity: ' + capped.join(', ');
        }
        // Through the queue, not straight to the region: a tick landing next to
        // an unlock/toast burst coalesces instead of clobbering it.
        instance.announce(text);
    }

    function startPeriodic() {
        if (!periodicTimer) {
            periodicTimer = window.setInterval(periodicTick, PERIODIC_INTERVAL_MS);
        }
    }

    function stopPeriodic() {
        if (periodicTimer) {
            window.clearInterval(periodicTimer);
            periodicTimer = null;
        }
    }

    instance.togglePeriodic = function () {
        var next = !periodicEnabled();
        setPeriodicEnabled(next);
        speak(statusRegion, 'Periodic announcements ' + (next ? 'on, every ' +
            Math.round(PERIODIC_INTERVAL_MS / 1000) + ' seconds' : 'off'));
    };

    // ---------------------------------------------------------------------------
    // hotkeys
    // ---------------------------------------------------------------------------

    function isTypingTarget(target) {
        if (!target) {
            return false;
        }
        var tag = target.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    }

    function runHotkey(key) {
        switch (key) {
            case 's': instance.speakResourceSummary(); return true;
            case 'e': instance.speakEnergyStatus(); return true;
            case 'b': instance.speakBuildings(); return true;
            case 'p': instance.speakProgress(); return true;
            case 'a': instance.togglePeriodic(); return true;
            case 'h': case '?': instance.speakHelp(); return true;
        }
        return false;
    }

    function onKeyDown(e) {
        var key = e.key || '';

        // Ctrl+Alt chords are the primary hotkeys: NVDA browse mode consumes
        // bare letters as quick-navigation before the page ever sees them, but
        // passes modified chords through. (Ctrl+Alt is free of browser
        // accelerators on a US layout, unlike plain Alt or Ctrl.)
        if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey) {
            if (runHotkey(key.toLowerCase())) {
                e.preventDefault();
            }
            return;
        }

        // Leave other browser/OS shortcuts and text entry alone.
        if (e.ctrlKey || e.altKey || e.metaKey || isTypingTarget(e.target)) {
            return;
        }

        // Keyboard activation for upgraded non-native controls (nav rows).
        if ((key === 'Enter' || key === ' ') && e.target && e.target.hasAttribute &&
                e.target.hasAttribute('data-a11y-key')) {
            e.target.click();
            e.preventDefault();
            return;
        }

        // Bare letters still work in screen-reader focus mode and for
        // sighted keyboard users.
        if (runHotkey(key.toLowerCase())) {
            e.preventDefault();
        }
    }

    // ---------------------------------------------------------------------------
    // status toolbar (browse-mode fallback for the hotkeys)
    // ---------------------------------------------------------------------------

    // Real buttons, visually hidden, first in the tab/browse order: reachable in
    // NVDA browse mode where bare-letter hotkeys are not, and self-documenting.
    function buildToolbar() {
        var bar = document.createElement('div');
        bar.id = 'a11yToolbar';
        bar.setAttribute('role', 'group');
        bar.setAttribute('aria-label', 'Game status');
        bar.style.cssText = VISUALLY_HIDDEN_CSS;

        var entries = [
            ['Read all resources', 'Control+Alt+S', instance.speakResourceSummary],
            ['Energy status', 'Control+Alt+E', instance.speakEnergyStatus],
            ['Machines owned', 'Control+Alt+B', instance.speakBuildings],
            ['Progress bars', 'Control+Alt+P', instance.speakProgress],
            ['Toggle periodic announcements', 'Control+Alt+A', instance.togglePeriodic],
            ['Accessibility help', 'Control+Alt+H', instance.speakHelp]
        ];
        for (var i = 0; i < entries.length; i++) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = entries[i][0];
            btn.setAttribute('aria-keyshortcuts', entries[i][1]);
            btn.addEventListener('click', entries[i][2]);
            bar.appendChild(btn);
        }
        document.body.insertBefore(bar, document.body.firstChild);
    }

    // ---------------------------------------------------------------------------
    // non-native control upgrade (side navigation rows)
    // ---------------------------------------------------------------------------

    // The left-side navigation is clickable <tr> elements: <tr> is unfocusable,
    // making all sub-navigation mouse-only. Focus + Enter/Space restores
    // keyboard access. Upstream also stamped role="tab" on the rows with no
    // tablist anywhere — an orphaned tab role that breaks NVDA table navigation
    // and can never announce selection — so the role comes off and each row gets
    // a static accessible name from its label cell instead. Selection state is
    // conveyed via aria-current (see patchActiveTabs).
    function rowLabel(el) {
        var cell = el.cells && el.cells[1];
        var text = (cell ? cell.textContent : el.textContent) || '';
        text = text.replace(/\s+/g, ' ').trim();
        return text.length > 40 ? text.slice(0, 40) : text;
    }

    function upgradeClickableRows() {
        var rows = document.querySelectorAll('tr[onclick], div[onclick]');
        var upgraded = 0;
        for (var i = 0; i < rows.length; i++) {
            var el = rows[i];
            if (el.tagName === 'DIV' && el.closest('button')) {
                continue;
            }
            if (!el.hasAttribute('tabindex')) {
                el.setAttribute('tabindex', '0');
            }
            if (el.getAttribute('role') === 'tab') {
                el.removeAttribute('role');
            }
            if (el.tagName === 'TR' && !el.hasAttribute('aria-label')) {
                var label = rowLabel(el);
                if (label) {
                    el.setAttribute('aria-label', label);
                }
            }
            el.setAttribute('data-a11y-key', '1');
            upgraded++;
        }
        return upgraded;
    }

    // Wrap the game's tab-switching globals so the active nav row carries
    // aria-current, giving audible confirmation of where activation landed.
    function markCurrentRow(id) {
        var el = document.getElementById(id);
        if (!el) {
            return;
        }
        var table = el.closest('table');
        if (table) {
            var prev = table.querySelectorAll('tr[aria-current]');
            for (var i = 0; i < prev.length; i++) {
                prev[i].removeAttribute('aria-current');
            }
        }
        el.setAttribute('aria-current', 'true');
    }

    function patchActiveTabs() {
        var names = ['activeResourceTab', 'activeResearchTab', 'activeSolarTab',
                     'activeWonderTab', 'activeSolCenterTab', 'activeInterstellarTab'];
        for (var i = 0; i < names.length; i++) {
            (function (name) {
                var original = window[name];
                if (typeof original !== 'function') {
                    return;
                }
                window[name] = function (tab) {
                    original.apply(this, arguments);
                    markCurrentRow(tab);
                };
            }(names[i]));
        }
    }

    // ---------------------------------------------------------------------------
    // decorative image silencing
    // ---------------------------------------------------------------------------

    // Static index.html images carry alt attributes, but achievement and tab UIs
    // render icons at runtime via Handlebars with none — a screen reader would
    // announce raw filenames. Every game image is an icon beside its own text
    // label, so the decorative default (alt="") is always correct here.
    function silenceUnlabeledImages(root) {
        var imgs = (root || document).querySelectorAll('img:not([alt])');
        for (var i = 0; i < imgs.length; i++) {
            imgs[i].setAttribute('alt', '');
        }
    }

    function watchForUnlabeledImages() {
        var observer = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var node = added[j];
                    if (node.nodeType !== 1) {
                        continue;
                    }
                    if (node.tagName === 'IMG' && !node.hasAttribute('alt')) {
                        node.setAttribute('alt', '');
                    } else if (node.querySelectorAll) {
                        silenceUnlabeledImages(node);
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ---------------------------------------------------------------------------
    // bulk buy (Buy 10 / Buy Max)
    // ---------------------------------------------------------------------------

    // Machine purchases are legacy per-building globals: getSolarPanel() checks
    // cost globals, spends, increments the owned counter, then updateCost()
    // re-derives prices (base * 1.1^owned). Bulk buying loops the game's own
    // function and stops when the counter stops moving — the exact cost curve,
    // tier discounts included, with zero duplicated math.
    var BUY_FN_PATTERN = /^get([A-Z]\w*)\(\)$/;

    function counterNameFor(fnName) {
        var stem = fnName.slice(3);
        return stem.charAt(0).toLowerCase() + stem.slice(1);
    }

    // Name the binding shortage so a failed buy is actionable, not a dead end.
    function shortfallText(costs) {
        var worst = null, worstRatio = Infinity;
        for (var res in costs) {
            var need = window[costs[res]];
            var have = getResource(res);
            if (typeof need !== 'number' || have >= need) {
                continue;
            }
            var ratio = have / Math.max(1, need);
            if (ratio < worstRatio) {
                worstRatio = ratio;
                worst = 'Need ' + Game.settings.format(need) + ' ' + res +
                    ', have ' + Game.settings.format(have);
            }
        }
        return worst;
    }

    function bulkBuy(entry, want) {
        var fn = window[entry.fnName];
        if (typeof fn !== 'function') {
            return;
        }
        var bought = 0;
        var cap = Math.min(want, BUY_MAX_CAP);
        while (bought < cap) {
            var before = window[entry.counterName];
            fn();
            if (window[entry.counterName] === before) {
                break;   // could not afford the next one
            }
            bought++;
        }
        if (bought > 0) {
            speak(statusRegion, 'Bought ' + bought + ' ' + entry.label +
                ', now ' + Game.settings.format(window[entry.counterName]) + ' owned');
        } else {
            var why = shortfallText(entry.costs);
            speak(statusRegion, 'Cannot afford ' + entry.label + (why ? '. ' + why : ''));
        }
    }

    function makeBulkButton(visible, ariaLabel, onActivate) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-default';
        btn.textContent = visible;
        btn.setAttribute('aria-label', ariaLabel);
        btn.addEventListener('click', onActivate);
        return btn;
    }

    function injectBulkBuyButtons() {
        var buttons = document.querySelectorAll('button[onclick]');
        for (var i = 0; i < buttons.length; i++) {
            var buyBtn = buttons[i];
            var m = BUY_FN_PATTERN.exec(buyBtn.getAttribute('onclick').trim());
            if (!m) {
                continue;
            }
            var fnName = 'get' + m[1];
            var counterName = counterNameFor(fnName);
            if (typeof window[counterName] !== 'number' || typeof window[fnName] !== 'function') {
                continue;
            }

            var label = (buyBtn.textContent || '').replace(/^(Get|Build)\s+/i, '')
                .replace(/\s+/g, ' ').trim() || counterName;

            // Cost globals follow <counter><Resource>Cost; collected for the
            // shortfall message on a failed buy.
            var costs = {};
            for (var key in RESOURCE) {
                var costGlobal = counterName +
                    RESOURCE[key].charAt(0).toUpperCase() + RESOURCE[key].slice(1) + 'Cost';
                if (typeof window[costGlobal] === 'number') {
                    costs[RESOURCE[key]] = costGlobal;
                }
            }

            var entry = { fnName: fnName, counterName: counterName, label: label, costs: costs };
            machineRegistry.push(entry);

            var buy10 = makeBulkButton('×10', 'Buy 10 ' + label, (function (en) {
                return function () { bulkBuy(en, 10); };
            }(entry)));

            var buyMax = makeBulkButton('Max', 'Buy max ' + label, (function (en) {
                return function () { bulkBuy(en, Infinity); };
            }(entry)));

            buyBtn.insertAdjacentText('afterend', ' ');
            buyBtn.parentNode.insertBefore(buyMax, buyBtn.nextSibling);
            buyBtn.parentNode.insertBefore(buy10, buyBtn.nextSibling);
            buyBtn.insertAdjacentText('afterend', ' ');
        }
        return machineRegistry.length;
    }

    // ---------------------------------------------------------------------------
    // event sources (wrapped upstream functions)
    // ---------------------------------------------------------------------------

    // Wrap Game.resources.unlock so discovering a resource is announced, without
    // editing the upstream function.
    function patchUnlock() {
        if (!Game.resources || typeof Game.resources.unlock !== 'function') {
            return;
        }
        var original = Game.resources.unlock;
        Game.resources.unlock = function (id) {
            var entry = this.entries ? this.entries[id] : null;
            var wasUnlocked = entry && entry.unlocked === true;
            original.apply(this, arguments);
            entry = this.entries ? this.entries[id] : null;
            if (entry && !wasUnlocked) {
                instance.announce((entry.name || id) + ' unlocked');
            }
        };
    }

    // pnotify toasts are the game's own notification channel (success, storage
    // full, updates). Visually they self-dismiss; without this they are silent.
    function patchPNotify() {
        if (typeof window.PNotify !== 'function') {
            return;
        }
        var Original = window.PNotify;
        var wrapper = function (opts) {
            if (opts && (opts.title || opts.text)) {
                var scratch = document.createElement('div');
                scratch.innerHTML = (opts.title ? opts.title + '. ' : '') + (opts.text || '');
                instance.announce(scratch.textContent.replace(/\s+/g, ' ').trim());
            }
            return new Original(opts);
        };
        // Keep the prototype chain: game code configures PNotify.prototype.options.
        wrapper.prototype = Original.prototype;
        window.PNotify = wrapper;
    }

    // Tab "new content" glyphs are a purely visual exclamation icon; announce
    // them with a human label, not the internal id ("Plasma", not "plasmaNav").
    function friendlyName(id) {
        var el = document.getElementById(id) || document.getElementById(id + 'Nav');
        if (el && el.getAttribute('aria-label')) {
            return el.getAttribute('aria-label');
        }
        return String(id).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    }

    function patchUnlockGlyphs() {
        if (typeof window.newUnlock === 'function') {
            var origTab = window.newUnlock;
            window.newUnlock = function (tab) {
                origTab.apply(this, arguments);
                instance.announce('New content in ' + friendlyName(tab) + ' tab');
            };
        }
        if (typeof window.newNavUnlock === 'function') {
            var origNav = window.newNavUnlock;
            window.newNavUnlock = function (nav) {
                origNav.apply(this, arguments);
                instance.announce('New item: ' + friendlyName(nav));
            };
        }
    }

    // ---------------------------------------------------------------------------
    // init
    // ---------------------------------------------------------------------------

    instance.initialise = function () {
        politeRegion = createLiveRegion('a11yPolite', 'polite');
        statusRegion = createLiveRegion('a11yStatus', 'assertive');
        buildToolbar();
        document.addEventListener('keydown', onKeyDown, false);
        patchUnlock();
        patchPNotify();
        patchUnlockGlyphs();
        patchActiveTabs();
        upgradeClickableRows();
        injectBulkBuyButtons();
        silenceUnlabeledImages(document);
        watchForUnlabeledImages();
        if (periodicEnabled()) {
            startPeriodic();
        }
        suppressUntil = Date.now() + SUPPRESS_ON_LOAD_MS;
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', instance.initialise);
    } else {
        instance.initialise();
    }

    return instance;

}());
