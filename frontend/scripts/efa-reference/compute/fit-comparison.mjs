// Shared numerical verifier. Sign/permutation matching only; tolerances are
// unchanged from the retained full-size comparison and its rejection tests.
export function createFitComparator(matchFactors) {
const maximumError = (reference, candidate) => {
  if (!Array.isArray(reference) || !Array.isArray(candidate) || reference.length !== candidate.length) throw new Error('Numerical output dimensions differ');
  let error = 0;
  for (let i = 0; i < reference.length; i++) {
    if (Array.isArray(reference[i])) error = Math.max(error, maximumError(reference[i], candidate[i]));
    else {
      if (!Number.isFinite(reference[i]) || !Number.isFinite(candidate[i])) throw new Error('Missing or non-finite numerical output');
      error = Math.max(error, Math.abs(reference[i] - candidate[i]));
    }
  }
  return error;
};
const common = rotation => rotation.structure.map(row => rotation.pattern.map(other => row.reduce((sum, value, k) => sum + value * other[k], 0)));
function validateFit(fit) {
  const { rows: n, items: p, factors: k } = fit.dimensions ?? {};
  if (fit.executionStatus !== 'completed' || ![n, p, k].every(Number.isSafeInteger) || n < 2 || k < 1 || p <= k) throw new Error('Missing completed fit or valid dimensions');
  const convergence = fit.extractionConvergence;
  if (convergence && (convergence.converged !== true || !Number.isInteger(convergence.iterations) || convergence.iterations < 0 || !Number.isFinite(convergence.objective) || convergence.objective < 0 || !Number.isFinite(convergence.gradient) || convergence.gradient < 0)) throw new Error('Invalid extraction convergence');
  const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
  const matrix = (value, rows, cols) => Array.isArray(value) && value.length === rows && value.every(row => vector(row, cols));
  const df = p * (p - 1) / 2 - (p * k - k * (k - 1) / 2);
  if (fit.test?.df !== df || df <= 0 || fit.test.denominator !== n - 1) throw new Error('Invalid degrees of freedom or inference denominator');
  if (!['rawStatistic', 'trace', 'traceSquared', 'scalingFactor', 'shift', 'statistic', 'pValue'].every(key => Number.isFinite(fit.test[key])) || fit.test.rawStatistic < 0 || fit.test.trace <= 0 || fit.test.traceSquared <= 0 || fit.test.scalingFactor <= 0 || fit.test.statistic < 0 || fit.test.pValue < 0 || fit.test.pValue > 1) throw new Error('Invalid robust inference outputs');
  for (const method of ['oblimin', 'promax', 'varimax']) {
    const r = fit.rotations?.[method];
    if (!r?.convergence?.converged || !matrix(r.pattern, p, k) || !matrix(r.structure, p, k) || !matrix(r.phi, k, k) || !vector(r.communalities, p)) throw new Error(`Incomplete ${method} rotation`);
    const se = r.standardErrors;
    if (!se || !matrix(se.pattern, p, k) || !matrix(se.structure, p, k) || !matrix(se.phi, k, k) || !vector(se.communalities, p) || !vector(se.uniquenesses, p)) throw new Error(`Incomplete ${method} uncertainty`);
    if ([...se.pattern.flat(), ...se.structure.flat(), ...se.phi.flat(), ...se.communalities, ...se.uniquenesses].some(value => value < 0)) throw new Error(`Negative ${method} standard error`);
  }
  const r = fit.rotations.oblimin, s = r.scores;
  if (!s || !vector(s.values, n * k) || !vector(s.completeMask, n) || !matrix(s.weights, p, k) || !vector(s.means, p) || !vector(s.sds, p) || s.sds.some(value => value <= 0)) throw new Error('Missing complete score vectors or fitted scaling');
  if (s.completeMask.some(value => value !== 0 && value !== 1) || s.completeMask.reduce((sum, value) => sum + value, 0) !== r.scoreCompleteRows || r.scoreCompleteRows < 2) throw new Error('Invalid complete-response score membership');
  if (s.values.some((value, index) => !s.completeMask[Math.floor(index / k)] && value !== 0)) throw new Error('Benchmark score placeholders are nonzero outside the complete-response mask');
}
function compareFit(reference, candidate) {
  validateFit(reference); validateFit(candidate);
  if (['rows', 'items', 'factors'].some(key => reference.dimensions[key] !== candidate.dimensions[key])) throw new Error('Compared fit dimensions differ');
  if (!reference.inputSha256 || reference.inputSha256 !== candidate.inputSha256) throw new Error('Missing or nonidentical prepared inputs');
  const statisticKeys = ['rawStatistic', 'trace', 'traceSquared', 'scalingFactor', 'shift', 'statistic'];
  const errors = Object.fromEntries([...statisticKeys, 'pValue'].map(key => {
    if (!Number.isFinite(reference.test[key]) || !Number.isFinite(candidate.test[key])) throw new Error(`Invalid ${key}`);
    return [key, Math.abs(candidate.test[key] - reference.test[key])];
  }));
  const rotations = {};
  for (const method of ['oblimin', 'promax', 'varimax']) {
    const a = reference.rotations[method], b = candidate.rotations[method], match = matchFactors(a.pattern, b.pattern);
    if (match.mapping.includes(null) || match.unmatchedCandidate.length) throw new Error('Unmatched factors in parity comparison');
    const align = (matrix, signs = true) => matrix.map(row => match.mapping.map((j, k) => row[j] * (signs ? match.signs[k] : 1)));
    const alignPhi = (matrix, signs = true) => match.mapping.map((i, a) => match.mapping.map((j, b) => matrix[i][j] * (signs ? match.signs[a] * match.signs[b] : 1)));
    const e = {
      pattern: maximumError(a.pattern, align(b.pattern)),
      structure: maximumError(a.structure, align(b.structure)),
      phi: maximumError(a.phi, alignPhi(b.phi)),
      communalities: maximumError(a.communalities, b.communalities),
      reproduced: maximumError(common(a), common(b)),
      patternSE: maximumError(a.standardErrors.pattern, align(b.standardErrors.pattern, false)),
      structureSE: maximumError(a.standardErrors.structure, align(b.standardErrors.structure, false)),
      phiSE: maximumError(a.standardErrors.phi, alignPhi(b.standardErrors.phi, false)),
      communalitySE: maximumError(a.standardErrors.communalities, b.standardErrors.communalities),
      uniquenessSE: maximumError(a.standardErrors.uniquenesses, b.standardErrors.uniquenesses),
    };
    let scores;
    if (method === 'oblimin') {
      if (a.scores && b.scores) {
        const k = match.mapping.length;
        const aligned = b.scores.values.map((_, index) => b.scores.values[Math.floor(index / k) * k + match.mapping[index % k]] * match.signs[index % k]);
        const maskError = maximumError(a.scores.completeMask, b.scores.completeMask);
        const standardize = values => {
          const means = Array(k).fill(0), sds = Array(k).fill(0), n = a.scores.completeMask.reduce((sum, v) => sum + v, 0);
          for (let i = 0; i < values.length; i++) if (a.scores.completeMask[Math.floor(i / k)]) means[i % k] += values[i] / n;
          for (let i = 0; i < values.length; i++) if (a.scores.completeMask[Math.floor(i / k)]) sds[i % k] += (values[i] - means[i % k]) ** 2 / (n - 1);
          return values.map((value, i) => a.scores.completeMask[Math.floor(i / k)] ? (value - means[i % k]) / Math.sqrt(sds[i % k]) : 0);
        };
        scores = { maxAbsolute: maximumError(a.scores.values, aligned), maxStandardized: maximumError(standardize(a.scores.values), standardize(aligned)), sameCompleteMask: maskError === 0, completeRows: a.scoreCompleteRows };
        scores.passed = scores.maxAbsolute < 1e-3 && scores.maxStandardized < 1e-3 && scores.sameCompleteMask;
      } else scores = { passed: null, reason: 'An earlier report did not preserve score vectors' };
    }
    rotations[method] = { mapping: match.mapping, signs: match.signs, errors: e, scores, passed: Object.entries(e).every(([key, value]) => value < (['pattern', 'structure', 'phi'].includes(key) ? 1e-3 : 1e-4)) && (!scores || scores.passed === true) };
  }
  return { errors, rotations, passed: reference.test.df === candidate.test.df && statisticKeys.every(key => errors[key] < 1e-4) && errors.pValue < 1e-5 && Object.values(rotations).every(r => r.passed), scope: 'Robust test, sign/permutation-aligned rotations, reproduced correlations, communalities, all reported SEs, complete-response scores and masks. The surrounding pipeline remains TypeScript.' };
}
return { maximumError, validateFit, compareFit };
}
