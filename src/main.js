import {
  buildAnalysis,
  buildContext,
  buildSubmissionLookup,
  roundFromSlot,
  slotParticipantsIfKnown,
} from "./engine.js";

const state = {
  manifest: null,
  gender: "combined",
  metric: "brier",
  forecastMode: "blend",
  forecastWeightOurs: 0.5,
  numSims: 3000,
  seed: 20260322,
  meta: {},
  defaultCsv: {},
  uploads: {
    our: null,
    benchmark: null,
  },
  manualResolved: {
    men: {},
    women: {},
  },
  manualHistory: [],
  benchmarkSource: "median",
  tableSort: {
    key: "displaySwing",
    dir: "desc",
  },
  currentView: null,
  restoredFromStorage: false,
};

const els = {};
const STORAGE_KEYS = {
  ourUpload: "wsirf:our-upload",
  benchmarkSource: "wsirf:benchmark-source",
  manualResolved: "wsirf:manual-resolved",
  manualHistory: "wsirf:manual-history",
};

const REGION_CONFIG = {
  men: {
    W: "East",
    X: "South",
    Y: "Midwest",
    Z: "West",
  },
  women: {
    W: "Fort Worth #1",
    X: "Sacramento #4",
    Y: "Fort Worth #3",
    Z: "Sacramento #2",
  },
};

const ROUND_TITLES = {
  2: "Round of 32",
  3: "Sweet 16",
  4: "Elite 8",
  5: "Final Four",
  6: "Championship",
};

async function fetchText(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${path}`);
  return response.text();
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${path}`);
  return response.json();
}

function restorePersistedState() {
  try {
    const storedUpload = localStorage.getItem(STORAGE_KEYS.ourUpload);
    const storedBenchmarkSource = localStorage.getItem(STORAGE_KEYS.benchmarkSource);
    const storedManualResolved = localStorage.getItem(STORAGE_KEYS.manualResolved);
    const storedManualHistory = localStorage.getItem(STORAGE_KEYS.manualHistory);
    if (storedUpload) {
      state.uploads.our = storedUpload;
      state.restoredFromStorage = true;
    }
    if (storedBenchmarkSource && storedBenchmarkSource !== "upload") {
      state.benchmarkSource = storedBenchmarkSource;
    }
    if (storedManualResolved) {
      const parsed = JSON.parse(storedManualResolved);
      state.manualResolved = {
        men: parsed?.men ?? {},
        women: parsed?.women ?? {},
      };
    }
    if (storedManualHistory) {
      const parsed = JSON.parse(storedManualHistory);
      if (Array.isArray(parsed)) {
        state.manualHistory = parsed;
      }
    }
  } catch (error) {
    console.warn("Failed to restore state", error);
  }
}

function persistState() {
  try {
    if (state.uploads.our) {
      localStorage.setItem(STORAGE_KEYS.ourUpload, state.uploads.our);
    } else {
      localStorage.removeItem(STORAGE_KEYS.ourUpload);
    }

    if (state.benchmarkSource && state.benchmarkSource !== "upload") {
      localStorage.setItem(STORAGE_KEYS.benchmarkSource, state.benchmarkSource);
    } else {
      localStorage.removeItem(STORAGE_KEYS.benchmarkSource);
    }

    localStorage.setItem(STORAGE_KEYS.manualResolved, JSON.stringify(state.manualResolved));
    localStorage.setItem(STORAGE_KEYS.manualHistory, JSON.stringify(state.manualHistory));
  } catch (error) {
    console.warn("Failed to persist state", error);
  }
}

function cloneManualState() {
  return {
    men: { ...state.manualResolved.men },
    women: { ...state.manualResolved.women },
  };
}

