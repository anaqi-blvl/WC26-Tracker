/**
 * Verifies that the isPlaceholder regex in src/worker.js:
 *  1. Catches every placeholder displayName format ESPN returns for not-yet-decided
 *     knockout slots (verified against live ESPN payloads on 2026-07-04).
 *  2. Does NOT match any real WC26 team name, preventing real countries from being
 *     silently blanked in the bracket / match list.
 *
 * Run with: node tests/placeholder-regex.test.js
 */

"use strict";

// ── Replica of the regex from src/worker.js ───────────────────────────────────
const isPlaceholder = name =>
  /(winner|loser|runner[- ]?up|2nd place|third place|best\b|\bmatch\s*\d|\btbd\b|to be determined)/i.test(name ?? "");

// ── ESPN placeholder displayName values observed 2026-07-04 ──────────────────
//
// R32 (group-stage feeders) — ESPN uses these before the group stage ends:
//   "Group <A-L> Winner"            → caught by "winner"
//   "Group <A-L> 2nd Place"         → caught by "2nd place"
//   "Third Place Group <letters>"   → caught by "third place"
//   "TBD"                           → caught by "\btbd\b"
//
// QF (feeders from R16 not yet played, observed from /scoreboard?dates=20260709-...):
//   "Round of 16 <1-8> Winner"      → caught by "winner"
//
// SF (feeders from QF not yet played):
//   "Quarterfinal <1-4> Winner"     → caught by "winner"
//
// Final + 3rd-place (feeders from SF):
//   "Semifinal <1-2> Winner"        → caught by "winner"
//   "Semifinal <1-2> Loser"         → caught by "loser"

const PLACEHOLDERS = [
  // R32 group-feeder placeholders
  "Group A Winner",
  "Group B Winner",
  "Group C Winner",
  "Group L Winner",
  "Group A 2nd Place",
  "Group B 2nd Place",
  "Group L 2nd Place",
  "Third Place Group CDFGH",
  "Third Place Group AEHIJ",
  "Third Place Group BEFIJ",
  "Third Place Group DEIJL",
  "Third Place Group EHIJK",
  "Third Place Group EFGIJ",
  "Third Place Group ABCDF",
  "Third Place Group CEFHI",
  "TBD",
  // QF feeders — "Round of 16 N Winner"
  "Round of 16 1 Winner",
  "Round of 16 2 Winner",
  "Round of 16 3 Winner",
  "Round of 16 4 Winner",
  "Round of 16 5 Winner",
  "Round of 16 6 Winner",
  "Round of 16 7 Winner",
  "Round of 16 8 Winner",
  // SF feeders — "Quarterfinal N Winner"
  "Quarterfinal 1 Winner",
  "Quarterfinal 2 Winner",
  "Quarterfinal 3 Winner",
  "Quarterfinal 4 Winner",
  // Final + 3rd-place feeders
  "Semifinal 1 Winner",
  "Semifinal 2 Winner",
  "Semifinal 1 Loser",
  "Semifinal 2 Loser",
];

// ── All 48 real WC26 participant teams ───────────────────────────────────────
// Source: FLAGS / ABBR maps in public/index.html; verified against FIFA draw.
const REAL_TEAMS = [
  "Algeria", "Argentina", "Australia", "Austria", "Belgium",
  "Bosnia-Herzegovina", "Brazil", "Canada", "Cape Verde", "Colombia",
  "Congo DR", "Croatia", "Curaçao", "Czechia", "Ecuador",
  "Egypt", "England", "France", "Germany", "Ghana",
  "Haiti", "Iran", "Iraq", "Ivory Coast", "Japan",
  "Jordan", "Mexico", "Morocco", "Netherlands", "New Zealand",
  "Norway", "Panama", "Paraguay", "Portugal", "Qatar",
  "Saudi Arabia", "Scotland", "Senegal", "South Africa", "South Korea",
  "Spain", "Sweden", "Switzerland", "Tunisia", "Türkiye",
  "United States", "Uruguay", "Uzbekistan",
];

// ── Test runner ───────────────────────────────────────────────────────────────
let pass = 0, fail = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓  ${label}`); pass++; }
  else           { console.error(`  ✗  ${label}`); fail++; }
}

console.log("\n── Placeholder formats that SHOULD be caught ──");
for (const p of PLACEHOLDERS) {
  assert(isPlaceholder(p), JSON.stringify(p));
}

console.log("\n── Real team names that MUST NOT be blanked ──");
for (const t of REAL_TEAMS) {
  assert(!isPlaceholder(t), JSON.stringify(t));
}

// Edge cases
console.log("\n── Edge cases ──");
assert(!isPlaceholder(""),        "empty string → not placeholder");
assert(!isPlaceholder(null),      "null → not placeholder");
assert(!isPlaceholder(undefined), "undefined → not placeholder");
// "best\b" is in the regex to catch "Best Third Place" style placeholders.
// "Best Korea" is not a real WC26 team but would be caught — acceptable.
assert(isPlaceholder("Best Third"), "'Best Third' (placeholder token) is caught");

console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
