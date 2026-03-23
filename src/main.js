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
  tableSort: {
    key: "displaySwing",
    dir: "desc",
  },
  currentView: null,
};

const els = {};

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
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}`);
  return response.text();
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}`);
  return response.json();
}

function fmtSigned(value, digits = 4) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function fmtPct(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function logoImg(context, teamId, alt, className = "team-logo") {
  const team = context.teamById.get(teamId);
  if (!team?.logoUrl) return "";
  return `<img class="${className}" src="${team.logoUrl}" alt="${alt}" loading="lazy" />`;
}

function metricLabel(metric) {
  return metric === "brier" ? "Brier" : "Log Loss";
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
  els.summary.innerHTML = `
    <div class="card">
      <div class="eyebrow">Games Scored So Far</div>
      <div class="big">${analysis.completedCount}</div>
      <div class="muted">${analysis.remainingCount} remaining of ${analysis.totalGames}</div>
    </div>
    <div class="card">
      <div class="eyebrow">Your ${metricLabel(state.metric)} So Far</div>
      <div class="big">${analysis.ourCurrentAverage.toFixed(4)}</div>
      <div class="muted">Expert: ${analysis.benchmarkCurrentAverage.toFixed(4)}</div>
    </div>
    <div class="card">
      <div class="eyebrow">Projected Final ${metricLabel(state.metric)}</div>
      <div class="big">${analysis.ourExpectedFinalAverage.toFixed(4)}</div>
      <div class="muted">Expert: ${analysis.benchmarkExpectedFinalAverage.toFixed(4)}</div>
    </div>
    <div class="card">
      <div class="eyebrow">Projected Final Edge</div>
      <div class="big">${fmtSigned(analysis.expectedFinalEdgeAverage)}</div>
      <div class="muted">Expert ${metricLabel(state.metric)} minus yours. Positive is good.</div>
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
    <div class="list-card">
      <div class="section-head">
        <div>
          <div class="eyebrow">Largest Brier Swings</div>
          <h2>Who To Root For</h2>
        </div>
        <div class="metric-legend">
          <div><strong>Brier Gain</strong>: how much this result improves your expected final Brier edge versus the other winner.</div>
          <div><strong>Ceiling Swing</strong>: difference in best-case Brier edge between the two winners. Positive favors the team you should root for; negative favors the other side on pure upside.</div>
          <div><strong>Expected Final Brier Edge</strong>: expected expert-minus-you Brier if this team wins, averaging over the rest of the bracket.</div>
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
              <th>${sortableHeader("Expert Prob", "benchmarkRootForProb")}</th>
              <th>${sortableHeader("Expected Final Brier Edge", "finalGapIfRootForWins")}</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>
  `;
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

function renderTeamLine(name, modifier = "") {
  return `<div class="team-line ${modifier}">${name}</div>`;
}

function renderTeamLineWithLogo(context, teamId, name, modifier = "") {
  return `
    <div class="team-line ${modifier}">
      ${logoImg(context, teamId, name)}
      <span>${name}</span>
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
      <span class="legend-item"><span class="legend-swatch winner"></span> Already advanced</span>
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

  let first = displayToken(strong, context);
  let second = displayToken(weak, context);
  let firstClass = "";
  let secondClass = "";
  let badge = "Future";

  const knownParticipants = slotParticipantsIfKnown(slot, context, context.completedSlots);
  if (knownParticipants) {
    [first, second] = knownParticipants.map((teamId) => context.teamNameById.get(teamId));
  }

  if (completedWinner != null && knownParticipants) {
    badge = "Completed";
    firstClass = knownParticipants[0] === completedWinner ? "winner" : "loser";
    secondClass = knownParticipants[1] === completedWinner ? "winner" : "loser";
  } else if (row) {
    badge = `Root for ${row.cheerForName}`;
    firstClass = row.teamA === row.cheerFor ? "recommended" : "fade";
    secondClass = row.teamB === row.cheerFor ? "recommended" : "fade";
  }

  return `
    <article class="bracket-card ${completedWinner != null ? "completed" : row ? "open" : "future"}">
      <div class="bracket-head">
        <span class="slot">${slot}</span>
        <span class="badge">${badge}</span>
      </div>
      ${
        knownParticipants
          ? renderTeamLineWithLogo(context, knownParticipants[0], first, firstClass)
          : renderTeamLine(first, firstClass)
      }
      ${
        knownParticipants
          ? renderTeamLineWithLogo(context, knownParticipants[1], second, secondClass)
          : renderTeamLine(second, secondClass)
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
          <div class="round-column">
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
              <div class="round-column">
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
          <div class="eyebrow">Bracket View</div>
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
          <div class="round-column">
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
          <div class="eyebrow">${title}</div>
          <h2>${title} Bracket</h2>
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
                    <div class="round-column">
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

async function recompute() {
  try {
    updateStatus("Recomputing…");
    const menMeta = await getMeta("men");
    const womenMeta = await getMeta("women");
    const menContext = buildContext(menMeta);
    const womenContext = buildContext(womenMeta);
    const ourUploadText = state.uploads.our;
    const benchmarkUploadText = state.uploads.benchmark;

    const menOurText = ourUploadText || await getDefaultCsv("ourDefault", "men");
    const menBenchmarkText = benchmarkUploadText || await getDefaultCsv("benchmarkDefault", "men");
    const womenOurText = ourUploadText || await getDefaultCsv("ourDefault", "women");
    const womenBenchmarkText = benchmarkUploadText || await getDefaultCsv("benchmarkDefault", "women");

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
        scope: "men",
        analysis: menAnalysis,
        context: menContext,
        rows: enrichRowsForScope(menAnalysis.rows, menAnalysis, null, menAnalysis.totalGames, "Men"),
        ...menAnalysis,
      };
    } else if (state.gender === "women") {
      view = {
        scope: "women",
        analysis: womenAnalysis,
        context: womenContext,
        rows: enrichRowsForScope(
          womenAnalysis.rows,
          womenAnalysis,
          null,
          womenAnalysis.totalGames,
          "Women",
        ),
        ...womenAnalysis,
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
    updateStatus(`Updated using ${state.gender} ${state.metric} mode.`);
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
    await recompute();
  });

  els.benchmarkUpload.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    state.uploads.benchmark = file ? await file.text() : null;
    await recompute();
  });

  els.reset.addEventListener("click", async () => {
    state.uploads.our = null;
    state.uploads.benchmark = null;
    els.ourUpload.value = "";
    els.benchmarkUpload.value = "";
    await recompute();
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
}

async function init() {
  Object.assign(els, {
    summary: document.querySelector("#summary"),
    bracketWrap: document.querySelector("#bracket-wrap"),
    tableWrap: document.querySelector("#table-wrap"),
    status: document.querySelector("#status"),
    metric: document.querySelector("#metric"),
    forecastMode: document.querySelector("#forecast-mode"),
    weightWrap: document.querySelector("#weight-wrap"),
    weight: document.querySelector("#weight"),
    weightValue: document.querySelector("#weight-value"),
    ourUpload: document.querySelector("#our-upload"),
    benchmarkUpload: document.querySelector("#benchmark-upload"),
    reset: document.querySelector("#reset-defaults"),
  });

  state.manifest = await fetchJson("data/manifest.json");
  bindEvents();
  await recompute();
}

init();
