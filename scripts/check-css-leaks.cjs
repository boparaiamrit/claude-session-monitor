// Every view stylesheet stays loaded once visited, so a class styled by two views
// breaks whichever view loaded first. Finds view stylesheet rules that can leak into
// other views: a selector whose first class is also used by another stylesheet, and
// @keyframes names defined twice.
// Usage: npm run check:css (exits 1 on a leak).
const fs = require('fs');
const path = require('path');

process.chdir(path.join(__dirname, '..', 'src'));

const files = ['styles/app.css'];
for (const d of fs.readdirSync('views')) {
  const dir = path.join('views', d);
  if (fs.statSync(dir).isDirectory()) for (const f of fs.readdirSync(dir)) if (f.endsWith('.css')) files.push(path.join(dir, f).split(path.sep).join('/'));
}

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const owners = {};
const keyframes = {};
const rules = {};
for (const f of files) {
  const css = strip(fs.readFileSync(f, 'utf8'));
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)/g)) (keyframes[m[1]] ??= []).push(f);
  // Top-level-ish selectors: text before "{" that isn't an at-rule or keyframe step
  const sels = [];
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    const s = m[1].trim();
    if (!s || s.startsWith('@') || /^(from|to|\d+%)/.test(s)) continue;
    for (const one of s.split(',')) sels.push(one.trim());
  }
  rules[f] = sels;
  for (const s of sels) for (const c of s.matchAll(/\.([a-zA-Z][\w-]*)/g)) (owners[c[1]] ??= new Set()).add(f);
}

let leaks = 0;
for (const f of files) {
  if (f === 'styles/app.css') continue;
  for (const s of rules[f]) {
    const first = s.match(/^\.([a-zA-Z][\w-]*)/);
    if (!first) continue;
    const others = [...(owners[first[1]] ?? [])].filter((o) => o !== f);
    if (others.length) {
      leaks++;
      console.log(`${f}: "${s}"  also styled in ${others.join(', ')}`);
    }
  }
}
for (const [k, v] of Object.entries(keyframes)) if (v.length > 1) { leaks++; console.log(`@keyframes ${k} defined in ${v.join(', ')}`); }
console.log(`${leaks} potential leaks`);
process.exit(leaks ? 1 : 0);
