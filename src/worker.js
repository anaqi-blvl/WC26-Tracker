/**
 * WC26 Tracker — Cloudflare Worker
 * Data source: ESPN public API (no key required)
 *
 * Routes:
 *   GET /api/standings   → KV-cached group standings + qualified slots JSON
 *   GET /api/matches     → KV-cached full-tournament match list JSON
 *   GET /                → serves the frontend HTML from KV (key: "html")
 *   GET /api/refresh     → manual refresh (protected by REFRESH_SECRET header)
 *
 * Cron: fires every 2 min during match hours (wrangler.toml), but only hits
 * ESPN when needed (adaptive — see shouldFetch in runUpdate):
 *   - a match is live, or kicks off within 15 min  → fetch scoreboard
 *   - otherwise                                    → fetch at most every 30 min
 *   - standings refetched only when a match just ended (or on the slow tick)
 */

const ESPN_STANDINGS  = "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings";
// Full tournament range so we get every fixture (incl. knockout pairings once set)
const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200";

const KV_STANDINGS = "standings_v1";
const KV_MATCHES   = "matches_v2";
const KV_QUALIFIED = "qualified_v1";
const KV_META      = "meta_v1";        // { lastFetch: epoch-ms }
const KV_HTML      = "html";
const KV_UPDATED   = "last_updated";

const LIVE_STATUSES  = ["1H", "2H", "HT", "ET", "P", "BT"];
const SOON_MS        = 15 * 60 * 1000;  // refresh window before kickoff
const POST_MATCH_MS  = 15 * 60 * 1000;  // refresh window after estimated end
const EST_MATCH_MS   = 120 * 60 * 1000; // estimated regulation match duration
const IDLE_MS        = 30 * 60 * 1000;  // max staleness when nothing is on

// ─────────────────────────────────────────────
// FETCH helpers
// ─────────────────────────────────────────────

async function fetchStandings() {
  const res = await fetch(ESPN_STANDINGS);
  if (!res.ok) throw new Error(`ESPN standings ${res.status}`);
  const data = await res.json();

  const groups = {};
  for (const child of (data.children ?? [])) {
    const letter = child.name?.replace("Group ", "").trim();
    if (!letter) continue;
    const entries = child.standings?.entries ?? [];
    groups[letter] = entries.map(e => {
      const stat = name => e.stats?.find(s => s.name === name)?.value ?? 0;
      return {
        rank:   stat("rank"),
        name:   e.team.displayName,
        logo:   e.team.logos?.[0]?.href ?? null,
        played: stat("gamesPlayed"),
        win:    stat("wins"),
        draw:   stat("ties"),
        lose:   stat("losses"),
        gf:     stat("pointsFor"),
        ga:     stat("pointsAgainst"),
        gd:     stat("pointDifferential"),
        pts:    stat("points"),
      };
    });
  }
  return groups;
}

// ESPN carries the round in event.season.slug (notes/headline is empty for WC26)
const ROUND_NAMES = {
  "group-stage":     "Group Stage",
  "round-of-32":     "Round of 32",
  "round-of-16":     "Round of 16",
  "quarterfinals":   "Quarter-finals",
  "semifinals":      "Semi-finals",
  "3rd-place-match": "Third Place",
  "final":           "Final",
};

// Knockout slots that aren't decided yet have placeholder "teams" like
// "Group C Winner", "Winners Match 73", "Runner-up Group A" or "TBD".
// Match defensively on placeholder tokens — no real WC team name contains
// any of these, so we'd rather blank an unknown slot than print junk.
const isPlaceholder = name =>
  /(winner|loser|runner[- ]?up|2nd place|third place|best\b|\bmatch\s*\d|\btbd\b|to be determined)/i.test(name ?? "");

