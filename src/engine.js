const EPS = 1e-12;

function clipProb(p) {
  return Math.min(Math.max(p, EPS), 1 - EPS);
}

function pairKey(teamA, teamB) {
  return teamA < teamB ? `${teamA}_${teamB}` : `${teamB}_${teamA}`;
}

function winnerIsLower(teamA, teamB, winner) {
  return winner === Math.min(teamA, teamB);
}

export function parseCsv(text) {
  const lines = text.replace(/\r/g, "").trim().split("\n");
  if (!lines.length) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).filter(Boolean).map((line) => {
    const parts = line.split(",");
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = parts[idx] ?? "";
    });
    return row;
  });
}

export function buildSubmissionLookup(text, season, validTeamIds) {
  const lookup = new Map();
  const rows = parseCsv(text);
  for (const row of rows) {
    const [seasonStr, aStr, bStr] = row.ID.split("_");
    if (Number(seasonStr) !== season) continue;
    const a = Number(aStr);
    const b = Number(bStr);
    if (!validTeamIds.has(a) || !validTeamIds.has(b)) continue;
    const p = Number(row.Pred);
    lookup.set(pairKey(a, b), a < b ? p : 1 - p);
  }
  return lookup;
}

export function roundFromSlot(slot) {
  const match = /^R(\d+)/.exec(slot);
  return match ? Number(match[1]) : 0;
}

function scoreLoss(metric, pLowerWins, winnerLower) {
  const p = clipProb(pLowerWins);
  if (metric === "logloss") {
    return -Math.log(winnerLower ? p : 1 - p);
  }
  const y = winnerLower ? 1 : 0;
  return (p - y) ** 2;
}

function gameEdge(metric, teamA, teamB, winner, ourLookup, benchmarkLookup) {
  const key = pairKey(teamA, teamB);
  const pOurs = ourLookup.get(key);
  const pBench = benchmarkLookup.get(key);
  const winnerLower = winnerIsLower(teamA, teamB, winner);
  return (
    scoreLoss(metric, pBench, winnerLower) -
    scoreLoss(metric, pOurs, winnerLower)
  );
}

function forecastProb(teamA, teamB, lookup) {
  const key = pairKey(teamA, teamB);
  const pLower = lookup.get(key);
  if (pLower == null) throw new Error(`Missing prediction for ${teamA} vs ${teamB}`);
  return teamA < teamB ? pLower : 1 - pLower;
}

function submissionProb(teamA, teamB, lookup) {
  return forecastProb(teamA, teamB, lookup);
}

function sortSlots(slots) {
  return [...slots].sort((a, b) => {
    const roundDiff = roundFromSlot(a.slot) - roundFromSlot(b.slot);
    return roundDiff || a.slot.localeCompare(b.slot);
  });
}

export function buildContext(meta) {
  const teamById = new Map(meta.teams.map((team) => [team.id, team]));
  const teamNameById = new Map(meta.teams.map((team) => [team.id, team.name]));
  const seedToTeam = new Map(meta.seeds.map((row) => [row.seed, row.teamId]));
  const slotRows = new Map(meta.slots.map((row) => [row.slot, [row.strong, row.weak]]));
  const completedSlots = new Map(Object.entries(meta.resolvedSlots));
  const scoringSlots = sortSlots(meta.slots)
    .map((row) => row.slot)
    .filter((slot) => roundFromSlot(slot) >= 1);
  return {
    gender: meta.gender,
    season: meta.season,
    allSlots: sortSlots(meta.slots).map((row) => row.slot),
    scoringSlots,
    teamById,
    teamNameById,
    seedToTeam,
    slotRows,
    completedSlots,
    totalGames: scoringSlots.length,
  };
}

function deterministicTeam(token, context, completedSlots) {
  if (context.seedToTeam.has(token)) return context.seedToTeam.get(token);
  if (completedSlots.has(token)) return completedSlots.get(token);
  return null;
}

