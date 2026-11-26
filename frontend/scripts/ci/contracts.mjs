import { relative } from 'node:path';

export function verifyNumericalReport(report, groups, checks) {
  if (!Array.isArray(report.results)) throw new Error('Missing numerical results');
  const actualChecks = report.results.reduce((sum, r) => sum + (Array.isArray(r.checks) ? r.checks.length : 0), 0);
  if (report.results.length !== groups || actualChecks !== checks) throw new Error(`Coverage mismatch: ${report.results.length}/${groups} groups, ${actualChecks}/${checks} checks`);
  if (report.results.some(r => r.status !== 'passed' || !Array.isArray(r.checks) || r.checks.some(c => c.passed !== true || !Number.isFinite(c.error) || !Number.isFinite(c.limit) || c.limit < 0 || c.error > c.limit))) throw new Error('At least one result/check failed or is nonfinite');
}

export function lintSignature(root, filePath, message) {
  const frame = message.message.indexOf(filePath);
  const text = frame < 0 ? message.message : message.message.slice(0, frame).trimEnd();
  return JSON.stringify([relative(root, filePath).replaceAll('\\', '/'), message.ruleId ?? 'parse/configuration error', message.severity, text]);
}

export function addedLintSignatures(before, after) {
  return [...after].flatMap(([signature, count]) => count > (before.get(signature) ?? 0) ? [{ signature: JSON.parse(signature), count, baselineCount: before.get(signature) ?? 0 }] : []);
}
