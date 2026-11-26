// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RecodeDialog } from '../RecodeDialog';
import type { RecodePlan } from '@/lib/recode';

const columns = ['Q10', 'Alpha', 'Q2', 'Zulu'];
const table = { columns, nRows: 50, data: Object.fromEntries(columns.map(column => [column,
  Array.from({ length: 50 }, (_, row) => row < 2 && ['Q2', 'Zulu'].includes(column) ? -99 : 1 + row % 5),
])) };
let root: Root;
const apply = vi.fn<(plan: RecodePlan) => string[]>(() => []);
const close = vi.fn();
const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
const names = () => boxes().map(box => box.getAttribute('aria-label')!);
const chosen = () => boxes().filter(box => box.checked).map(box => box.getAttribute('aria-label')!);
const button = (name: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === name)!;
async function click(box: HTMLElement, shiftKey = false) {
  await act(async () => box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey })));
}
async function sort(value: string) {
  const select = document.querySelector('select')!;
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root.render(<RecodeDialog stage="configure" table={table} onProceed={() => {}} onApply={apply} onClose={close} />));
  const declared = document.querySelector<HTMLInputElement>('input[type="text"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(declared, '3');
    declared.dispatchEvent(new Event('input', { bubbles: true }));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren(); vi.clearAllMocks(); vi.unstubAllGlobals();
});

it('sorts individual suggestions without changing checkmarks or the recode plan', async () => {
  expect(names()).toEqual(['Q2, code -99', 'Zulu, code -99', 'Q10, code 3', 'Alpha, code 3', 'Q2, code 3', 'Zulu, code 3']);
  await click(button('none'));
  await sort('alphabetical');
  expect(names()).toEqual(['Alpha, code 3', 'Q2, code -99', 'Q2, code 3', 'Q10, code 3', 'Zulu, code -99', 'Zulu, code 3']);
  await click(boxes()[1]); await click(boxes()[3], true);
  expect(chosen()).toEqual(names().slice(1, 4));
  await sort('dataset');
  expect(names()).toEqual(['Q10, code 3', 'Alpha, code 3', 'Q2, code -99', 'Q2, code 3', 'Zulu, code -99', 'Zulu, code 3']);
  expect(chosen()).toEqual(['Q10, code 3', 'Q2, code -99', 'Q2, code 3']);
  await click(button('Replace with blanks'));
  expect(apply).toHaveBeenCalledExactlyOnceWith({ byColumn: { Q2: [-99, 3], Q10: [3] } });
});

it('clears an inclusive range upwards and resets the anchor after a bulk choice', async () => {
  await sort('dataset'); await click(button('all'));
  await click(boxes()[4]); await click(boxes()[1], true);
  expect(chosen()).toEqual([names()[0], names()[5]]);
  await click(button('none')); await click(boxes()[2], true);
  expect(chosen()).toEqual([names()[2]]);
  expect(apply).not.toHaveBeenCalled();
});

it('shows the evidence on demand and dismisses the tooltip before the dialog', async () => {
  const why = document.querySelector<HTMLButtonElement>('[aria-label="Why Q2, code -99?"]')!;
  const before = chosen();
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => why.focus());
  expect(document.querySelector('[role="tooltip"]')?.textContent).toMatch(/gap|outside|scale|negative|rows/i);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  expect(chosen()).toEqual(before);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(close).toHaveBeenCalledOnce();
});
