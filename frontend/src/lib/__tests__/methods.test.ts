import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { searchMethods, METHODS_TOPICS, METHODS } from '../methods';

describe('methods reference retrieval', () => {
  it('covers at least the 14 launch topics', () => {
    expect(METHODS_TOPICS.length).toBeGreaterThanOrEqual(14);
  });

  it('returns exact topic matches', () => {
    expect(searchMethods({ topics: ['silhouette'] })[0]?.title).toBe('Silhouette scores');
  });

  it('finds the component-retention chunk from a natural question', () => {
    const hits = searchMethods({ query: 'how many components should I keep' });
    expect(hits.some(c => c.title === 'How many components to keep')).toBe(true);
  });

  it('routes cluster-meaningfulness questions to validity/silhouette content', () => {
    const hits = searchMethods({ query: 'is my clustering meaningful or artificial' });
    expect(hits.some(c => /silhouette|seriously/i.test(c.title))).toBe(true);
  });

  it('finds effect-size content', () => {
    const hits = searchMethods({ query: 'eta squared effect size benchmarks' });
    expect(hits.some(c => /Eta-squared/.test(c.title))).toBe(true);
  });

  it('retrieves Chatterjee interpretation by name, xi alias, or nonlinear dependence', () => {
    for (const query of ['Chatterjee', 'xi', 'ξ', 'nonlinear dependence']) {
      expect(searchMethods({ query }).some(c => c.title.startsWith('Chatterjee'))).toBe(true);
    }
    const chunk = searchMethods({ topics: ['chatterjee_correlation'] })[0];
    expect(chunk.text).toContain('finite-sample estimates can be negative');
    expect(chunk.text).toContain('No p-value or confidence interval is computed');
    expect(chunk.text).toContain('https://arxiv.org/abs/1909.10140v4');
  });

  it('caps keyword results (topics can add more)', () => {
    expect(searchMethods({ query: 'pca components cluster variance data' }).length).toBeLessThanOrEqual(4);
  });

  it('returns nothing for gibberish', () => {
    expect(searchMethods({ query: 'zzqx' })).toHaveLength(0);
  });

  it('every chunk names literature or an explicit existing implementation reference', () => {
    for (const [key, chunk] of Object.entries(METHODS)) {
      const hasLiteratureName = /\b(1[89]\d\d|20[0-2]\d)\b|NYU CDS/.test(chunk.text);
      const hasImplementationSource = Boolean(chunk.sourcePaths?.length) && chunk.sourcePaths!.every(path =>
        /^(docs|packages\/statistics)\/[A-Z][A-Z0-9-]*\.md$/.test(path) && chunk.text.includes(path) &&
        existsSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url))));
      expect(hasLiteratureName || hasImplementationSource, `chunk "${key}" lacks a named source`).toBe(true);
    }
  });

  it('PCA guidance describes the available policies instead of assuming median-only filling', () => {
    for (const topic of ['pca_caveats', 'pca_workflow']) {
      const chunk = searchMethods({ topics: [topic] })[0];
      expect(chunk.text).toContain('complete cases');
      expect(chunk.text).toContain('iterative PCA');
      expect(chunk.text).toContain('MICE');
      expect(chunk.text).not.toContain('median imputation (used here)');
      expect(chunk.text).not.toContain('this app uses medians');
    }
  });

  it('retrieves EFA implementation distinctions without inventing academic citations', () => {
    const efa = searchMethods({ topics: ['efa_estimators_and_rotation'] })[0];
    expect(efa.text).toContain('Lambda times Phi');
    expect(efa.sourcePaths).toContain('docs/EFA.md');
    const parallel = searchMethods({ topics: ['efa_parallel_analysis'] })[0];
    expect(parallel.text).toContain('not PCA eigenvalue parallel analysis');
    const fiml = searchMethods({ topics: ['fiml_and_completion'] })[0];
    expect(fiml.text).toContain('not ordinal threshold-model FIML');
    const mice = searchMethods({ topics: ['mice_and_stability'] })[0];
    expect(mice.text).toContain('not Rubin-pooled');
  });
});