function sameManualState(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pushManualHistorySnapshot() {
  state.manualHistory.push(cloneManualState());
  if (state.manualHistory.length > 100) {
    state.manualHistory = state.manualHistory.slice(-100);
  }
}

function fmtSigned(value, digits = 4) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function fmtPct(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function scoreDigits(metric) {
  return metric === "brier" ? 5 : 4;
}

function logoImg(context, teamId, alt, className = "team-logo") {
  const team = context.teamById.get(teamId);
  if (!team?.logoUrl) return "";
  return `<img class="${className}" src="${team.logoUrl}" alt="${alt}" loading="lazy" />`;
}

function metricLabel(metric) {
  return metric === "brier" ? "Brier" : "Log Loss";
}

function metricNoun(metric) {
  return metric === "brier" ? "Brier score" : "log loss";
}

const SORT_CONFIG = {
  rootingInterest: { defaultDir: "asc" },
  displaySwing: { defaultDir: "desc" },
  upsideSwing: { defaultDir: "desc" },
  rootForProb: { defaultDir: "desc" },
  benchmarkRootForProb: { defaultDir: "desc" },
  finalGapIfRootForWins: { defaultDir: "desc" },
};

function sortValue(row, key) {
  if (key === "rootingInterest") {
    const otherName = row.cheerFor === row.teamA ? row.teamBName : row.teamAName;
    return `${row.cheerForName} over ${otherName} ${row.genderLabel} ${row.round}`.toLowerCase();
  }
  return row[key];
}

function compareRows(a, b, key, dir) {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  let cmp;
  if (typeof av === "number" && typeof bv === "number") {
    cmp = av - bv;
  } else {
    cmp = String(av).localeCompare(String(bv));
  }
  if (cmp === 0) {
    cmp = b.displaySwing - a.displaySwing;
  }
  return dir === "asc" ? cmp : -cmp;
}

function sortRows(rows) {
  const { key, dir } = state.tableSort;
  return [...rows].sort((a, b) => compareRows(a, b, key, dir));
}

function sortArrow(key) {
  if (state.tableSort.key !== key) return "";
  return state.tableSort.dir === "asc" ? "↑" : "↓";
}

function sortableHeader(label, key) {
  const active = state.tableSort.key === key;
  return `
    <button class="sort-button ${active ? "active" : ""}" type="button" data-sort-key="${key}">
      <span>${label}</span>
      <span class="sort-arrow" aria-hidden="true">${sortArrow(key)}</span>
    </button>
  `;
}

function combineAnalyses(men, women) {
  const totalGames = men.totalGames + women.totalGames;
  const completedCount = men.completedCount + women.completedCount;
  return {
    scope: "combined",
    totalGames,
    completedCount,
    remainingCount: totalGames - completedCount,
    ourCurrentAverage:
      (men.ourCurrentLossTotal + women.ourCurrentLossTotal) / completedCount,
    benchmarkCurrentAverage:
      (men.benchmarkCurrentLossTotal + women.benchmarkCurrentLossTotal) / completedCount,
    ourExpectedFinalAverage:
      (men.ourExpectedFinalLossTotal + women.ourExpectedFinalLossTotal) / totalGames,
    benchmarkExpectedFinalAverage:
      (men.benchmarkExpectedFinalLossTotal + women.benchmarkExpectedFinalLossTotal) / totalGames,
    expectedFinalEdgeAverage:
      (men.expectedFinalEdgeTotal + women.expectedFinalEdgeTotal) / totalGames,
    expectedFinalEdgeTotal: men.expectedFinalEdgeTotal + women.expectedFinalEdgeTotal,
  };
}

function manualResolvedMap(gender) {
  return new Map(
    Object.entries(state.manualResolved[gender] || {}).map(([slot, teamId]) => [slot, Number(teamId)]),
  );
}

function buildEffectiveContext(baseContext, gender) {
  const officialResolved = new Map(baseContext.completedSlots);
  const manualInput = manualResolvedMap(gender);
  const appliedManual = new Map();
  const allSlots = [...baseContext.allSlots].sort(
    (a, b) => roundFromSlot(a) - roundFromSlot(b) || a.localeCompare(b),
  );

  for (const slot of allSlots) {
    if (officialResolved.has(slot)) continue;
    if (!manualInput.has(slot)) continue;
    const participants = slotParticipantsIfKnown(slot, baseContext, officialResolved);
    if (!participants) continue;
    const chosenTeam = manualInput.get(slot);
    if (!participants.includes(chosenTeam)) continue;
    officialResolved.set(slot, chosenTeam);
    appliedManual.set(slot, chosenTeam);
  }

  return {
    ...baseContext,
    scopeKey: gender,
    baseCompletedSlots: new Map(baseContext.completedSlots),
    completedSlots: officialResolved,
    manualCompletedSlots: appliedManual,
  };
}

function syncManualResolvedFromContexts(menContext, womenContext) {
  const nextManual = {
    men: Object.fromEntries(menContext.manualCompletedSlots),
    women: Object.fromEntries(womenContext.manualCompletedSlots),
  };
  if (!sameManualState(nextManual, state.manualResolved)) {
    state.manualResolved = nextManual;
    persistState();
  }
}

function manualCountForView(view) {
  if (view.scope === "combined") {
    return (view.menContext?.manualCompletedSlots.size || 0) +
      (view.womenContext?.manualCompletedSlots.size || 0);
  }
  return view.context?.manualCompletedSlots.size || 0;
}

function enrichRowsForScope(rows, ownAnalysis, otherAnalysis, totalGames, genderLabel) {
  return rows.map((row) => {
    const otherEdge = otherAnalysis ? otherAnalysis.expectedFinalEdgeTotal : 0;
    const otherBest = otherAnalysis ? otherAnalysis.bestPossibleFinalEdgeTotal : 0;
    const displayGapIfA = (row.expectedFinalEdgeIfTeamAWins + otherEdge) / totalGames;
    const displayGapIfB = (row.expectedFinalEdgeIfTeamBWins + otherEdge) / totalGames;
    const displaySwing = Math.abs(displayGapIfA - displayGapIfB);
    const displayBestGapIfA = (row.bestFinalEdgeIfTeamAWins + otherBest) / totalGames;
    const displayBestGapIfB = (row.bestFinalEdgeIfTeamBWins + otherBest) / totalGames;
    const rootForUpside =
      row.cheerFor === row.teamA ? displayBestGapIfA : displayBestGapIfB;
    const nonRootUpside =
      row.cheerFor === row.teamA ? displayBestGapIfB : displayBestGapIfA;
    const upsideSwing = rootForUpside - nonRootUpside;
    const rootForProb =
      row.cheerFor === row.teamA ? row.ourProbTeamA : 1 - row.ourProbTeamA;
    const benchmarkRootForProb =
      row.cheerFor === row.teamA
        ? row.benchmarkProbTeamA
        : 1 - row.benchmarkProbTeamA;
    const finalGapIfRootForWins =
      row.cheerFor === row.teamA ? displayGapIfA : displayGapIfB;
    return {
      ...row,
      genderLabel,
      displayGapIfA,
      displayGapIfB,
      displaySwing,
      upsideSwing,
      rootForProb,
      benchmarkRootForProb,
      finalGapIfRootForWins,
    };
  });
}

function renderSummary(analysis) {
  const digits = scoreDigits(state.metric);
  const manualCount = analysis.manualCount || 0;
  els.summary.innerHTML = `
    <div class="card">
      <div class="eyebrow">Games Scored So Far</div>
      <div class="big">${analysis.completedCount}</div>
      <div class="muted">${analysis.remainingCount} remaining of ${analysis.totalGames}${manualCount ? ` · ${manualCount} entered here` : ""}</div>
    </div>
    <div class="card">
      <div class="eyebrow">Your ${metricNoun(state.metric)} So Far</div>
      <div class="big">${analysis.ourCurrentAverage.toFixed(digits)}</div>
      <div class="muted">Benchmark: ${analysis.benchmarkCurrentAverage.toFixed(digits)}</div>
    </div>
    <div class="card">
      <div class="eyebrow">Projected Final ${metricNoun(state.metric)}</div>
      <div class="big">${analysis.ourExpectedFinalAverage.toFixed(digits)}</div>
      <div class="muted">Benchmark: ${analysis.benchmarkExpectedFinalAverage.toFixed(digits)}</div>
    </div>
    <div class="card">
      <div class="eyebrow">Projected Final Edge</div>
      <div class="big">${fmtSigned(analysis.expectedFinalEdgeAverage)}</div>
      <div class="muted">Benchmark ${metricNoun(state.metric)} minus yours. Positive is good.</div>
    </div>
  `;
}

function renderTable(view) {
  if (!view.rows.length) {
    els.tableWrap.innerHTML = `<div class="empty">No open games with known participants.</div>`;
    return;
  }

  const contextForRow = (row) => {
    if (row.genderLabel === "Men") return view.menContext || view.context;
    if (row.genderLabel === "Women") return view.womenContext || view.context;
    return view.context;
  };

  const sortedRows = sortRows(view.rows);
  const rowsHtml = sortedRows
    .map((row) => `
      <tr>
        <td>
          <div class="rooting-call">
            <div class="pick-cell">
              ${logoImg(contextForRow(row), row.cheerFor, row.cheerForName)}
              <strong>${row.cheerForName}</strong>
              <span class="muted">over</span>
              ${logoImg(
                contextForRow(row),
                row.cheerFor === row.teamA ? row.teamB : row.teamA,
                row.cheerFor === row.teamA ? row.teamBName : row.teamAName,
              )}
              <strong>${row.cheerFor === row.teamA ? row.teamBName : row.teamAName}</strong>
            </div>
            <div class="muted">${row.genderLabel} · ${row.round === 2 ? "Round of 32" : row.round === 3 ? "Sweet 16" : `Round ${row.round}`}</div>
          </div>
        </td>
        <td>${fmtSigned(row.displaySwing, 5)}</td>
        <td>${fmtSigned(row.upsideSwing, 5)}</td>
        <td>${fmtPct(row.rootForProb)}</td>
        <td>${fmtPct(row.benchmarkRootForProb)}</td>
        <td>${fmtSigned(row.finalGapIfRootForWins, 4)}</td>
      </tr>
    `)
    .join("");

  els.tableWrap.innerHTML = `
    <div class="list-card table-card">
        <div class="section-head">
          <div>
            <div class="eyebrow">Sorted by Brier Gain</div>
            <h2>Rooting Guide</h2>
          </div>
          <div class="metric-legend">
          <div><strong>Brier Gain</strong>: expected boost to your final edge if this team wins instead of the other one.</div>
          <div><strong>Ceiling Swing</strong>: difference in best-case final edge between the two possible winners.</div>
          <div><strong>Expected Final Brier Edge</strong>: benchmark-minus-you Brier score if this team wins, averaged over the rest of the bracket.</div>
          </div>
        </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>${sortableHeader("Rooting Interest", "rootingInterest")}</th>
              <th>${sortableHeader("Brier Gain", "displaySwing")}</th>
              <th>${sortableHeader("Ceiling Swing", "upsideSwing")}</th>
              <th>${sortableHeader("Our Prob", "rootForProb")}</th>
              <th>${sortableHeader("Benchmark Prob", "benchmarkRootForProb")}</th>
              <th>${sortableHeader("Expected Final Brier Edge", "finalGapIfRootForWins")}</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAwaitingSubmission() {
  els.summary.innerHTML = "";
  els.bracketWrap.innerHTML = "";
  updateManualControls();
  els.tableWrap.innerHTML = `
    <div class="list-card table-card">
      <div class="empty">Upload your submission CSV to generate the rooting guide.</div>
    </div>
  `;
}

function updateManualControls(view = null) {
  const manualCount = view ? manualCountForView(view) : (
    Object.keys(state.manualResolved.men || {}).length +
    Object.keys(state.manualResolved.women || {}).length
  );
  els.manualSummary.textContent = manualCount
    ? `Click a team in the bracket to enter or change a result. ${manualCount} manual ${manualCount === 1 ? "result" : "results"} entered in this browser.`
    : "Click a team in the bracket to enter or change a result. No manual results entered in this browser.";
  els.undoManual.disabled = state.manualHistory.length === 0;
  els.clearManual.disabled = manualCount === 0;
}

async function setManualWinner(gender, slot, teamId) {
  const current = Number(state.manualResolved[gender]?.[slot] ?? 0);
  if (current === teamId) return;
  pushManualHistorySnapshot();
  state.manualResolved[gender] = {
    ...state.manualResolved[gender],
    [slot]: teamId,
  };
  persistState();
  await recompute();
  updateStatus(`Saved ${gender} result for ${slot}.`);
}

async function undoManualResult() {
  if (!state.manualHistory.length) return;
  const snapshot = state.manualHistory.pop();
  state.manualResolved = {
    men: { ...(snapshot?.men ?? {}) },
    women: { ...(snapshot?.women ?? {}) },
  };
  persistState();
  await recompute();
  updateStatus("Undid the last manual result.");
}

async function clearManualResults() {
  const hasManual = Object.keys(state.manualResolved.men).length || Object.keys(state.manualResolved.women).length;
  if (!hasManual) return;
  pushManualHistorySnapshot();
  state.manualResolved = { men: {}, women: {} };
  persistState();
  await recompute();
  updateStatus("Cleared manual results.");
}

function displayToken(token, context) {
  if (context.seedToTeam.has(token)) {
    return context.teamNameById.get(context.seedToTeam.get(token));
  }
  if (context.completedSlots.has(token)) {
    return context.teamNameById.get(context.completedSlots.get(token));
  }
  if (!context.slotRows.has(token)) {
    return token;
  }
  const participants = slotParticipantsIfKnown(token, context, context.completedSlots);
  if (!participants) return `Winner of ${token}`;
  return participants
    .map((teamId) => context.teamNameById.get(teamId))
    .join(" / ");
}

function renderTeamLine(name, modifier = "", options = {}) {
  if (options.clickable) {
    return `
      <button
        type="button"
        class="team-line team-pick ${modifier}"
        data-pick-slot="${options.slot}"
        data-pick-team="${options.teamId}"
        data-pick-gender="${options.gender}"
      >
        ${name}
      </button>
    `;
  }
  return `<div class="team-line ${modifier}">${name}</div>`;
}

function renderTeamLineWithLogo(context, teamId, name, modifier = "", options = {}) {
  const inner = `
    ${logoImg(context, teamId, name)}
    <span>${name}</span>
  `;
  if (options.clickable) {
    return `
      <button
        type="button"
        class="team-line team-pick ${modifier}"
        data-pick-slot="${options.slot}"
        data-pick-team="${teamId}"
        data-pick-gender="${options.gender}"
      >
        ${inner}
      </button>
    `;
  }
  return `
    <div class="team-line ${modifier}">
      ${inner}
    </div>
  `;
}

function collectSlotsAtRound(slot, targetRound, context) {
  if (!context.slotRows.has(slot)) return [];
  if (roundFromSlot(slot) === targetRound) return [slot];
  const [strong, weak] = context.slotRows.get(slot);
  return [
    ...collectSlotsAtRound(strong, targetRound, context),
    ...collectSlotsAtRound(weak, targetRound, context),
  ];
}

function orderedRegionSlots(prefix, round, context) {
  const rootSlot = `R4${prefix}1`;
  if (round > 4) return [];
  return collectSlotsAtRound(rootSlot, round, context);
}

function orderedFinalSlots(round, context) {
  const rootSlot = "R6CH";
  return collectSlotsAtRound(rootSlot, round, context);
}

function bracketLegend() {
  return `
    <div class="bracket-legend">
      <span class="legend-item"><span class="legend-swatch recommended"></span> Root for this team</span>
      <span class="legend-item"><span class="legend-swatch winner"></span> Official result</span>
      <span class="legend-item"><span class="legend-swatch manual"></span> Manual result</span>
      <span class="legend-item"><span class="legend-swatch fade"></span> Other side / already lost</span>
    </div>
  `;
}

function renderGameCard(slot, context, rowBySlot) {
  const pair = context.slotRows.get(slot);
  if (!pair) return "";
  const [strong, weak] = pair;
  const row = rowBySlot.get(slot);
  const completedWinner = context.completedSlots.get(slot);
  const officialWinner = context.baseCompletedSlots?.get(slot);
  const manualWinner = context.manualCompletedSlots?.get(slot);

  let first = displayToken(strong, context);
  let second = displayToken(weak, context);
  let firstClass = "";
  let secondClass = "";
  let badge = "Future";
  let cardClass = "future";
  let firstOptions = {};
  let secondOptions = {};

  const knownParticipants = slotParticipantsIfKnown(slot, context, context.completedSlots);
  if (knownParticipants) {
    [first, second] = knownParticipants.map((teamId) => context.teamNameById.get(teamId));
  }

  if (officialWinner != null && knownParticipants) {
    badge = "Official";
    cardClass = "completed";
    firstClass = knownParticipants[0] === officialWinner ? "winner" : "loser";
    secondClass = knownParticipants[1] === officialWinner ? "winner" : "loser";
  } else if (manualWinner != null && knownParticipants) {
    badge = "Manual result";
    cardClass = "manual";
    firstClass = knownParticipants[0] === manualWinner ? "manual-winner" : "loser";
    secondClass = knownParticipants[1] === manualWinner ? "manual-winner" : "loser";
    firstOptions = { clickable: true, slot, gender: context.scopeKey, teamId: knownParticipants[0] };
    secondOptions = { clickable: true, slot, gender: context.scopeKey, teamId: knownParticipants[1] };
  } else if (row) {
    badge = `Root for ${row.cheerForName}`;
    cardClass = "open";
    firstClass = row.teamA === row.cheerFor ? "recommended" : "fade";
    secondClass = row.teamB === row.cheerFor ? "recommended" : "fade";
    firstOptions = { clickable: true, slot, gender: context.scopeKey, teamId: knownParticipants[0] };
    secondOptions = { clickable: true, slot, gender: context.scopeKey, teamId: knownParticipants[1] };
  }

  return `
    <article class="bracket-card ${cardClass}">
      <div class="bracket-head">
        <span class="slot">${slot}</span>
        <span class="badge">${badge}</span>
      </div>
      ${
        knownParticipants
          ? renderTeamLineWithLogo(context, knownParticipants[0], first, firstClass, firstOptions)
          : renderTeamLine(first, firstClass, firstOptions)
      }
      ${
        knownParticipants
          ? renderTeamLineWithLogo(context, knownParticipants[1], second, secondClass, secondOptions)
          : renderTeamLine(second, secondClass, secondOptions)
      }
    </article>
  `;
}

function renderBracket(analysis, context) {
  if (!analysis.rows.length) {
    els.bracketWrap.innerHTML = "";
    return;
  }

  const rowBySlot = new Map(analysis.rows.map((row) => [row.slot, row]));
  const minRound = Math.min(...analysis.rows.map((row) => row.round));
  const regions = REGION_CONFIG[state.gender];

  const regionMarkup = Object.entries(regions)
    .map(([prefix, label]) => {
        const rounds = [];
        for (let round = minRound; round <= 4; round += 1) {
          const slots = orderedRegionSlots(prefix, round, context);
          if (!slots.length) continue;
          rounds.push(`
          <div class="round-column round-${round}">
            <div class="round-title">${ROUND_TITLES[round] || `Round ${round}`}</div>
            <div class="round-stack">
              ${slots.map((slot) => renderGameCard(slot, context, rowBySlot)).join("")}
            </div>
          </div>
        `);
      }
      return `
        <section class="region-card">
          <div class="region-title">${label}</div>
          <div class="region-grid">${rounds.join("")}</div>
        </section>
      `;
    })
    .join("");

  const finalMarkup = `
    <section class="region-card final-card">
      <div class="region-title">Final Four</div>
      <div class="region-grid">
        ${[5, 6]
          .map((round) => {
            const slots = orderedFinalSlots(round, context);
            if (!slots.length) return "";
            return `
              <div class="round-column round-${round}">
                <div class="round-title">${ROUND_TITLES[round]}</div>
                <div class="round-stack">
                  ${slots.map((slot) => renderGameCard(slot, context, rowBySlot)).join("")}
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    </section>
  `;

  els.bracketWrap.innerHTML = `
    <section class="list-card bracket-shell">
      <div class="section-head">
        <div>
          <div class="eyebrow">Live Bracket Board</div>
          <h2>Remaining Bracket</h2>
        </div>
        ${bracketLegend()}
      </div>
      <div class="bracket-scroll">
        <div class="bracket-grid">
          ${regionMarkup}
          ${finalMarkup}
        </div>
      </div>
    </section>
  `;
}

function renderBracketPanel(title, analysis, context) {
  if (!analysis.rows.length) return "";
  const displayTitle = title === "Men" ? "Men's" : title === "Women" ? "Women's" : title;
  const rowBySlot = new Map(analysis.rows.map((row) => [row.slot, row]));
  const minRound = Math.min(...analysis.rows.map((row) => row.round));
  const regions = REGION_CONFIG[title.toLowerCase()];

  const regionMarkup = Object.entries(regions)
    .map(([prefix, label]) => {
      const rounds = [];
      for (let round = minRound; round <= 4; round += 1) {
        const slots = orderedRegionSlots(prefix, round, context);
        if (!slots.length) continue;
        rounds.push(`
          <div class="round-column round-${round}">
            <div class="round-title">${ROUND_TITLES[round] || `Round ${round}`}</div>
            <div class="round-stack">
              ${slots.map((slot) => renderGameCard(slot, context, rowBySlot)).join("")}
            </div>
          </div>
        `);
      }
      return `
        <section class="region-card">
          <div class="region-title">${label}</div>
          <div class="region-grid">${rounds.join("")}</div>
        </section>
      `;
    })
    .join("");

  return `
    <section class="list-card bracket-shell">
      <div class="section-head">
        <div>
          <div class="eyebrow">${displayTitle}</div>
          <h2>${displayTitle} Bracket</h2>
        </div>
        ${bracketLegend()}
      </div>
      <div class="bracket-scroll">
        <div class="bracket-grid">
          ${regionMarkup}
          <section class="region-card final-card">
            <div class="region-title">Final Four</div>
            <div class="region-grid">
              ${[5, 6]
          .map((round) => {
            const slots = orderedFinalSlots(round, context);
            if (!slots.length) return "";
            return `
              <div class="round-column round-${round}">
                <div class="round-title">${ROUND_TITLES[round]}</div>
                <div class="round-stack">
                  ${slots.map((slot) => renderGameCard(slot, context, rowBySlot)).join("")}
                </div>
              </div>
                  `;
                })
                .join("")}
            </div>
          </section>
        </div>
      </div>
    </section>
  `;
}

function renderBrackets(view) {
  if (view.scope === "combined") {
    els.bracketWrap.innerHTML = `
      ${renderBracketPanel("Men", view.menAnalysis, view.menContext)}
      ${renderBracketPanel("Women", view.womenAnalysis, view.womenContext)}
    `;
    return;
  }
  renderBracket(view.analysis, view.context);
}

function updateStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.dataset.error = isError ? "true" : "false";
}

async function getMeta(gender) {
  if (!state.meta[gender]) {
    state.meta[gender] = await fetchJson(state.manifest[gender].meta);
  }
  return state.meta[gender];
}

async function getDefaultCsv(kind, gender) {
  const key = `${gender}:${kind}`;
  if (!state.defaultCsv[key]) {
    state.defaultCsv[key] = await fetchText(state.manifest[gender][kind]);
  }
  return state.defaultCsv[key];
}

function benchmarkDefaultKind() {
  return state.benchmarkSource === "andrew" ? "ourDefault" : "benchmarkDefault";
}

async function recompute() {
  try {
    const ourUploadText = state.uploads.our;
    if (!ourUploadText) {
      state.currentView = null;
      renderAwaitingSubmission();
      updateStatus("Upload your submission CSV to begin.");
      return;
    }

    updateStatus("Recomputing…");
    const menMeta = await getMeta("men");
    const womenMeta = await getMeta("women");
    const menBaseContext = buildContext(menMeta);
    const womenBaseContext = buildContext(womenMeta);
    const menContext = buildEffectiveContext(menBaseContext, "men");
    const womenContext = buildEffectiveContext(womenBaseContext, "women");
    syncManualResolvedFromContexts(menContext, womenContext);
    const benchmarkUploadText = state.uploads.benchmark;

    const menOurText = ourUploadText;
    const menBenchmarkText =
      state.benchmarkSource === "upload"
        ? benchmarkUploadText || await getDefaultCsv("benchmarkDefault", "men")
        : await getDefaultCsv(benchmarkDefaultKind(), "men");
    const womenOurText = ourUploadText;
    const womenBenchmarkText =
      state.benchmarkSource === "upload"
        ? benchmarkUploadText || await getDefaultCsv("benchmarkDefault", "women")
        : await getDefaultCsv(benchmarkDefaultKind(), "women");

    const menOurLookup = buildSubmissionLookup(menOurText, menMeta.season, new Set(menMeta.teamIds));
    const menBenchmarkLookup = buildSubmissionLookup(
      menBenchmarkText,
      menMeta.season,
      new Set(menMeta.teamIds),
    );
    const womenOurLookup = buildSubmissionLookup(
      womenOurText,
      womenMeta.season,
      new Set(womenMeta.teamIds),
    );
    const womenBenchmarkLookup = buildSubmissionLookup(
      womenBenchmarkText,
      womenMeta.season,
      new Set(womenMeta.teamIds),
    );

    const menAnalysis = buildAnalysis({
      metric: state.metric,
      context: menContext,
      ourLookup: menOurLookup,
      benchmarkLookup: menBenchmarkLookup,
      forecastMode: state.forecastMode,
      forecastWeightOurs: state.forecastWeightOurs,
      numSims: state.numSims,
      seed: state.seed,
    });
    const womenAnalysis = buildAnalysis({
      metric: state.metric,
      context: womenContext,
      ourLookup: womenOurLookup,
      benchmarkLookup: womenBenchmarkLookup,
      forecastMode: state.forecastMode,
      forecastWeightOurs: state.forecastWeightOurs,
      numSims: state.numSims,
      seed: state.seed + 1000,
    });

    let view;
    if (state.gender === "men") {
      view = {
        analysis: menAnalysis,
        context: menContext,
        ...menAnalysis,
        scope: "men",
        manualCount: menContext.manualCompletedSlots.size,
        rows: enrichRowsForScope(menAnalysis.rows, menAnalysis, null, menAnalysis.totalGames, "Men"),
      };
    } else if (state.gender === "women") {
      view = {
        analysis: womenAnalysis,
        context: womenContext,
        ...womenAnalysis,
        scope: "women",
        manualCount: womenContext.manualCompletedSlots.size,
        rows: enrichRowsForScope(
          womenAnalysis.rows,
          womenAnalysis,
          null,
          womenAnalysis.totalGames,
          "Women",
        ),
      };
    } else {
      const combined = combineAnalyses(menAnalysis, womenAnalysis);
      const totalGames = combined.totalGames;
      const menRows = enrichRowsForScope(
        menAnalysis.rows,
        menAnalysis,
        womenAnalysis,
        totalGames,
        "Men",
      );
      const womenRows = enrichRowsForScope(
        womenAnalysis.rows,
        womenAnalysis,
        menAnalysis,
        totalGames,
        "Women",
      );
      view = {
        ...combined,
        scope: "combined",
        manualCount: menContext.manualCompletedSlots.size + womenContext.manualCompletedSlots.size,
        rows: [...menRows, ...womenRows].sort(
          (a, b) =>
            a.round - b.round ||
            a.genderLabel.localeCompare(b.genderLabel) ||
            a.slot.localeCompare(b.slot),
        ),
        menAnalysis,
        womenAnalysis,
        menContext,
        womenContext,
      };
    }

    state.currentView = view;
    renderSummary(view);
    renderBrackets(view);
    renderTable(view);
    updateManualControls(view);
    updateStatus(`Updated using ${state.gender} ${state.metric} mode${view.manualCount ? ` · ${view.manualCount} manual` : ""}.`);
  } catch (error) {
    console.error(error);
    updateStatus(error.message, true);
  }
}

function bindEvents() {
  document.querySelectorAll("[data-gender]").forEach((button) => {
    button.addEventListener("click", async () => {
      document.querySelectorAll("[data-gender]").forEach((node) => node.dataset.active = "false");
      button.dataset.active = "true";
      state.gender = button.dataset.gender;
      await recompute();
    });
  });

  els.metric.addEventListener("change", async (event) => {
    state.metric = event.target.value;
    await recompute();
  });

  els.forecastMode.addEventListener("change", async (event) => {
    state.forecastMode = event.target.value;
    els.weightWrap.hidden = state.forecastMode !== "blend";
    await recompute();
  });

  els.weight.addEventListener("input", async (event) => {
    state.forecastWeightOurs = Number(event.target.value);
    els.weightValue.textContent = `${Math.round(state.forecastWeightOurs * 100)}% ours`;
    await recompute();
  });

  els.ourUpload.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    state.uploads.our = file ? await file.text() : null;
    persistState();
    await recompute();
  });

  els.benchmarkUpload.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    state.uploads.benchmark = file ? await file.text() : null;
    await recompute();
  });

  els.benchmarkSource.addEventListener("change", async (event) => {
    state.benchmarkSource = event.target.value;
    els.benchmarkUploadWrap.classList.toggle("is-hidden", state.benchmarkSource !== "upload");
    els.benchmarkUploadWrap.setAttribute(
      "aria-hidden",
      state.benchmarkSource !== "upload" ? "true" : "false",
    );
    persistState();
    await recompute();
  });

  els.reset.addEventListener("click", async () => {
    state.uploads.our = null;
    state.uploads.benchmark = null;
    state.benchmarkSource = "median";
    els.ourUpload.value = "";
    els.benchmarkUpload.value = "";
    els.benchmarkSource.value = "median";
    els.benchmarkUploadWrap.classList.add("is-hidden");
    els.benchmarkUploadWrap.setAttribute("aria-hidden", "true");
    persistState();
    await recompute();
  });

  els.undoManual.addEventListener("click", async () => {
    await undoManualResult();
  });

  els.clearManual.addEventListener("click", async () => {
    await clearManualResults();
  });

  els.tableWrap.addEventListener("click", (event) => {
    const button = event.target.closest("[data-sort-key]");
    if (!button) return;
    const key = button.dataset.sortKey;
    const config = SORT_CONFIG[key];
    if (!config) return;
    if (state.tableSort.key === key) {
      state.tableSort.dir = state.tableSort.dir === "asc" ? "desc" : "asc";
    } else {
      state.tableSort = { key, dir: config.defaultDir };
    }
    if (state.currentView) renderTable(state.currentView);
  });

  els.bracketWrap.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-pick-slot]");
    if (!button) return;
    await setManualWinner(
      button.dataset.pickGender,
      button.dataset.pickSlot,
      Number(button.dataset.pickTeam),
    );
  });
}

