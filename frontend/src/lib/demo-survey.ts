import type { EfaSpec } from './efa/types';

export type DemoDataset = 'iris' | 'survey';

export const DEMO_SURVEY_ITEMS = ['Plan', 'Explore', 'Organize', 'Imagine', 'Schedule', 'Invent', 'Prepare', 'Experiment'];

export const DEMO_SURVEY_SPLIT = { seed: 2026, fraction: 0.7 } as const;

export const DEMO_SURVEY_WORDING: Record<string, string> = {
  Plan: 'I make a plan before starting a task.', Explore: 'I enjoy exploring unfamiliar ideas.',
  Organize: 'I keep my materials organized.', Imagine: 'I imagine different ways things could work.',
  Schedule: 'I set aside time for upcoming tasks.', Invent: 'I come up with new uses for ordinary things.',
  Prepare: 'I gather what I need ahead of time.', Experiment: 'I try unfamiliar approaches to see what happens.',
};

export function demoSurveySpec(): EfaSpec {
  return { label: 'DemoSurvey', items: DEMO_SURVEY_ITEMS.map(column => ({ column, categories: ['Organize', 'Invent'].includes(column) ? [1, 2, 3] : [1, 2, 3, 4, 5], reverse: false, measurement: 'ordinal' })),
    nFactors: 2, extraction: 'minres', correlation: 'polychoric', rotation: 'promax', missing: 'pairwise', seed: 73021, sample: { partition: 'all' } };
}