export function slotParticipantsIfKnown(slot, context, completedSlots) {
  const pair = context.slotRows.get(slot);
  if (!pair) return null;
  const [strong, weak] = pair;
  const teamA = deterministicTeam(strong, context, completedSlots);
  const teamB = deterministicTeam(weak, context, completedSlots);
  if (teamA == null || teamB == null) return null;
  return [teamA, teamB];
}

function openSlotsWithKnownParticipants(context, completedSlots) {
  return context.scoringSlots.filter((slot) => {
    if (completedSlots.has(slot)) return false;
    return slotParticipantsIfKnown(slot, context, completedSlots) != null;
  });
}

function completedGameList(context, completedSlots) {
  return context.scoringSlots
    .filter((slot) => completedSlots.has(slot))
    .map((slot) => {
      const participants = slotParticipantsIfKnown(slot, context, completedSlots);
      if (!participants) return null;
      return {
        slot,
        teamA: participants[0],
        teamB: participants[1],
        winner: completedSlots.get(slot),
      };
    })
    .filter(Boolean);
}

function currentEdgeSoFar(metric, context, ourLookup, benchmarkLookup) {
  let edge = 0;
  for (const game of completedGameList(context, context.completedSlots)) {
    edge += gameEdge(metric, game.teamA, game.teamB, game.winner, ourLookup, benchmarkLookup);
  }
  return edge;
}

function currentLossSoFar(metric, context, predictionLookup) {
  let loss = 0;
  for (const game of completedGameList(context, context.completedSlots)) {
    const key = pairKey(game.teamA, game.teamB);
    const p = predictionLookup.get(key);
    loss += scoreLoss(metric, p, winnerIsLower(game.teamA, game.teamB, game.winner));
  }
  return loss;
}

