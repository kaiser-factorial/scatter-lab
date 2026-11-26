"use client";

import React from "react";
import { useTheme } from "next-themes";

// Module-level component: defining this inside TmuxGrid gave it a new identity
// every render, remounting all Plot children on any state change (which broke
// camera animation and made exports capture purged graph divs).
const WrappedView = ({ view, index, theme, renderView }: {
    view: any, index: number, theme: string | undefined,
    renderView: (view: any, index: number) => React.ReactNode,
}) => {
    const isPinned = view.id !== 'active';
    const title = view.label ?? (isPinned ? "Pinned View" : "Active View");

    if (theme === 'terminal') {
        return (
            <div className="h-full w-full relative border border-[#10ff50]/30 bg-black/40 flex flex-col">
                <div className="absolute top-3 left-3 z-10 pointer-events-none text-[10px] font-bold uppercase tracking-widest text-[#10ff50]/50">
                    {title}
                </div>
                <div className="relative min-h-0 w-full flex-1">
                    {renderView(view, index)}
                </div>
            </div>
        );
    }

    return (
        <div className="h-full w-full bauhaus-panel">
            {renderView(view, index)}
        </div>
    );
};

// One tree for every view count, with a key per pane.
//
// This used to return a structurally different tree per count — for one view the
// root's child was a WrappedView, for two a div wrapping them. React sees a
// changed child type at the same position, unmounts the subtree, and
// react-plotly.js's cleanup calls Plotly.purge, so adding or removing a single
// pin destroyed and re-created the WebGL context of EVERY pane including the
// live one (finding F12). There were also no keys, so pins shuffled identity on
// removal, and the four-view branch laid panes out 0, 3, 1, 2.
//
// A CSS grid keeps the DOM shape constant and the keys keep pane identity, so
// removing a pin now unmounts exactly that pin.
const GRID: Record<number, { cols: string; rows: string }> = {
   1: { cols: '1fr', rows: '1fr' },
   2: { cols: '1fr 1fr', rows: '1fr' },
   3: { cols: '1fr 1fr', rows: '1fr 1fr' },
   4: { cols: '1fr 1fr', rows: '1fr 1fr' },
};

export function TmuxGrid({ views, renderView }: { views: any[], renderView: (view: any, index: number) => React.ReactNode }) {
   const { theme } = useTheme();
   if (views.length === 0) return null;

   const n = Math.min(views.length, 4);
   const { cols, rows } = GRID[n];

   return (
       <div className="plot-grid-frame w-full h-full"><div data-panes={n}
           className="w-full h-full grid gap-4 p-4"
           style={{ gridTemplateColumns: cols, gridTemplateRows: rows }}
       >
           {views.slice(0, 4).map((view, i) => (
               <div
                   key={view.id}
                   className="min-w-0 min-h-0"
                   // With three panes the live view takes the full-height left
                   // column, which is the layout the old branch built by hand.
                   style={n === 3 && i === 0 ? { gridRow: 'span 2' } : undefined}
               >
                   <WrappedView view={view} index={i} theme={theme} renderView={renderView} />
               </div>
           ))}
       </div></div>
   );
}
