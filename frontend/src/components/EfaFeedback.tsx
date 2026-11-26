"use client";

import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import type { EfaProgress as EfaProgressValue } from "@/lib/efa/types";

/** Fractions describe the current stage, never estimated whole-job completion. */
export function EfaProgress({
  progress,
  label = "Updating analysis",
}: {
  progress?: EfaProgressValue;
  label?: string;
}) {
  const determinate = !!progress && Number.isFinite(progress.completed)
    && Number.isFinite(progress.total) && progress.total > 0
    && progress.completed >= 0 && progress.completed <= progress.total;
  const fraction = determinate ? progress.completed / progress.total : undefined;
  const percent = fraction == null ? undefined : Math.floor(fraction * 100);
  const stage = progress?.stage || label;

  return (
    <div className="efa-progress text-xs">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="min-w-0 break-words font-bold">{stage}</span>
        <span className="shrink-0 tabular-nums opacity-75">
          {percent == null ? "Working…" : `Stage ${percent}%`}
        </span>
      </div>
      <div
        className="efa-progress-track"
        role="progressbar"
        aria-label={`${label}: ${stage}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={percent == null ? `${stage}, progress unavailable` : `${stage}, ${percent}% of this stage`}
      >
        <span
          className="efa-progress-fill"
          data-indeterminate={fraction == null || undefined}
          style={fraction == null ? undefined : { width: `${fraction * 100}%` }}
        />
      </div>
    </div>
  );
}

/** Inline placement leaves the result table and its controls unobscured. */
export function EfaToast({
  message,
  onDismiss,
  tone = "info",
}: {
  message: string;
  onDismiss: () => void;
  tone?: "success" | "error" | "info";
}) {
  const Icon = tone === "error" ? CircleAlert : tone === "success" ? CheckCircle2 : Info;
  return (
    <div className="efa-toast text-xs" data-tone={tone} role={tone === "error" ? "alert" : "status"} aria-atomic="true">
      <Icon size={15} aria-hidden="true" className="efa-toast-icon shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <button type="button" aria-label="Dismiss notification" onClick={onDismiss} className="efa-toast-dismiss shrink-0">
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
