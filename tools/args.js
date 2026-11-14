// Command line of the tools/*.js scripts: the switches the PowerShell scripts had, so the
// commands in the docs keep their shape (`node tools/run.js -Script tests/x.oxs -Headless`).
//   const opt = parseArgs({ Game: 'TFTD', Frames: 0, Headless: false, Set: [] });
// The defaults give the types: string, number, boolean (a switch, no value), array (a list:
// the switch repeated or a comma-separated value). Names are case-insensitive, `-Name` or
// `--name`; an unknown switch or a missing value stops the script with exit code 2.
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(defaults, argv = process.argv.slice(2)) {
    const opt = {};
    const byLower = new Map();
    for (const [k, v] of Object.entries(defaults)) {
        opt[k] = Array.isArray(v) ? [...v] : v;
        byLower.set(k.toLowerCase(), k);
    }
    const fail = (msg) => {
        console.error(`${path.basename(process.argv[1])}: ${msg}`);
        console.error('switches: ' + Object.keys(defaults).map((k) => '-' + k).join(' '));
        process.exit(2);
    };
    for (let i = 0; i < argv.length; i++) {
        const m = /^--?([A-Za-z][\w-]*)$/.exec(argv[i]);
        if (!m) fail(`unexpected argument ${argv[i]}`);
        const key = byLower.get(m[1].toLowerCase());
        if (!key) fail(`unknown switch ${argv[i]}`);
        const def = defaults[key];
        if (typeof def === 'boolean') { opt[key] = true; continue; }
        if (i + 1 >= argv.length) fail(`${argv[i]} needs a value`);
        const val = argv[++i];
        if (Array.isArray(def)) opt[key].push(...val.split(',').filter((s) => s !== ''));
        else if (typeof def === 'number') {
            const n = Number(val);
            if (!Number.isFinite(n)) fail(`${argv[i - 1]}: not a number: ${val}`);
            opt[key] = n;
        } else opt[key] = val;
    }
    return opt;
}

// Runs a scenario headless through run.js (from the project root); returns its exit code and
// stdout + stderr together, as the PowerShell scripts read them ("2>&1").
function runScenario(script, extra = []) {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'run.js'), '-Script', script, '-Headless', ...extra],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
    return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

module.exports = { parseArgs, runScenario, ROOT };
