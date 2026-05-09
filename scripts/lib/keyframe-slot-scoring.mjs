export const metricIdentityWeights = new Map([
  ["health", 1.4],
  ["power", 1.4],
  ["currentGold", 1.35],
  ["movementSpeed", 1.25],
  ["minionsKilled", 1.0],
  ["jungleMinionsKilled", 1.0],
  ["totalGold", 0.75],
  ["xp", 0.75],
  ["level", 0.6],
  ["healthMax", 0.55],
  ["powerMax", 0.55],
]);

export function metricIdentityWeight(metric) {
  return metricIdentityWeights.get(metric) ?? 0.5;
}

export function enrichParticipantSlotEvidence(entry) {
  const metrics = [...new Set(entry.metrics ?? [])];
  const identityWeight = metrics.reduce((sum, metric) => sum + metricIdentityWeight(metric), 0);
  const identityMetricCount = metrics.filter((metric) => metricIdentityWeight(metric) >= 1).length;
  const genericMetricCount = metrics.length - identityMetricCount;
  const weightedSupportScore = (entry.support ?? []).reduce((sum, support) => {
    const score = typeof support.score === "number" && Number.isFinite(support.score) ? support.score : 0;
    return sum + metricIdentityWeight(support.metric) * score;
  }, 0);
  return {
    ...entry,
    identityWeight,
    identityMetricCount,
    genericMetricCount,
    weightedSupportScore,
  };
}