// R32 placeholders encode the exact bracket slot ("Group C Winner" → "1C") —
// lets the frontend pin those fixtures to the right bracket cell.
function slotCode(name) {
  let m;
  if ((m = name?.match(/^Group ([A-L]) Winner$/i)))        return `1${m[1].toUpperCase()}`;
  if ((m = name?.match(/^Group ([A-L]) 2nd Place$/i)))     return `2${m[1].toUpperCase()}`;
  if ((m = name?.match(/^Third Place Group ([A-L/]+)$/i))) return "3rd " + m[1].replace(/\//g, "").toUpperCase();
  return null;
}

async function fetchMatches() {
  const res = await fetch(ESPN_SCOREBOARD);
  if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
  const data = await res.json();

  return (data.events ?? []).map(ev => {
    const comp = ev.competitions?.[0] ?? {};
    const home = comp.competitors?.find(c => c.homeAway === "home") ?? {};
    const away = comp.competitors?.find(c => c.homeAway === "away") ?? {};
    const st   = ev.status?.type ?? {};
    const slug = ev.season?.slug ?? "group-stage";

    const team = t => {
      const raw = t.team?.displayName ?? "";
      const placeholder = slug !== "group-stage" && isPlaceholder(raw);
      return {
        name:   placeholder ? "" : raw,
        slot:   placeholder ? slotCode(raw) : null,
        logo:   placeholder ? null : (t.team?.logos?.[0]?.href ?? null),
        goals:  st.state === "pre" ? null : parseInt(t.score ?? "0", 10),
        winner: t.winner === true,
      };
    };

    let statusCode;
    if (st.state === "in") {
      if (st.name?.includes("HALFTIME") || st.name?.includes("HALF_TIME")) statusCode = "HT";
      else if (st.name?.includes("OVERTIME") || st.name?.includes("EXTRA")) statusCode = "ET";
      else if (st.name?.includes("SHOOTOUT") || st.name?.includes("PEN"))   statusCode = "P";
      else statusCode = "1H";
    } else if (st.completed) {
      statusCode = "FT";
    } else {
      statusCode = "NS";
    }

    return {
      id:         ev.id,
      date:       ev.date,
      status:     statusCode,
      statusLong: st.description ?? "",
      elapsed:    st.detail ?? null,
      venue:      comp.venue?.fullName ?? "",
      city:       comp.venue?.address?.city ?? "",
      home:       team(home),
      away:       team(away),
      round:      ROUND_NAMES[slug] ?? slug,
    };
  });
}

// ─────────────────────────────────────────────
// QUALIFIED slots — derived from standings
// ─────────────────────────────────────────────

/**
 * Returns { slots: { "1A": team, "2A": team, ... }, thirds: [team...] }.
 * A group's slots are filled only once every team has played all 3 games.
 * thirds = the 8 best third-placed teams (only when all 12 groups are done).
 */
function computeQualified(standings) {
  const slots = {};
  const allThirds = [];
  const letters = Object.keys(standings);
  let completeGroups = 0;

  for (const letter of letters) {
    const teams = standings[letter] ?? [];
    if (teams.length === 0 || !teams.every(t => t.played >= 3)) continue;
    completeGroups++;
    const sorted = [...teams].sort((a, b) => a.rank - b.rank);
    if (sorted[0]) slots[`1${letter}`] = { name: sorted[0].name, logo: sorted[0].logo };
    if (sorted[1]) slots[`2${letter}`] = { name: sorted[1].name, logo: sorted[1].logo };
    if (sorted[2]) allThirds.push({ name: sorted[2].name, logo: sorted[2].logo, group: letter,
                                    pts: sorted[2].pts, gd: sorted[2].gd, gf: sorted[2].gf });
  }

  let thirds = [];
  if (letters.length >= 12 && completeGroups === letters.length) {
    // Approximation of FIFA's best-thirds ranking: we apply the first three
    // criteria (points, goal difference, goals scored). The remaining
    // tiebreakers — disciplinary points and drawing of lots — aren't in the
    // ESPN feed, so a tie this deep would resolve in arbitrary (array) order.
    thirds = allThirds
      .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf)
      .slice(0, 8);
  }
  return { slots, thirds };
}

// ─────────────────────────────────────────────
// CRON handler — adaptive update
// ─────────────────────────────────────────────