async function init() {
  restorePersistedState();

  Object.assign(els, {
    summary: document.querySelector("#summary"),
    bracketWrap: document.querySelector("#bracket-wrap"),
    tableWrap: document.querySelector("#table-wrap"),
    status: document.querySelector("#status"),
    metric: document.querySelector("#metric"),
    forecastMode: document.querySelector("#forecast-mode"),
    benchmarkSource: document.querySelector("#benchmark-source"),
    benchmarkUploadWrap: document.querySelector("#benchmark-upload-wrap"),
    manualSummary: document.querySelector("#manual-summary"),
    undoManual: document.querySelector("#undo-manual"),
    clearManual: document.querySelector("#clear-manual"),
    weightWrap: document.querySelector("#weight-wrap"),
    weight: document.querySelector("#weight"),
    weightValue: document.querySelector("#weight-value"),
    ourUpload: document.querySelector("#our-upload"),
    benchmarkUpload: document.querySelector("#benchmark-upload"),
    reset: document.querySelector("#reset-defaults"),
  });

  els.benchmarkSource.value = state.benchmarkSource;
  els.benchmarkUploadWrap.classList.toggle("is-hidden", state.benchmarkSource !== "upload");
  els.benchmarkUploadWrap.setAttribute(
    "aria-hidden",
    state.benchmarkSource !== "upload" ? "true" : "false",
  );

  state.manifest = await fetchJson("data/manifest.json");
  bindEvents();
  updateManualControls();
  await recompute();
  if (state.restoredFromStorage && state.uploads.our) {
    updateStatus("Using saved submission from this browser.");
  }
}

init();
