// Balance/pacing simulator: drives the real game via its own fixedUpdate
// (spoofed clock) so energy brownouts, conversions and UI progression-gating
// all follow live rules. The bot only presses controls that are actually
// visible, mirroring what a player can reach.
//
// Usage:
//   python3 -m http.server 8199   (from the directory ABOVE the repo)
//   node sim/pacing-sim.js [gameHours] [clicksPerSec]
// Requires puppeteer-core (npm i puppeteer-core) and system chromium.
//
// Bot strategy: gathers the binding resource of the cheapest pending machine
// at a human click rate; buys visible machines cheapest-first with labs
// prioritised highest-tier-first (science gates all progression); upgrades
// storage near cap; researches every affordable tech; builds/launches the
// rocket and explores planets in fuel order. Reports milestone times, walls
// (idle >= 20 min), and a histogram of which resource blocked progress.
const puppeteer = require('puppeteer-core');

const URL = process.env.SIM_URL || 'http://localhost:8199/SpaceCompany/index.html';
const GAME_HOURS = Number(process.argv[2] || 48);
const CLICKS_PER_SEC = Number(process.argv[3] || 3);

const BOT_SRC = `
window.__bot = (function () {
    const STEP = 5;               // seconds per warped fixedUpdate
    const DECIDE_EVERY = 60;      // game-seconds between bot decisions
    const CLICKS_PER_SEC = __CPS__;

    let t = 0;
    const log = [];
    const owned = new Set();
    const researched = new Set();
    const unlockedRes = new Set();
    const explorationOrder = ['Moon','Venus','Mars','AsteroidBelt','WonderStation',
                              'Jupiter','Saturn','Pluto','KuiperBelt','SolCenter'];
    let exploreIdx = 0;
    const blockHist = {};         // resource -> idle-rounds where it was the binding shortage
    let idleSince = null;
    const walls = [];

    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
    function mark(type, name) { log.push({ t: Math.round(t), type, name }); }
    function visible(el) { return el && !el.closest('.hidden'); }

    const machines = [];
    document.querySelectorAll('button[onclick]').forEach(btn => {
        const m = /^get([A-Z]\\w*)\\(\\)$/.exec(btn.getAttribute('onclick').trim());
        if (!m) return;
        const fnName = 'get' + m[1];
        const counter = m[1].charAt(0).toLowerCase() + m[1].slice(1);
        if (typeof window[counter] !== 'number' || typeof window[fnName] !== 'function') return;
        const costs = {};
        for (const key in RESOURCE) {
            const g = counter + cap(RESOURCE[key]) + 'Cost';
            if (typeof window[g] === 'number') costs[RESOURCE[key]] = g;
        }
        if (!Object.keys(costs).length) return;
        const energyInput = typeof window[counter + 'EnergyInput'] === 'number'
            ? window[counter + 'EnergyInput'] : 0;
        machines.push({ btn, fnName, counter, costs, energyInput, label: m[1] });
    });

    const gathers = [];
    document.querySelectorAll('button[onclick^="gainResource"]').forEach(btn => {
        gathers.push({ btn, res: /gainResource\\('([a-z]+)'\\)/.exec(btn.getAttribute('onclick'))[1] });
    });

    function affordable(mach) {
        for (const res in mach.costs) {
            if (getResource(res) < window[mach.costs[res]]) return false;
        }
        return true;
    }
    function totalCost(mach) {
        let s = 0;
        for (const res in mach.costs) s += window[mach.costs[res]];
        return s;
    }
    function buyable() { return machines.filter(m => visible(m.btn)); }

    function tryMachines() {
        let acted = false;
        // labs first (highest tier first): science gates all progression, and
        // humans save for the next lab tier instead of dumping into cheap labs
        const sorted = buyable().sort((a, b) => {
            const aLab = a.counter.startsWith('lab'), bLab = b.counter.startsWith('lab');
            if (aLab !== bLab) return aLab ? -1 : 1;
            if (aLab && bLab) return totalCost(b) - totalCost(a);
            return totalCost(a) - totalCost(b);
        });
        for (const mach of sorted) {
            while (affordable(mach)) {
                if (mach.energyInput > 0 && energyps < mach.energyInput + 0.5) break;
                const before = window[mach.counter];
                window[mach.fnName]();
                if (window[mach.counter] === before) break;
                refreshPerSec(1);
                acted = true;
                if (!owned.has(mach.counter)) { owned.add(mach.counter); mark('machine', mach.label); }
            }
        }
        return acted;
    }

    function tryTechs() {
        let acted = false;
        for (const id in Game.tech.entries) {
            const tech = Game.tech.entries[id];
            if (!tech.unlocked || tech.current >= tech.maxLevel) continue;
            const cost = (tech.cost && tech.cost.science) || Infinity;
            if (getResource(RESOURCE.Science) >= cost) {
                const before = tech.current;
                purchaseTech(id);
                if (Game.tech.entries[id].current > before) {
                    acted = true;
                    if (!researched.has(id)) { researched.add(id); mark('tech', id); }
                }
            }
        }
        return acted;
    }

    function tryStorage() {
        let acted = false;
        for (const res of Object.values(RESOURCE)) {
            const capNow = getStorage(res);
            if (capNow < 0 || getResource(res) < capNow * 0.95) continue;
            const fn = window['upgrade' + cap(res) + 'Storage'];
            if (typeof fn !== 'function') continue;
            const before = capNow;
            fn();
            if (getStorage(res) > before) { acted = true; }
        }
        return acted;
    }

    function trySpace() {
        let acted = false;
        if (window.rocket === 0 && !rocketLaunched && typeof getRocket === 'function') {
            const before = window.rocket;
            getRocket();
            if (window.rocket > before) { acted = true; mark('space', 'rocket built'); }
        }
        if (window.rocket >= 1 && !rocketLaunched && getResource(RESOURCE.RocketFuel) >= 20) {
            launchRocket();
            if (rocketLaunched) { acted = true; mark('space', 'rocket LAUNCHED'); }
        }
        if (rocketLaunched && exploreIdx < explorationOrder.length) {
            const planet = explorationOrder[exploreIdx];
            const beforeLen = explored.length;
            explore(planet);
            if (explored.length > beforeLen) {
                acted = true; exploreIdx++;
                mark('space', 'explored ' + planet);
            }
        }
        return acted;
    }

    function doClicks(seconds) {
        const pending = buyable().filter(m => !affordable(m))
            .sort((a, b) => totalCost(a) - totalCost(b))[0];
        let target = null, targetRatio = Infinity;
        if (pending) {
            for (const res in pending.costs) {
                const g = gathers.find(x => x.res === res && visible(x.btn));
                if (!g) continue;
                const ratio = getResource(res) / Math.max(1, window[pending.costs[res]]);
                if (ratio < targetRatio) { targetRatio = ratio; target = res; }
            }
        }
        if (!target) {
            const g = gathers.find(x => x.res === 'metal' && visible(x.btn));
            target = g ? 'metal' : null;
        }
        if (!target) return;
        const clicks = Math.floor(seconds * CLICKS_PER_SEC);
        for (let i = 0; i < clicks; i++) gainResource(target);
    }

    function pollUnlocks() {
        for (const id in Game.resources.entries) {
            if (Game.resources.entries[id].unlocked && !unlockedRes.has(id)) {
                unlockedRes.add(id); mark('resource', id);
            }
        }
    }

    function blockedOn() {
        const pending = buyable().filter(m => !affordable(m))
            .sort((a, b) => totalCost(a) - totalCost(b))[0];
        if (!pending) return { text: 'nothing pending', res: null };
        const missing = [];
        let worstRes = null, worstRatio = Infinity;
        for (const res in pending.costs) {
            const have = getResource(res), need = window[pending.costs[res]];
            if (have < need) {
                missing.push(res + ' ' + Math.round(have) + '/' + Math.round(need));
                const ratio = have / Math.max(1, need);
                if (ratio < worstRatio) { worstRatio = ratio; worstRes = res; }
            }
        }
        return { text: pending.label + ' needs ' + missing.join(', '), res: worstRes };
    }

    function warp(seconds) {
        for (let s = 0; s < seconds; s += STEP) {
            Game.lastFixedUpdate = new Date().getTime() - STEP * 1000;
            Game.fixedUpdate();
            t += STEP;
        }
    }

    function runChunk(gameSeconds) {
        const until = t + gameSeconds;
        while (t < until) {
            warp(DECIDE_EVERY);
            Game.fastUpdate(Game, 1);   // game's own UI/visibility refresh (gating)
            doClicks(DECIDE_EVERY);
            const acted = [tryStorage(), tryTechs(), trySpace(), tryMachines()].some(Boolean);
            pollUnlocks();
            if (acted) {
                if (idleSince !== null && t - idleSince >= 1200) {
                    walls.push({ from: Math.round(idleSince), sec: Math.round(t - idleSince),
                                 blocked: blockedOn().text });
                }
                idleSince = null;
            } else {
                if (idleSince === null) idleSince = t;
                const b = blockedOn();
                if (b.res) blockHist[b.res] = (blockHist[b.res] || 0) + 1;
            }
        }
        return { t };
    }

    function report() {
        if (idleSince !== null && t - idleSince >= 1200) {
            walls.push({ from: Math.round(idleSince), sec: Math.round(t - idleSince),
                         blocked: blockedOn().text, open: true });
        }
        const state = {};
        for (const m of machines) if (window[m.counter] > 0) state[m.counter] = window[m.counter];
        return { t: Math.round(t), log, walls, blockHist, state,
                 science: Math.round(getResource('science')),
                 explored: explored.slice(), rocketLaunched };
    }

    return { runChunk, report };
}());
`;

(async () => {
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROMIUM || '/usr/bin/chromium',
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));

    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    // Full boot: stargaze/tech registries must exist before ticking, or
    // refreshPerSec throws on Game.stargaze.entries.darkMatter.
    await page.waitForFunction(() => window.Game && window.updateCost &&
        Game.stargaze && Game.stargaze.entries && Game.stargaze.entries.darkMatter &&
        Game.tech && Game.tech.entries && Game.tech.entries.efficiencyResearch,
        { timeout: 30000, polling: 200 });
    await new Promise(r => setTimeout(r, 500));

    await page.evaluate(BOT_SRC.replace('__CPS__', String(CLICKS_PER_SEC)));

    const chunk = 1800;
    for (let done = 0; done < GAME_HOURS * 3600; done += chunk) {
        await page.evaluate(s => window.__bot.runChunk(s), chunk);
    }

    const result = await page.evaluate(() => window.__bot.report());
    result.pageErrors = pageErrors;
    console.log(JSON.stringify(result));
    await browser.close();
})().catch(e => { console.error('SIM FAILED:', e); process.exit(1); });
