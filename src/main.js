import { buildAnalysis, buildContext, buildSubmissionLookup } from "./engine.js";

const state = {
  manifest: null,
  gender: "men",
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
};

const els = {};

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

function metricLabel(metric) {
  return metric === "brier" ? "Brier" : "Log Loss";
}

function renderSummary(analysis) {
  const lowerIsBetter = analysis.metric !== "edge";
  els.summary.innerHTML = `
    <div class="card">
      <div class="eyebrow">Completed Games</div>
      <div class="big">${analysis.completedCount}</div>
      <div class="muted">${analysis.remainingCount} left</div>
    </div>
    <div class="card">
      <div class="eyebrow">Current ${metricLabel(state.metric)}</div>
      <div class="big">${analysis.ourCurrentAverage.toFixed(4)}</div>
      <div class="muted">Expert ${analysis.benchmarkCurrentAverage.toFixed(4)}</div>
    </div>
    <div class="card">
      <div class="eyebrow">Expected Final Gap</div>
      <div class="big">${fmtSigned(analysis.expectedFinalEdgeAverage)}</div>
      <div class="muted">Benchmark minus us</div>
    </div>
    <div class="card">
      <div class="eyebrow">Chance We Finish Ahead</div>
      <div class="big">${fmtPct(analysis.beatProbNow)}</div>
      <div class="muted">vs current benchmark</div>
    </div>
  `;
}

function renderTable(analysis) {
  if (!analysis.rows.length) {
    els.tableWrap.innerHTML = `<div class="empty">No open games with known participants.</div>`;
    return;
  }

  const strongest = [...analysis.rows]
    .sort((a, b) => b.cheerEdgeGain - a.cheerEdgeGain)
    .slice(0, 3)
    .map((row) => `<li><strong>${row.cheerForName}</strong> in ${row.teamAName} vs ${row.teamBName} <span>${fmtSigned(row.cheerEdgeGain)}</span></li>`)
    .join("");

  const rowsHtml = analysis.rows
    .map((row) => `
      <tr>
        <td><span class="slot">${row.slot}</span></td>
        <td>
          <div class="game">${row.teamAName} vs ${row.teamBName}</div>
          <div class="muted">${row.round === 2 ? "Round of 32" : row.round === 3 ? "Sweet 16" : `Round ${row.round}`}</div>
        </td>
        <td>${fmtPct(row.ourProbTeamA)}</td>
        <td>${fmtPct(row.benchmarkProbTeamA)}</td>
        <td><strong>${row.cheerForName}</strong></td>
        <td>${fmtSigned(row.expectedFinalEdgeIfTeamAWins)}</td>
        <td>${fmtSigned(row.expectedFinalEdgeIfTeamBWins)}</td>
        <td>${fmtPct(row.beatProbIfTeamAWins)}</td>
        <td>${fmtPct(row.beatProbIfTeamBWins)}</td>
      </tr>
    `)
    .join("");

  els.tableWrap.innerHTML = `
    <div class="list-card">
      <div class="section-head">
        <div>
          <div class="eyebrow">Strongest Swing Games</div>
          <h2>Who To Root For</h2>
        </div>
        <ul class="swing-list">${strongest}</ul>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Slot</th>
              <th>Game</th>
              <th>Our Prob (A)</th>
              <th>Expert Prob (A)</th>
              <th>Root For</th>
              <th>Final Gap if A Wins</th>
              <th>Final Gap if B Wins</th>
              <th>Beat Prob if A Wins</th>
              <th>Beat Prob if B Wins</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>
  `;
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
    const gender = state.gender;
    const meta = await getMeta(gender);
    const context = buildContext(meta);
    const validTeamIds = new Set(meta.teamIds);
    const ourText = state.uploads.our || await getDefaultCsv("ourDefault", gender);
    const benchmarkText = state.uploads.benchmark || await getDefaultCsv("benchmarkDefault", gender);
    const ourLookup = buildSubmissionLookup(ourText, meta.season, validTeamIds);
    const benchmarkLookup = buildSubmissionLookup(benchmarkText, meta.season, validTeamIds);
    const analysis = buildAnalysis({
      metric: state.metric,
      context,
      ourLookup,
      benchmarkLookup,
      forecastMode: state.forecastMode,
      forecastWeightOurs: state.forecastWeightOurs,
      numSims: state.numSims,
      seed: state.seed,
    });
    renderSummary(analysis);
    renderTable(analysis);
    updateStatus(`Updated using ${gender} ${state.metric} mode.`);
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
}

async function init() {
  Object.assign(els, {
    summary: document.querySelector("#summary"),
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
