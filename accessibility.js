// Accessibility layer for Space Company (fork addition; not in upstream).
//
// Interaction model: on-demand, silent by default. A screen-reader user pulls
// game state with hotkeys whenever they want; nothing is announced automatically
// except discrete milestone events (e.g. a resource unlocking), which are routed
// through a throttled polite live region so a burst can never firehose the reader.
//
// This is deliberate: the main game loop repaints resource counts ~60x/second, so
// a naive aria-live on those nodes would make a screen reader unusable. Instead we
// read the model directly on demand via getResource/getProduction/getStorage.
//
// Everything a11y lives in this one file plus a <script> tag and a lang attribute
// in index.html; game logic is untouched (Game.resources.unlock is wrapped at
// runtime rather than edited in place).
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

    // Energy-type resources are not part of the global `resources` array, so they
    // are prepended to keep the summary in the game's own left-nav order.
    var ENERGY_RESOURCES = ['energy', 'plasma', 'uranium', 'lava'];

    var politeRegion = null;   // milestone events (throttled, coalesced)
    var statusRegion = null;   // on-demand query output (summary, help)

    var milestoneQueue = [];
    var lastMilestoneAt = 0;
    var flushScheduled = false;
    var suppressUntil = 0;

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
        el.className = 'a11y-visually-hidden';
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
    // milestone announcer (throttled + coalesced)
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
        if (milestoneQueue.length) {
            scheduleFlush();
        }
    }

    function scheduleFlush() {
        if (flushScheduled) {
            return;
        }
        var wait = Math.max(0, MILESTONE_MIN_INTERVAL_MS - (Date.now() - lastMilestoneAt));
        flushScheduled = true;
        window.setTimeout(doFlush, wait);
    }

    // Queue a discrete milestone for polite announcement. Bursts within
    // MILESTONE_MIN_INTERVAL_MS are merged into one utterance.
    instance.announce = function (message) {
        if (!message || Date.now() < suppressUntil) {
            return;
        }
        milestoneQueue.push(String(message));
        scheduleFlush();
    };

    // ---------------------------------------------------------------------------
    // on-demand resource summary
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

    instance.speakHelp = function () {
        speak(statusRegion,
            'Accessibility keys. ' +
            'S: read all resources with rates and caps. ' +
            'H or question mark: this help.');
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
        var key = e.key ? e.key.toLowerCase() : '';
        if (key === 's') {
            instance.speakResourceSummary();
            e.preventDefault();
        } else if (key === 'h' || key === '?') {
            instance.speakHelp();
            e.preventDefault();
        }
    }

    // ---------------------------------------------------------------------------
    // milestone sources
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

    // ---------------------------------------------------------------------------
    // init
    // ---------------------------------------------------------------------------

    instance.initialise = function () {
        politeRegion = createLiveRegion('a11yPolite');
        statusRegion = createLiveRegion('a11yStatus');
        document.addEventListener('keydown', onKeyDown, false);
        patchUnlock();
        suppressUntil = Date.now() + SUPPRESS_ON_LOAD_MS;
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', instance.initialise);
    } else {
        instance.initialise();
    }

    return instance;

}());
