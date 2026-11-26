"use client";

import type { ReactNode } from 'react';

/** Shared selection control for the analysis and view modes. */
export function PanelChoiceButton({ selected, onClick, children }: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return <button type="button" aria-pressed={selected} onClick={onClick} className="panel-choice-button">{children}</button>;
}