function solveExpectedEdge({
  token,
  metric,
  context,
  completedSlots,
  forcedSlots,
  forecastLookup,
  ourLookup,
  benchmarkLookup,
  cache,
}) {
  const forceKey = JSON.stringify([...forcedSlots.entries()].sort());
  const cacheKey = `${token}|${forceKey}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  if (context.seedToTeam.has(token)) {
    const teamId = context.seedToTeam.get(token);
    const out = { probs: new Map([[teamId, 1]]), edgeGivenWinner: new Map([[teamId, 0]]) };
    cache.set(cacheKey, out);
    return out;
  }

  if (completedSlots.has(token)) {
    const teamId = completedSlots.get(token);
    const out = { probs: new Map([[teamId, 1]]), edgeGivenWinner: new Map([[teamId, 0]]) };
    cache.set(cacheKey, out);
    return out;
  }

  const [strong, weak] = context.slotRows.get(token);
  const left = solveExpectedEdge({
    token: strong,
    metric,
    context,
    completedSlots,
    forcedSlots,
    forecastLookup,
    ourLookup,
    benchmarkLookup,
    cache,
  });
  const right = solveExpectedEdge({
    token: weak,
    metric,
    context,
    completedSlots,
    forcedSlots,
    forecastLookup,
    ourLookup,
    benchmarkLookup,
    cache,
  });

  const totalProb = new Map();
  const totalEdgeNum = new Map();
  for (const [teamA, probA] of left.probs.entries()) {
    for (const [teamB, probB] of right.probs.entries()) {
      const pairProb = probA * probB;
      if (pairProb <= 0) continue;
      const baseEdge = left.edgeGivenWinner.get(teamA) + right.edgeGivenWinner.get(teamB);

      if (forcedSlots.has(token)) {
        const forcedWinner = forcedSlots.get(token);
        if (forcedWinner !== teamA && forcedWinner !== teamB) continue;
        const edge = gameEdge(metric, teamA, teamB, forcedWinner, ourLookup, benchmarkLookup);
        totalProb.set(forcedWinner, (totalProb.get(forcedWinner) || 0) + pairProb);
        totalEdgeNum.set(
          forcedWinner,
          (totalEdgeNum.get(forcedWinner) || 0) + pairProb * (baseEdge + edge),
        );
        continue;
      }

      const pA = forecastProb(teamA, teamB, forecastLookup);
      const pB = 1 - pA;
      const edgeA = gameEdge(metric, teamA, teamB, teamA, ourLookup, benchmarkLookup);
      const edgeB = gameEdge(metric, teamA, teamB, teamB, ourLookup, benchmarkLookup);

      totalProb.set(teamA, (totalProb.get(teamA) || 0) + pairProb * pA);
      totalEdgeNum.set(teamA, (totalEdgeNum.get(teamA) || 0) + pairProb * pA * (baseEdge + edgeA));
      totalProb.set(teamB, (totalProb.get(teamB) || 0) + pairProb * pB);
      totalEdgeNum.set(teamB, (totalEdgeNum.get(teamB) || 0) + pairProb * pB * (baseEdge + edgeB));
    }
  }

  const edgeGivenWinner = new Map();
  for (const [teamId, prob] of totalProb.entries()) {
    edgeGivenWinner.set(teamId, totalEdgeNum.get(teamId) / prob);
  }
  const out = { probs: totalProb, edgeGivenWinner };
  cache.set(cacheKey, out);
  return out;
}

function expectedRemainingEdge({
  metric,
  context,
  forecastLookup,
  ourLookup,
  benchmarkLookup,
  forcedSlots = new Map(),
}) {
  const cache = new Map();
  const summary = solveExpectedEdge({
    token: "R6CH",
    metric,
    context,
    completedSlots: context.completedSlots,
    forcedSlots,
    forecastLookup,
    ourLookup,
    benchmarkLookup,
    cache,
  });
  let total = 0;
  for (const [teamId, prob] of summary.probs.entries()) {
    total += prob * summary.edgeGivenWinner.get(teamId);
  }
  return total;
}

function solveEdgeExtrema({
  token,
  metric,
  context,
  completedSlots,
  forcedSlots,
  ourLookup,
  benchmarkLookup,
  cache,
}) {
  const forceKey = JSON.stringify([...forcedSlots.entries()].sort());
  const cacheKey = `${token}|${forceKey}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  if (context.seedToTeam.has(token)) {
    const teamId = context.seedToTeam.get(token);
    const out = { best: new Map([[teamId, 0]]), worst: new Map([[teamId, 0]]) };
    cache.set(cacheKey, out);
    return out;
  }

  if (completedSlots.has(token)) {
    const teamId = completedSlots.get(token);
    const out = { best: new Map([[teamId, 0]]), worst: new Map([[teamId, 0]]) };
    cache.set(cacheKey, out);
    return out;
  }

  const [strong, weak] = context.slotRows.get(token);
  const left = solveEdgeExtrema({
    token: strong,
    metric,
    context,
    completedSlots,
    forcedSlots,
    ourLookup,
    benchmarkLookup,
    cache,
  });
  const right = solveEdgeExtrema({
    token: weak,
    metric,
    context,
    completedSlots,
    forcedSlots,
    ourLookup,
    benchmarkLookup,
    cache,
  });

  const best = new Map();
  const worst = new Map();
  for (const [teamA, leftBest] of left.best.entries()) {
    for (const [teamB, rightBest] of right.best.entries()) {
      const baseBest = leftBest + rightBest;
      const baseWorst = left.worst.get(teamA) + right.worst.get(teamB);

      if (forcedSlots.has(token)) {
        const forcedWinner = forcedSlots.get(token);
        if (forcedWinner !== teamA && forcedWinner !== teamB) continue;
        const edge = gameEdge(metric, teamA, teamB, forcedWinner, ourLookup, benchmarkLookup);
        best.set(forcedWinner, Math.max(best.get(forcedWinner) ?? -Infinity, baseBest + edge));
        worst.set(forcedWinner, Math.min(worst.get(forcedWinner) ?? Infinity, baseWorst + edge));
        continue;
      }

      const edgeA = gameEdge(metric, teamA, teamB, teamA, ourLookup, benchmarkLookup);
      const edgeB = gameEdge(metric, teamA, teamB, teamB, ourLookup, benchmarkLookup);

      best.set(teamA, Math.max(best.get(teamA) ?? -Infinity, baseBest + edgeA));
      worst.set(teamA, Math.min(worst.get(teamA) ?? Infinity, baseWorst + edgeA));
      best.set(teamB, Math.max(best.get(teamB) ?? -Infinity, baseBest + edgeB));
      worst.set(teamB, Math.min(worst.get(teamB) ?? Infinity, baseWorst + edgeB));
    }
  }

  const out = { best, worst };
  cache.set(cacheKey, out);
  return out;
}

