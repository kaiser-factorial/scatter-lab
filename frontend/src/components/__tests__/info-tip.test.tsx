// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InfoTip } from "../InfoTip";

let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount() {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<InfoTip label="Column median" text="Uses an observed category for an ordered categorical item." />));
  return host.querySelector("button")!;
}
async function event(element: HTMLElement, type: string) {
  await act(async () => element.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: document.body })));
}

it("opens on hover, lets the pointer enter the note, and closes on leave", async () => {
  const button = await mount();
  expect(button.hasAttribute("title")).toBe(false);
  await event(button, "mouseover");
  const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')!;
  expect(tooltip.textContent).toContain("observed category");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(tooltip.parentElement).toBe(document.body);
  expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
  await event(button, "mouseout"); await event(tooltip, "mouseover");
  await act(async () => vi.advanceTimersByTime(200));
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  await event(tooltip, "mouseout"); await act(async () => vi.advanceTimersByTime(200));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});

it("opens on focus, supports click pinning, and dismisses with Escape or an outside click", async () => {
  const button = await mount();
  await act(async () => button.focus());
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(document.activeElement).toBe(button);
  await act(async () => button.click()); await event(button, "mouseout");
  await act(async () => vi.advanceTimersByTime(200));
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
