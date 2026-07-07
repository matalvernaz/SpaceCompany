// Accessibility layer for Space Company (fork addition; not in upstream).
//
// Interaction model: on-demand, silent by default. A screen-reader user pulls
// game state with hotkeys whenever they want; nothing is announced automatically
// except discrete events (resource unlocks, toasts, new-content markers), which
// are routed through a throttled polite live region so a burst can never
// firehose the reader. An optional periodic status announcement can be toggled
// with the A key and is persisted across sessions.
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

    // Gap between clearing and re-filling a live region. A same-tick clear+set is
    // collapsed by assistive tech into no change; a short delay forces re-announce
    // even when the new text is identical to the previous message.
    var SPEAK_RESET_DELAY_MS = 60;

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

    // Build an off-screen aria-live region. Visually hidden via the standard
    // clip pattern so it never affects layout but stays exposed to assistive tech.
    function createLiveRegion(id) {
        var el = document.createElement('div');
        el.id = id;
        el.setAttribute('aria-live', 'polite');
        el.setAttribute('aria-atomic', 'true');
        el.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;' +
            'padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);' +
            'clip-path:inset(50%);white-space:nowrap;';
        document.body.appendChild(el);
        return el;
    }

    // Announce text through a region, clearing first so repeated/identical
    // messages still re-announce.
    function speak(region, text) {
        if (!region || !text) {
            return;
        }
        region.textContent = '';
        window.setTimeout(function () {
            region.textContent = text;
        }, SPEAK_RESET_DELAY_MS);
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
    // MILESTONE_MIN_INTERVAL_MS are merged into one utterance.
    instance.announce = function (message) {
        if (!message || Date.now() < suppressUntil) {
            return;
        }
        milestoneQueue.push(String(message));
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
            'Accessibility keys. ' +
            'S: read all resources with rates and caps. ' +
            'E: energy status. ' +
            'B: machines owned. ' +
            'P: active progress bars. ' +
            'A: toggle periodic status announcements. ' +
            'H or question mark: this help. ' +
            'Tab and arrow keys reach the side navigation rows; Enter activates them. ' +
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
        speak(politeRegion, text);
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

    function onKeyDown(e) {
        // Leave browser/OS shortcuts and text entry alone.
        if (e.ctrlKey || e.altKey || e.metaKey || isTypingTarget(e.target)) {
            return;
        }

        // Keyboard activation for upgraded non-native controls (nav rows).
        var key = e.key || '';
        if ((key === 'Enter' || key === ' ') && e.target && e.target.hasAttribute &&
                e.target.hasAttribute('data-a11y-key')) {
            e.target.click();
            e.preventDefault();
            return;
        }

        switch (key.toLowerCase()) {
            case 's': instance.speakResourceSummary(); e.preventDefault(); break;
            case 'e': instance.speakEnergyStatus(); e.preventDefault(); break;
            case 'b': instance.speakBuildings(); e.preventDefault(); break;
            case 'p': instance.speakProgress(); e.preventDefault(); break;
            case 'a': instance.togglePeriodic(); e.preventDefault(); break;
            case 'h': case '?': instance.speakHelp(); e.preventDefault(); break;
        }
    }

    // ---------------------------------------------------------------------------
    // non-native control upgrade (side navigation rows)
    // ---------------------------------------------------------------------------

    // The left-side navigation is clickable <tr> elements: role="tab" is present
    // upstream but <tr> is unfocusable, making all sub-navigation mouse-only.
    // Focus + Enter/Space activation restores keyboard access; row text already
    // reads sensibly (icon is alt-silenced, then name, rate, amount).
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
            el.setAttribute('data-a11y-key', '1');
            upgraded++;
        }
        return upgraded;
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

    function bulkBuy(fnName, counterName, label, want) {
        var fn = window[fnName];
        if (typeof fn !== 'function') {
            return;
        }
        var bought = 0;
        var cap = Math.min(want, BUY_MAX_CAP);
        while (bought < cap) {
            var before = window[counterName];
            fn();
            if (window[counterName] === before) {
                break;   // could not afford the next one
            }
            bought++;
        }
        speak(statusRegion, bought > 0
            ? ('Bought ' + bought + ' ' + label)
            : ('Cannot afford ' + label));
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

            var label = (buyBtn.textContent || '').replace(/^Get\s+/i, '').replace(/\s+/g, ' ').trim()
                || counterName;

            machineRegistry.push({ fnName: fnName, counterName: counterName, label: label });

            var buy10 = makeBulkButton('×10', 'Buy 10 ' + label, (function (f, c, l) {
                return function () { bulkBuy(f, c, l, 10); };
            }(fnName, counterName, label)));

            var buyMax = makeBulkButton('Max', 'Buy max ' + label, (function (f, c, l) {
                return function () { bulkBuy(f, c, l, Infinity); };
            }(fnName, counterName, label)));

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

    // Tab "new content" glyphs are a purely visual exclamation icon; announce them.
    function patchUnlockGlyphs() {
        if (typeof window.newUnlock === 'function') {
            var origTab = window.newUnlock;
            window.newUnlock = function (tab) {
                origTab.apply(this, arguments);
                instance.announce('New content in ' + tab + ' tab');
            };
        }
        if (typeof window.newNavUnlock === 'function') {
            var origNav = window.newNavUnlock;
            window.newNavUnlock = function (nav) {
                origNav.apply(this, arguments);
                instance.announce('New item in ' + nav + ' navigation');
            };
        }
    }

    // ---------------------------------------------------------------------------
    // init
    // ---------------------------------------------------------------------------

    instance.initialise = function () {
        politeRegion = createLiveRegion('a11yPolite');
        statusRegion = createLiveRegion('a11yStatus');
        document.addEventListener('keydown', onKeyDown, false);
        patchUnlock();
        patchPNotify();
        patchUnlockGlyphs();
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