async function runUpdate(env, { force = false } = {}) {
  const now = Date.now();
  const [metaRaw, cachedRaw] = await Promise.all([
    env.WC26_KV.get(KV_META),
    env.WC26_KV.get(KV_MATCHES),
  ]);
  const meta   = metaRaw   ? JSON.parse(metaRaw)   : {};
  const cached = cachedRaw ? JSON.parse(cachedRaw) : [];

  const anyLive = cached.some(m => LIVE_STATUSES.includes(m.status));
  const anySoon = cached.some(m => {
    const kickoff = new Date(m.date).getTime();
    if (m.status === "NS") {
      const diff = kickoff - now;
      return diff < SOON_MS && diff > -3 * 60 * 60 * 1000;
    }
    if (m.status === "FT") {
      // keep fetching for 15 min after estimated regulation end
      return now < kickoff + EST_MATCH_MS + POST_MATCH_MS;
    }
    return false;
  });
  const stale = !meta.lastFetch || (now - meta.lastFetch) > IDLE_MS;
  const inPostMatchWindow = !!(meta.standingsRefreshUntil && now < meta.standingsRefreshUntil);

  if (!force && cached.length > 0 && !anyLive && !anySoon && !stale && !inPostMatchWindow) {
    return; // nothing happening — skip the ESPN hit entirely
  }

  try {
    const matches = await fetchMatches();
    if (matches.length > 0) {
      await env.WC26_KV.put(KV_MATCHES, JSON.stringify(matches));
    }

    // Did any match just finish? → standings (and qualification) changed.
    const prevStatus = new Map(cached.map(m => [m.id, m.status]));
    const justFinished = matches.some(
      m => m.status === "FT" && prevStatus.has(m.id) && prevStatus.get(m.id) !== "FT"
    );
    const haveStandings = await env.WC26_KV.get(KV_STANDINGS);

    // ESPN standings API can lag 5-10 min behind the scoreboard after a match ends.
    // Keep re-fetching standings for 15 min after any FT transition so we catch
    // the update even if it didn't land on the very first post-match cron run.
    if (justFinished) {
      meta.standingsRefreshUntil = now + 15 * 60 * 1000;
    }

    if (force || justFinished || inPostMatchWindow || stale || !haveStandings) {
      const standings = await fetchStandings();
      if (standings && Object.keys(standings).length > 0) {
        await env.WC26_KV.put(KV_STANDINGS, JSON.stringify(standings));
        await env.WC26_KV.put(KV_QUALIFIED, JSON.stringify(computeQualified(standings)));
      }
    }

    meta.lastFetch = now;
    await env.WC26_KV.put(KV_META, JSON.stringify(meta));
    await env.WC26_KV.put(KV_UPDATED, new Date(now).toISOString());
    console.log(`[WC26] Updated — ${matches.length} matches (live=${anyLive}, finished=${justFinished}, postMatch=${inPostMatchWindow})`);
  } catch (err) {
    console.error(`[WC26] Update failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// HTTP request handler
// ─────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60",
    },
  });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET",
      },
    });
  }

  if (url.pathname === "/api/standings") {
    const [cached, qualified, updated] = await Promise.all([
      env.WC26_KV.get(KV_STANDINGS),
      env.WC26_KV.get(KV_QUALIFIED),
      env.WC26_KV.get(KV_UPDATED),
    ]);
    if (!cached) return jsonResponse({ error: "Not yet populated" }, 503);
    return jsonResponse({
      updated,
      standings: JSON.parse(cached),
      qualified: qualified ? JSON.parse(qualified) : { slots: {}, thirds: [] },
    });
  }

  if (url.pathname === "/api/matches") {
    const cached  = await env.WC26_KV.get(KV_MATCHES);
    const updated = await env.WC26_KV.get(KV_UPDATED);
    if (!cached) return jsonResponse({ error: "Not yet populated" }, 503);
    return jsonResponse({ updated, matches: JSON.parse(cached) });
  }

  if (url.pathname === "/api/refresh") {
    const secret = request.headers.get("x-refresh-secret");
    if (secret !== env.REFRESH_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    await runUpdate(env, { force: true });
    return jsonResponse({ ok: true, message: "Refresh triggered" });
  }

  if (url.pathname === "/icon.png") {
    const icon = await env.WC26_KV.get("icon", "arrayBuffer");
    if (!icon) return new Response("Not found", { status: 404 });
    return new Response(icon, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  const html = await env.WC26_KV.get(KV_HTML);
  if (html) {
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=30",
      },
    });
  }

  return new Response("WC26 Tracker — not yet deployed", { status: 404 });
}

// ─────────────────────────────────────────────
// Worker exports
// ─────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runUpdate(env));
  },
};