function remainingEdgeExtrema({
  metric,
  context,
  ourLookup,
  benchmarkLookup,
  forcedSlots = new Map(),
}) {
  const summary = solveEdgeExtrema({
    token: "R6CH",
    metric,
    context,
    completedSlots: context.completedSlots,
    forcedSlots,
    ourLookup,
    benchmarkLookup,
    cache: new Map(),
  });
  return {
    best: Math.max(...summary.best.values()),
    worst: Math.min(...summary.worst.values()),
  };
}

function expectedRemainingLoss({
  token,
  metric,
  context,
  completedSlots,
  forcedSlots,
  forecastLookup,
  predictionLookup,
  cache,
}) {
  const forceKey = JSON.stringify([...forcedSlots.entries()].sort());
  const cacheKey = `${token}|${forceKey}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  if (context.seedToTeam.has(token) || completedSlots.has(token)) {
    cache.set(cacheKey, 0);
    return 0;
  }

  const [strong, weak] = context.slotRows.get(token);
  const leftLoss = expectedRemainingLoss({
    token: strong,
    metric,
    context,
    completedSlots,
    forcedSlots,
    forecastLookup,
    predictionLookup,
    cache,
  });
  const rightLoss = expectedRemainingLoss({
    token: weak,
    metric,
    context,
    completedSlots,
    forcedSlots,
    forecastLookup,
    predictionLookup,
    cache,
  });

  const leftSummary = solveExpectedEdge({
    token: strong,
    metric,
    context,
    completedSlots,
    forcedSlots: new Map(),
    forecastLookup,
    ourLookup: predictionLookup,
    benchmarkLookup: predictionLookup,
    cache: new Map(),
  });
  const rightSummary = solveExpectedEdge({
    token: weak,
    metric,
    context,
    completedSlots,
    forcedSlots: new Map(),
    forecastLookup,
    ourLookup: predictionLookup,
    benchmarkLookup: predictionLookup,
    cache: new Map(),
  });

  let expectedGameLoss = 0;
  for (const [teamA, probA] of leftSummary.probs.entries()) {
    for (const [teamB, probB] of rightSummary.probs.entries()) {
      const pairProb = probA * probB;
      if (pairProb <= 0) continue;
      if (forcedSlots.has(token)) {
        const forcedWinner = forcedSlots.get(token);
        if (forcedWinner !== teamA && forcedWinner !== teamB) continue;
        expectedGameLoss +=
          pairProb *
          scoreLoss(metric, predictionLookup.get(pairKey(teamA, teamB)), winnerIsLower(teamA, teamB, forcedWinner));
        continue;
      }
      const pA = forecastProb(teamA, teamB, forecastLookup);
      expectedGameLoss +=
        pairProb *
        (
          pA * scoreLoss(metric, predictionLookup.get(pairKey(teamA, teamB)), winnerIsLower(teamA, teamB, teamA)) +
          (1 - pA) *
            scoreLoss(metric, predictionLookup.get(pairKey(teamA, teamB)), winnerIsLower(teamA, teamB, teamB))
        );
    }
  }

  const total = leftLoss + rightLoss + expectedGameLoss;
  cache.set(cacheKey, total);
  return total;
}

function simulateRemainingOnce({
  metric,
  context,
  forecastLookup,
  ourLookup,
  benchmarkLookup,
  forcedSlots,
  rng,
}) {
  const winners = new Map();
  let edge = 0;

  const resolve = (token) => {
    if (context.seedToTeam.has(token)) return context.seedToTeam.get(token);
    if (winners.has(token)) return winners.get(token);
    if (context.completedSlots.has(token)) {
      winners.set(token, context.completedSlots.get(token));
      return winners.get(token);
    }

    const [strong, weak] = context.slotRows.get(token);
    const teamA = resolve(strong);
    const teamB = resolve(weak);
    let winner;
    if (forcedSlots.has(token)) {
      winner = forcedSlots.get(token);
    } else {
      winner = rng() < forecastProb(teamA, teamB, forecastLookup) ? teamA : teamB;
    }
    edge += gameEdge(metric, teamA, teamB, winner, ourLookup, benchmarkLookup);
    winners.set(token, winner);
    return winner;
  };

  resolve("R6CH");
  return edge;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function estimateBeatProbability({
  metric,
  context,
  forecastLookup,
  ourLookup,
  benchmarkLookup,
  forcedSlots,
  currentEdge,
  numSims,
  seed,
}) {
  const rng = mulberry32(seed);
  let wins = 0;
  for (let i = 0; i < numSims; i += 1) {
    const totalEdge = currentEdge + simulateRemainingOnce({
      metric,
      context,
      forecastLookup,
      ourLookup,
      benchmarkLookup,
      forcedSlots,
      rng,
    });
    if (totalEdge > 0) wins += 1;
  }
  return wins / numSims;
}

export function buildForecastLookup(mode, ourLookup, benchmarkLookup, weightOurs = 0.5) {
  if (mode === "ours") return new Map(ourLookup);
  if (mode === "benchmark") return new Map(benchmarkLookup);
  const out = new Map();
  for (const [key, p] of ourLookup.entries()) {
    out.set(key, weightOurs * p + (1 - weightOurs) * benchmarkLookup.get(key));
  }
  return out;
}

export function buildAnalysis({
  metric,
  context,
  ourLookup,
  benchmarkLookup,
  forecastMode,
  forecastWeightOurs,
  numSims,
  seed,
}) {
  const forecastLookup = buildForecastLookup(forecastMode, ourLookup, benchmarkLookup, forecastWeightOurs);
  const currentEdge = currentEdgeSoFar(metric, context, ourLookup, benchmarkLookup);
  const ourCurrentLoss = currentLossSoFar(metric, context, ourLookup);
  const benchmarkCurrentLoss = currentLossSoFar(metric, context, benchmarkLookup);
  const completedCount = completedGameList(context, context.completedSlots).length;
  const remainingCount = context.totalGames - completedCount;
  const ourRemainingLoss = expectedRemainingLoss({
    token: "R6CH",
    metric,
    context,
    completedSlots: context.completedSlots,
    forcedSlots: new Map(),
    forecastLookup,
    predictionLookup: ourLookup,
    cache: new Map(),
  });
  const benchmarkRemainingLoss = expectedRemainingLoss({
    token: "R6CH",
    metric,
    context,
    completedSlots: context.completedSlots,
    forcedSlots: new Map(),
    forecastLookup,
    predictionLookup: benchmarkLookup,
    cache: new Map(),
  });

  const openSlots = openSlotsWithKnownParticipants(context, context.completedSlots);
  const overallExtrema = remainingEdgeExtrema({
    metric,
    context,
    ourLookup,
    benchmarkLookup,
    forcedSlots: new Map(),
  });
  const rows = openSlots.map((slot, idx) => {
    const [teamA, teamB] = slotParticipantsIfKnown(slot, context, context.completedSlots);
    const forcedA = new Map([[slot, teamA]]);
    const forcedB = new Map([[slot, teamB]]);
    const remainingEdgeA = expectedRemainingEdge({
      metric,
      context,
      forecastLookup,
      ourLookup,
      benchmarkLookup,
      forcedSlots: forcedA,
    });
    const remainingEdgeB = expectedRemainingEdge({
      metric,
      context,
      forecastLookup,
      ourLookup,
      benchmarkLookup,
      forcedSlots: forcedB,
    });
    const extremaA = remainingEdgeExtrema({
      metric,
      context,
      ourLookup,
      benchmarkLookup,
      forcedSlots: forcedA,
    });
    const extremaB = remainingEdgeExtrema({
      metric,
      context,
      ourLookup,
      benchmarkLookup,
      forcedSlots: forcedB,
    });
    const beatA = estimateBeatProbability({
      metric,
      context,
      forecastLookup,
      ourLookup,
      benchmarkLookup,
      forcedSlots: forcedA,
      currentEdge,
      numSims,
      seed: seed + idx * 2,
    });
    const beatB = estimateBeatProbability({
      metric,
      context,
      forecastLookup,
      ourLookup,
      benchmarkLookup,
      forcedSlots: forcedB,
      currentEdge,
      numSims,
      seed: seed + idx * 2 + 1,
    });
    const cheerFor = remainingEdgeA >= remainingEdgeB ? teamA : teamB;
    return {
      slot,
      round: roundFromSlot(slot),
      teamA,
      teamAName: context.teamNameById.get(teamA),
      teamB,
      teamBName: context.teamNameById.get(teamB),
      forecastProbTeamA: forecastProb(teamA, teamB, forecastLookup),
      ourProbTeamA: submissionProb(teamA, teamB, ourLookup),
      benchmarkProbTeamA: submissionProb(teamA, teamB, benchmarkLookup),
      expectedFinalEdgeIfTeamAWins: currentEdge + remainingEdgeA,
      expectedFinalEdgeIfTeamBWins: currentEdge + remainingEdgeB,
      bestFinalEdgeIfTeamAWins: currentEdge + extremaA.best,
      bestFinalEdgeIfTeamBWins: currentEdge + extremaB.best,
      worstFinalEdgeIfTeamAWins: currentEdge + extremaA.worst,
      worstFinalEdgeIfTeamBWins: currentEdge + extremaB.worst,
      beatProbIfTeamAWins: beatA,
      beatProbIfTeamBWins: beatB,
      cheerFor,
      cheerForName: context.teamNameById.get(cheerFor),
      cheerEdgeGain: Math.abs(remainingEdgeA - remainingEdgeB),
      cheerBeatProbGain: Math.abs(beatA - beatB),
    };
  });

  rows.sort((a, b) => a.round - b.round || a.slot.localeCompare(b.slot));

  const beatProbNow = estimateBeatProbability({
    metric,
    context,
    forecastLookup,
    ourLookup,
    benchmarkLookup,
    forcedSlots: new Map(),
    currentEdge,
    numSims,
    seed: seed + 100000,
  });

  return {
    metric,
    completedCount,
    remainingCount,
    totalGames: context.totalGames,
    currentEdge,
    ourCurrentLossTotal: ourCurrentLoss,
    benchmarkCurrentLossTotal: benchmarkCurrentLoss,
    ourExpectedFinalLossTotal: ourCurrentLoss + ourRemainingLoss,
    benchmarkExpectedFinalLossTotal: benchmarkCurrentLoss + benchmarkRemainingLoss,
    expectedFinalEdgeTotal:
      benchmarkCurrentLoss + benchmarkRemainingLoss - ourCurrentLoss - ourRemainingLoss,
    bestPossibleFinalEdgeTotal: currentEdge + overallExtrema.best,
    worstPossibleFinalEdgeTotal: currentEdge + overallExtrema.worst,
    ourCurrentAverage: completedCount ? ourCurrentLoss / completedCount : 0,
    benchmarkCurrentAverage: completedCount ? benchmarkCurrentLoss / completedCount : 0,
    ourExpectedFinalAverage: (ourCurrentLoss + ourRemainingLoss) / context.totalGames,
    benchmarkExpectedFinalAverage: (benchmarkCurrentLoss + benchmarkRemainingLoss) / context.totalGames,
    expectedFinalEdgeAverage:
      (benchmarkCurrentLoss + benchmarkRemainingLoss - ourCurrentLoss - ourRemainingLoss) /
      context.totalGames,
    beatProbNow,
    rows,
  };
}
