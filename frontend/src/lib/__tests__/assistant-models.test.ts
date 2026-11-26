import { expect, it } from 'vitest';
import { DEFAULT_MODEL, suggestModels } from '../assistant';

it('defaults to Sol and prefers Sol and Opus even when Astra and Fable have newer catalog dates', () => {
  const catalog = [
    { id: 'anthropic/claude-fable-5.2', created: 2 }, { id: 'anthropic/claude-opus-5.5', created: 1 },
    { id: 'openai/gpt-6.2-astra', created: 2 }, { id: 'openai/gpt-6.2-sol', created: 1 },
    { id: 'google/gemini-pro', created: 1 },
  ];
  expect(DEFAULT_MODEL).toBe('openai/gpt-6.2-sol');
  expect(suggestModels(catalog)).toEqual([DEFAULT_MODEL, 'anthropic/claude-opus-5.5', 'google/gemini-pro']);
});

it('suggests only models actually offered by the endpoint', () => {
  expect(suggestModels([])).toEqual([]);
  expect(suggestModels([{ id: 'openai/gpt-oss-120b', created: 1 }])).toEqual(['openai/gpt-oss-120b']);
});
