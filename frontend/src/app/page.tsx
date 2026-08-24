"use client";
import { useEffect, useState, useRef, useMemo, memo, useCallback, useTransition } from "react";
import { createPortal } from "react-dom";
import { HardDriveUpload, Play, Square, Download, Pin, Monitor, X, Trash2, Info, Lock, Globe, Settings2 } from "lucide-react";
import dynamic from 'next/dynamic';
import { useTheme } from "next-themes";
import { TmuxGrid } from "@/components/TmuxGrid";
import { CyberStackGroup, CyberContainer, CyberPanel } from "ccru/components";
import { Accordion, AccordionItem, Separator } from "puxel";
import { readTable, listSheets, type SheetInfo } from "@/lib/parse";
import { asNumber, isNumericColumn } from "@/lib/table";
import { scanTable, numericColumnsOf, categoricalColumnsOf } from "@/lib/profile";
import { CSV_BOM, csvCell } from "@/lib/csv";
import { processUpload } from "@/lib/engine";
import { dbscan, kmeans, zscoreCellColumns, suggestStandardize, countImputed, nonNumericAxes } from "@/lib/cluster";
import * as wsStore from "@/lib/workspaces";
// Loaded on demand (finding F1). Statically imported, this pulled
// react-markdown, remark-gfm, remark-breaks and the whole micromark/mdast tree
// onto the critical path for every visitor — including everyone who never opens
// the assistant. ssr:false because the panel is entirely client state.
const AssistantPanel = dynamic(
    () => import("@/components/AssistantPanel").then(m => m.AssistantPanel),
    { ssr: false },
);
import type { AppBridge, ColumnProfile } from "@/lib/assistant";
import type { ConversationBridge } from "@/components/AssistantPanel";
import { GUIDE_TARGETS, paintYield } from "@/lib/assistant";
import { readRelayout } from "@/lib/relayout";
import { correlation, compareGroups as statsCompareGroups, silhouetteByK, kDistancePercentiles } from "@/lib/stats";
import { runPCA, deriveRunLabel, sanitizeLabel, pcaColumnNames, isPCColumn, type MissingReport, type MissingStrategy } from "@/lib/pca";
import { isIdentifierColumn, valueIsTooRare, pickDefaultAxes, pickDefaultColorBy } from "@/lib/defaults";
import { asDataMode, combinedPolicy, policyFor, type DataMode } from "@/lib/dataPolicy";
import { sampleRowsCore, rowsWhereCore, listCategoriesCore } from "@/lib/rowAccess";
import { diagnoseTable, summarizeDiagnosis, applyNumericFix, type ColumnDiagnosis } from "@/lib/uploadDoctor";
import { InfoTip } from "@/components/InfoTip";
import { applyRecode, describeRecode } from "@/lib/recode";
import { InfoDialog } from "@/components/InfoDialog";
import { RecodeDialog } from "@/components/RecodeDialog";
import { buildClusterCrosstab, buildClusterHeatmap, downloadClusterHeatmapPng, HEATMAP_PALETTES, sortClusterLabels, type BreakdownDirection, type HeatmapPalette } from "@/lib/clusterBreakdown";
import { MARK_KINDS, TEST_KINDS, formatFailures, type AnalysisPlan, type ChartPlan, type TestPlan, type ValidationFailure } from "@/lib/analysisPlan";
import { analysisProfileOf, validatePlan } from "@/lib/validators";
import { formatTestResult, runTestPlan, type TestResult } from "@/lib/statTests";
import { compileChart, type CompiledChart } from "@/lib/chartCompile";


const Plot = dynamic(() => import('@/components/PlotlyPlot'), { ssr: false });

// Working title — referenced everywhere the app names itself
const APP_NAME = "Scatter Lab";

const PrimaryCollapsible = ({ title, mode = 'top', defaultOpen = true, width, buttonPosition = 'right', children }: any) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);

    if (mode === 'side') {
        const buttonNode = (
            <button 
                onClick={() => setIsOpen(!isOpen)} 
                className={`w-9 flex-shrink-0 bg-[var(--border)] text-[var(--background)] flex items-center justify-center hover:opacity-80 transition-opacity cursor-pointer ${buttonPosition === 'right' ? 'border-l-[3px]' : 'border-r-[3px]'} border-[var(--background)]`}
            >
                <span className="text-[10px] font-bold uppercase tracking-widest whitespace-nowrap" style={{ writingMode: 'vertical-rl', transform: buttonPosition === 'right' ? 'rotate(180deg)' : 'none' }}>
                    {title} {isOpen ? (buttonPosition === 'right' ? '▸' : '◂') : (buttonPosition === 'right' ? '◂' : '▸')}
                </span>
            </button>
        );

        return (
            <div className="flex bg-[var(--background)]/90 border-[3px] border-[var(--border)] shadow-[4px_4px_0px_#111111] overflow-hidden transition-[width] duration-200" style={{ width: isOpen ? width : 36, height: 'fit-content' }}>
                {buttonPosition === 'left' && buttonNode}
                <div className="flex-grow min-w-0 transition-opacity duration-200" style={{ opacity: isOpen ? 1 : 0, width: isOpen ? width - 36 : 0 }}>
                    <div className="p-3" style={{ width: width - 36 }}>
                        {children}
                    </div>
                </div>
                {buttonPosition === 'right' && buttonNode}
            </div>
        );
    }

    return (
        <div className="bg-[var(--background)]/90 border-[3px] border-[var(--border)] shadow-[4px_4px_0px_#111111] transition-[width] duration-200 flex flex-col" style={{ width }}>
            <button 
                onClick={() => setIsOpen(!isOpen)} 
                className="w-full flex justify-between items-center p-2 bg-[var(--border)] text-[var(--background)] hover:opacity-80 transition-opacity cursor-pointer"
            >
                <span className="text-xs font-bold uppercase tracking-wider">{title}</span>
                <span className="text-[10px]">{isOpen ? '▼' : '▶'}</span>
            </button>
            <div className="overflow-hidden transition-all duration-200" style={{ maxHeight: isOpen ? 500 : 0, opacity: isOpen ? 1 : 0 }}>
                <div className="p-3">
                    {children}
                </div>
            </div>
        </div>
    );
};

// Legend swatch for the shape channel — mirrors the Plotly symbol names in
// SHAPE_SYMBOLS. Drawn rather than imported so it inherits the theme colour.
const SymbolGlyph = ({ symbol, color }: { symbol: string, color: string }) => {
    const open = symbol.endsWith('-open');
    const base = symbol.replace('-open', '');
    const fill = open ? 'none' : color;
    const p = { fill, stroke: color, strokeWidth: 1.5 };
    return (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="flex-shrink-0">
            {base === 'circle' && <circle cx="6" cy="6" r="4.2" {...p} />}
            {base === 'square' && <rect x="2" y="2" width="8" height="8" {...p} />}
            {base === 'diamond' && <path d="M6 1.4 L10.6 6 L6 10.6 L1.4 6 Z" {...p} />}
        </svg>
    );
};

const ThemedLegend = ({ view, theme, muted = {}, onToggle }: { view: any, theme: string | undefined, muted?: MuteMap, onToggle?: (val: any) => void }) => {
    const legendInfo = useMemo(() => {
        const colVals: any[] = view.data?.data?.[view.colorBy] ?? [];
        const kind = getColorFieldKind(colVals);
        if (kind === "categorical") {
            return { kind, values: sortCategories(Array.from(new Set(colVals.map((v: any) => v ?? "N/A")))) };
        }
        if (kind === "continuous") {
            let min = Infinity, max = -Infinity;
            for (const v of colVals) {
                if (v == null) continue;
                if (v < min) min = v;
                if (v > max) max = v;
            }
            return { kind, min, max, values: [] };
        }
        return { kind, values: [] };
    }, [view.data, view.colorBy]);
    const colors = ['#4195DE', '#D23B72', '#FFD600', '#5F4690', '#1D6996', '#38A6A5', '#0F8554', '#73AF48', '#EDAD08', '#E17C05'];
    const textClass = theme === 'primary' ? 'text-[10px] font-bold text-[var(--foreground)]' : 'text-[10px] text-gray-300';

    // Shape is an independent channel, so it gets its own key below the colours.
    // Display-only: muting stays a colour concept (mutedMap is keyed by colour value).
    const shapeCats = useMemo(() => {
        const vals: any[] = view.shapeBy ? (view.data?.data?.[view.shapeBy] ?? []) : [];
        const cats = vals.length ? shapeCategories(vals) : [];
        return cats.length && cats.length <= MAX_SHAPE_CATEGORIES ? cats : [];
    }, [view.data, view.shapeBy]);
    const glyphColor = theme === 'primary' ? '#111111' : '#10ff50';

    const innerContent = legendInfo.kind === "continuous" ? (
        <div className="flex flex-col gap-1">
            <div className="h-3 w-full rounded-sm" style={{ background: 'linear-gradient(to right, #440154, #414487, #2a788e, #22a884, #7ad151, #fde725)' }} />
            <div className={`flex justify-between ${textClass}`}>
                <span>{Number(legendInfo.min).toFixed(2)}</span>
                <span>{Number(legendInfo.max).toFixed(2)}</span>
            </div>
        </div>
    ) : legendInfo.kind === "too-many" ? (
        <span className={textClass}>Too many categories to display</span>
    ) : (
        <div className="flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto">
            {legendInfo.values.map((val, i) => {
                const state = muted[String(val)];
                const nextAction = !state ? 'Mute' : state === 'muted' ? 'Hide' : 'Show';
                return (
                    <button
                        key={String(val)}
                        onClick={() => onToggle?.(val)}
                        title={`${nextAction} ${String(val)}`}
                        className="flex items-center gap-2 cursor-pointer group text-left bg-transparent border-0 p-0"
                    >
                        <div
                            className={`flex-shrink-0 rounded-full transition-transform duration-150 group-hover:scale-125 ${theme === 'primary' ? 'w-3 h-3 border-[2px]' : 'w-2.5 h-2.5 border'} ${state === 'hidden' ? 'border-dashed border-[#bbbbbb]' : state === 'muted' ? 'border-[#999999]' : (theme === 'primary' ? 'border-[var(--foreground)]' : 'border-transparent')}`}
                            style={{ backgroundColor: state ? 'transparent' : (String(val) === 'Noise' ? '#8a8a8a' : colors[i % colors.length]) }}
                        />
                        <span className={`truncate ${textClass} ${state === 'hidden' ? 'opacity-25 line-through' : state === 'muted' ? 'opacity-40' : ''}`} title={String(val)}>{String(val)}</span>
                    </button>
                );
            })}
        </div>
    );

    const shapeSection = shapeCats.length > 0 && (
        <div className="mt-3 pt-2 border-t border-current/15">
            <div className={`mb-1.5 opacity-60 uppercase tracking-wider ${textClass}`} title={view.shapeBy}>
                Shape · {view.shapeBy}
            </div>
            <div className="flex flex-col gap-1.5 max-h-[30vh] overflow-y-auto">
                {shapeCats.map((val, i) => (
                    <div key={val} className="flex items-center gap-2">
                        <SymbolGlyph symbol={SHAPE_SYMBOLS[i]} color={glyphColor} />
                        <span className={`truncate ${textClass}`} title={val}>{val}</span>
                    </div>
                ))}
            </div>
        </div>
    );

    // The legend floats above the canvas, and the canvas tiles once a view is
    // pinned — so an open legend sits on top of the neighbouring pane. Fading it
    // while it is not being read keeps the points underneath visible without
    // taking the key away; hovering brings it back to full strength.
    const legendFade = 'opacity-75 hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150';

    if (theme === 'terminal') {
        return (
            <div className={`absolute top-1/4 right-0 z-30 ${legendFade}`}>
                <CyberPanel id="legend-panel" title="Legend" width={200} collapseDirection="side" positionMode="relative" position={{x:0, y:0}} onDragStart={() => {}}>
                    <div className="p-3 w-full">
                        <div className="text-[10px] font-bold mb-2 uppercase tracking-widest text-[#10ff50]/70">{view.colorBy}</div>
                        {innerContent}
                        {shapeSection}
                    </div>
                </CyberPanel>
            </div>
        );
    }

    return (
        <div className={`absolute top-1/4 right-0 z-30 ${legendFade}`}>
            <PrimaryCollapsible title={view.colorBy} mode="side" width={200}>
                {innerContent}
                {shapeSection}
            </PrimaryCollapsible>
        </div>
    );
};

const ThemedNotes = ({ notes, setNotes, theme }: { notes: string, setNotes: any, theme: string | undefined }) => {
    const innerContent = (
        <div className="w-full h-full p-1">
            <textarea 
                value={notes} 
                onChange={e => setNotes(e.target.value)}
                placeholder="Add observations here..."
                className={`w-full h-full bg-transparent outline-none resize-none text-sm ${theme === 'primary' ? 'text-[var(--foreground)]' : 'text-[#10ff50]'}`}
            />
        </div>
    );

    if (theme === 'terminal') {
        return (
            <div className="absolute top-1/4 left-0 z-30 [&>div>div>.flex]:flex-row-reverse [&>div>div>.flex]:gap-2">
                <CyberPanel id="notes-panel" title="Notes" width={280} collapseDirection="side" positionMode="relative" position={{x:0, y:0}} defaultOpen={false} onDragStart={() => {}}>
                    <div className="p-3 w-full h-64">
                        {innerContent}
                    </div>
                </CyberPanel>
            </div>
        );
    }
    
    return (
        <div className="absolute top-1/4 left-0 z-30">
            <PrimaryCollapsible title="Notes" mode="side" width={280} buttonPosition="left" defaultOpen={false}>
                <div className="w-full h-64">
                    {innerContent}
                </div>
            </PrimaryCollapsible>
        </div>
    );
};

// Columnar table as returned by /api/upload: one array per column
type DataTable = { columns: string[], data: Record<string, any[]>, nRows: number };

// Which table columns feed the plot; z is null for purely 2D data
type Axes = { x: string, y: string, z: string | null };
type AxisLabels = { x: string, y: string, z: string };

type Axes2D = { x: string, y: string };

// Provenance of one PCA run: which variables went in, what came out, when.
// Identity is the label — re-running a label replaces its registry entry and
// its columns. The column NAME stays short (PC1_openness / COMP_openness);
// everything else about the run lives here, not in the name.
type PcaRun = {
    label: string;            // '' = the unnamed bare-PC1..PCk run
    columns: string[];
    variables: string[];
    k: number;
    standardize: boolean;
    savedAt: string;
    varianceExplained: number[];
    missing?: MissingReport;
};

// One sentence naming what happened to the incomplete rows. Returns '' when
// there were none, so a complete dataset says nothing at all.
const missingNote = (rep: MissingReport | undefined, nRows: number): string => {
    if (!rep || !rep.byVariable.length) return '';
    const worst = rep.byVariable.slice(0, 3).map(m => `${m.var} ${m.n}/${nRows}`).join(', ');
    const more = rep.byVariable.length > 3 ? `, +${rep.byVariable.length - 3} more` : '';
    if (rep.strategy === 'complete') {
        return ` Complete cases only: ${rep.rowsDropped} of ${nRows} rows were dropped for having a gap, leaving ${rep.rowsUsed} — ${worst}${more}. Those rows have no score.`;
    }
    const pct = (rep.imputedCells / Math.max(rep.totalCells, 1)) * 100;
    const how = rep.strategy === 'iterative'
        ? `reconstructed by iterative PCA (${rep.iterations} iterations${rep.converged ? '' : ', did NOT converge — treat with caution'})`
        : 'filled with the column median';
    return ` ${rep.imputedCells} of ${rep.totalCells} cells (${pct < 0.1 ? '<0.1' : pct.toFixed(1)}%) were missing and ${how} — ${worst}${more}.`;
};

// A cached upload: processed table, upload-time profile, and its plot-axis choices.
// 3D (axes) and 2D (axes2d) are independent so picking a 2D pair never disturbs
// the 3D triple. labels are display overrides — they default to the column names.
type Dataset = {
    id: number, name: string, table: DataTable, summary: any,
    axes: Axes, labels: AxisLabels,
    axes2d: Axes2D, labels2d: Axes2D,
    pcaRuns?: PcaRun[],
    // What the assistant may see of this dataset. Chosen at upload, changeable
    // from the badge in the datasets list; 'private' is the fail-closed default
    // (asDataMode maps anything unrecognized — including its absence in an
    // older workspace — to it).
    dataMode: DataMode,
    // Ordered audit trail of everything that changed this dataset's in-app
    // copy — upload, formatted-text coercion, missing-code blanking, column
    // transfers, PCA/Cluster columns, mode switches. The original file on
    // disk is never touched; this is how a user reconstructs what the app
    // (or the assistant) did to the copy. Persists with workspaces/autosave.
    provenance?: { at: string; action: string }[],
};

type InitialUploadView = {
    axes: Axes;
    colorBy: string;
    shapeBy?: string;
    viewMode?: "2D" | "3D";
};

// The axes a view actually plots, given its mode
const effectiveAxes = (d: Dataset, mode: "3D" | "2D"): Axes =>
    mode === "2D" ? { x: d.axes2d.x, y: d.axes2d.y, z: null } : d.axes;
const effectiveLabels = (d: Dataset, mode: "3D" | "2D"): AxisLabels =>
    mode === "2D" ? { x: d.labels2d.x, y: d.labels2d.y, z: 'Z' } : d.labels;

// isNumericColumn, not `typeof v === 'number'`: a column Excel formatted as Text
// is still a measurement, and pca.ts/engine.ts always treated it as one (C6).
const numericColumns = (table: DataTable) =>
    table.columns.filter(c => isNumericColumn(table.data[c] ?? []));

const defaultLabels = (axes: Axes): AxisLabels => ({ x: axes.x, y: axes.y, z: axes.z ?? 'Z' });

// Above these cardinalities, one-trace-per-value plotting freezes the tab on real datasets
const CONTINUOUS_UNIQUE_THRESHOLD = 20;
const MAX_CATEGORIES = 50;

// Numeric column with many distinct values → treat as continuous (colorscale, not per-value traces)
const getColorFieldKind = (values: any[]): "categorical" | "continuous" | "too-many" => {
    const seen = new Set();
    let allNumeric = true;
    for (const v of values) {
        if (v == null) continue;
        if (typeof v !== 'number') allNumeric = false;
        seen.add(v);
        if (allNumeric && seen.size > CONTINUOUS_UNIQUE_THRESHOLD) return "continuous";
        if (!allNumeric && seen.size > MAX_CATEGORIES) return "too-many";
    }
    return "categorical";
};

// Legend mute cycle: normal → 'muted' (hollow grey outline) → 'hidden' (gone) → normal
type MuteState = 'muted' | 'hidden';
type MuteMap = Record<string, MuteState>;

// Categories sort numerically-aware with Noise last, in BOTH traces and legend,
// so palette index i lines up between them and stays stable across re-runs
const sortCategories = (vals: any[]) => [...vals].sort((a, b) => {
    const A = String(a), B = String(b);
    if (A === 'Noise') return 1;
    if (B === 'Noise') return -1;
    return A.localeCompare(B, undefined, { numeric: true });
});

// Marker symbols understood by BOTH scatter and scatter3d, so switching modes
// never changes what a shape means. Filled glyphs lead, then their open twins.
// cross/x are deliberately absent: scatter3d draws them as line glyphs at a much
// heavier visual weight than the filled shapes, which reads as "these points are
// bigger" — shape must not imply magnitude. Shape is a low-cardinality channel
// anyway (past ~5 levels the glyphs stop being tellable apart), so the list is
// also the cap.
const SHAPE_SYMBOLS = ['circle', 'square', 'diamond', 'circle-open', 'square-open', 'diamond-open'];
const MAX_SHAPE_CATEGORIES = SHAPE_SYMBOLS.length;

// scatter3d renders square/diamond glyphs with a much smaller footprint than
// circles at the same marker.size. These calibrated values equalize the visual
// diameter without inflating ordinary circle markers or 2D plots.
const markerSizeFor = (mode: "3D" | "2D", symbol?: string) => {
    if (mode === "2D") return 6;
    if (symbol?.includes('diamond')) return 8;
    if (symbol?.includes('square')) return 7;
    if (symbol === 'circle-open') return 5;
    return 4;
};

// Called from both buildTraces and ThemedLegend. `vals.map(String)` across every
// row, to discover at most six distinct values, measured 8.4 ms on a 200k table
// (finding F14). A Set-first loop is 0.0 ms.
//
// Stops one past the decision threshold: everything downstream only asks
// "is this more than MAX_SHAPE_CATEGORIES?", so counting further is wasted. The
// exact total is therefore NOT available above the cap — the one caller that
// used to print it now says "more than N", because printing a capped count
// would be worse than printing none.
const shapeCategories = (vals: any[]) => {
    const seen = new Set<string>();
    for (const v of vals) {
        seen.add(String(v ?? 'N/A'));
        if (seen.size > MAX_SHAPE_CATEGORIES) break;
    }
    return sortCategories(Array.from(seen));
};

const buildTraces = (table: DataTable | null, colorField: string, mode: "3D" | "2D", axes: Axes, labels: AxisLabels, muted: MuteMap = {}, dark = false, shapeField = "", includeFloor = true) => {
    if (!table || table.nRows === 0) return [];
    const n = table.nRows;
    const px = table.data[axes.x] ?? [];
    const py = table.data[axes.y] ?? [];
    const pz = axes.z ? (table.data[axes.z] ?? []) : new Array(n).fill(0);
    const colorVals = table.data[colorField] ?? [];

    // Shape is a second, independent categorical channel. Plotly takes one symbol
    // per trace, so an active shape variable splits each colour group further —
    // hence the hard cardinality cap, which also keeps the glyphs distinguishable.
    const shapeVals = shapeField ? (table.data[shapeField] ?? []) : [];
    const shapeCats = shapeField ? shapeCategories(shapeVals) : [];
    const shapeOn = shapeCats.length > 0 && shapeCats.length <= MAX_SHAPE_CATEGORIES;
    const symbolFor: Record<string, string> = {};
    if (shapeOn) shapeCats.forEach((v, i) => { symbolFor[v] = SHAPE_SYMBOLS[i]; });
    const shapeAt = (i: number) => (shapeOn ? String(shapeVals[i] ?? 'N/A') : null);

    const traces: any[] = [];
    const colors = ['#4195DE', '#D23B72', '#FFD600', '#5F4690', '#1D6996', '#38A6A5', '#0F8554', '#73AF48', '#EDAD08', '#E17C05'];
    const hovertemplate = mode === "3D"
        ? `${labels.x}: %{x:.2f}<br>${labels.y}: %{y:.2f}<br>${labels.z}: %{z:.2f}<extra></extra>`
        : `${labels.x}: %{x:.2f}<br>${labels.y}: %{y:.2f}<extra></extra>`;

    const kind = getColorFieldKind(colorVals);

    if (kind === "categorical") {
        // Palette index comes from the colour categories alone, so adding a shape
        // variable subdivides traces without shifting anybody's colour
        const colorCats = sortCategories(Array.from(new Set(colorVals.map((v: any) => v ?? "N/A"))));
        const colorIdx = new Map(colorCats.map((v, i) => [String(v), i]));
        // Grouping key is a NUMBER, and the lookups behind it are keyed on the
        // raw values rather than their string forms. The composite
        // `${cval}␟${sval}` this replaces allocated a string per point per call
        // and measured as the single most expensive line in the function — 4.8
        // ms of a 50k total (finding F15). Stringifying for `colorIdx.get`
        // would have put the same allocation straight back.
        const colorRank = new Map<any, number>(colorCats.map((v, i) => [v, i]));
        const shapeRank = new Map<string, number>(shapeCats.map((v, i) => [v, i]));
        const stride = shapeCats.length + 1;
        const grouped = new Map<number, { x: any[], y: any[], z: any[], color: any, shape: string | null, ci: number, si: number }>();
        for (let i = 0; i < n; i++) {
            const cval = colorVals[i] ?? "N/A";
            const sval = shapeAt(i);
            const ci = colorRank.get(cval) ?? 0;
            const si = sval == null ? 0 : (shapeRank.get(sval) ?? -1) + 1;
            const key = ci * stride + si;
            let g = grouped.get(key);
            if (!g) { g = { x: [], y: [], z: [], color: cval, shape: sval, ci, si }; grouped.set(key, g); }
            g.x.push(px[i]);
            g.y.push(py[i]);
            g.z.push(pz[i]);
        }
        // Colour-major, then shape — keeps trace order aligned with the legend
        const groups = Array.from(grouped.values()).sort((a, b) => (a.ci - b.ci) || (a.si - b.si));
        groups.forEach(g => {
            // Muted/hidden categories keep their trace slot so colors don't shift:
            // 'muted' renders hollow with a thin grey outline, 'hidden' is invisible
            const key = String(g.color);
            const state = muted[key];
            const i = colorIdx.get(key) ?? 0;
            const symbol = g.shape ? symbolFor[g.shape] : undefined;
            // Hollowing out only works for fillable glyphs — the -open symbols draw
            // in the marker colour, so a transparent fill would erase them entirely.
            // Those mute to a grey ghost instead, which keeps the shape readable.
            const mutedMarker = symbol?.endsWith('-open')
                ? { color: '#999999', opacity: 0.3 }
                : { color: 'rgba(0,0,0,0)', opacity: 0.5, line: { color: '#999999', width: 1 } };
            traces.push({
                x: g.x,
                y: g.y,
                z: mode === "3D" ? g.z : undefined,
                visible: state !== 'hidden',
                mode: 'markers',
                type: mode === "3D" ? 'scatter3d' : 'scatter',
                name: g.shape ? `${key} · ${g.shape}` : key,
                marker: {
                    size: markerSizeFor(mode, symbol),
                    ...(symbol ? { symbol } : {}),
                    ...(state === 'muted'
                        ? mutedMarker
                        : { color: key === 'Noise' ? '#8a8a8a' : colors[i % colors.length], opacity: key === 'Noise' ? 0.35 : 0.7 }),
                },
                hovertemplate
            });
        });
    } else {
        // Single trace: the columnar arrays go to Plotly as-is, no reshaping.
        // Continuous fields get a Viridis colorscale, overflowing categoricals a flat color.
        // A shape variable splits this into one trace per symbol; the colorscale is
        // then pinned to the full range so the split traces stay directly comparable.
        let cmin = Infinity, cmax = -Infinity;
        if (kind === "continuous") {
            for (const v of colorVals) {
                if (typeof v !== 'number') continue;
                if (v < cmin) cmin = v;
                if (v > cmax) cmax = v;
            }
        }
        const markerFor = (vals: any[], symbol?: string) => ({
            size: markerSizeFor(mode, symbol),
            opacity: 0.7,
            ...(kind === "continuous"
                ? { color: vals, colorscale: 'Viridis', showscale: false, cmin, cmax }
                : { color: '#4195DE' })
        });
        const base = {
            mode: 'markers',
            type: mode === "3D" ? 'scatter3d' : 'scatter',
            hovertemplate
        };
        if (!shapeOn) {
            traces.push({ ...base, x: px, y: py, z: mode === "3D" ? pz : undefined, name: colorField, marker: markerFor(colorVals) });
        } else {
            const buckets: Record<string, { x: any[], y: any[], z: any[], c: any[] }> = {};
            for (let i = 0; i < n; i++) {
                const sval = shapeAt(i)!;
                const b = (buckets[sval] ??= { x: [], y: [], z: [], c: [] });
                b.x.push(px[i]); b.y.push(py[i]); b.z.push(pz[i]); b.c.push(colorVals[i]);
            }
            shapeCats.filter(s => buckets[s]).forEach(s => {
                const b = buckets[s];
                traces.push({
                    ...base,
                    x: b.x, y: b.y, z: mode === "3D" ? b.z : undefined,
                    name: s,
                    marker: { ...markerFor(b.c, symbolFor[s]), symbol: symbolFor[s] },
                });
            });
        }
    }

    if (mode === "3D") {
        // Single pass for bounds — spreading large arrays into Math.min/max blows the call stack.
        // Hidden categories are excluded so they don't stretch the axes or cast shadows.
        const hasHidden = kind === "categorical" && Object.values(muted).includes('hidden');
        let x_min = Infinity, x_max = -Infinity, y_min = Infinity, y_max = -Infinity, z_min = Infinity, z_max = -Infinity;
        const shadow_x: number[] = [], shadow_y: number[] = [];
        const SHADOW_TARGET = 4000;
        const shadowStride = n > SHADOW_TARGET ? Math.ceil(n / SHADOW_TARGET) : 1;
        for (let i = 0; i < n; i++) {
            if (hasHidden && muted[String(colorVals[i] ?? "N/A")] === 'hidden') continue;
            if (px[i] != null) {
                if (px[i] < x_min) x_min = px[i];
                if (px[i] > x_max) x_max = px[i];
            }
            if (py[i] != null) {
                if (py[i] < y_min) y_min = py[i];
                if (py[i] > y_max) y_max = py[i];
            }
            if (pz[i] != null) {
                if (pz[i] < z_min) z_min = pz[i];
                if (pz[i] > z_max) z_max = pz[i];
            }
            // The shadow is decoration at opacity 0.1 and size 2, so above a few
            // thousand points a decimated copy is indistinguishable — and it
            // halves both the array copy and the GPU point count (F15).
            if (px[i] != null && py[i] != null && (shadowStride === 1 || i % shadowStride === 0)) {
                shadow_x.push(px[i]);
                shadow_y.push(py[i]);
            }
        }
        if (x_min === Infinity || y_min === Infinity || z_min === Infinity) return traces;
        // Proportional floor offset: a fixed -0.5 dwarfed small-range axes
        // (e.g. rates in [0, 0.4]), shoving the data into the middle of the axis
        const z_span = z_max - z_min;
        const z_floor = z_min - (z_span > 0 ? z_span * 0.08 : 0.5);

        // The shadow floor must contrast with the canvas: near-black on light
        // themes, pale gray on the terminal theme's black background
        const shadowColor = dark ? '#d8d8d8' : '#111111';
        // The ground shadow and its mesh floor are decoration. In the live view
        // they read well; in a shared HTML file they are a second full copy of
        // every x and y plus an n-length array of one repeated constant, which
        // measured 1,070 KB of a 3,831 KB export (finding F3).
        if (includeFloor) {
        traces.push({
            x: shadow_x,
            y: shadow_y,
            z: new Array(shadow_x.length).fill(z_floor),
            mode: 'markers',
            type: 'scatter3d',
            marker: { size: 2, color: shadowColor, opacity: 0.1 },
            showlegend: false,
            hoverinfo: 'skip'
        });

        traces.push({
            x: [x_min, x_max, x_max, x_min],
            y: [y_min, y_min, y_max, y_max],
            z: [z_floor, z_floor, z_floor, z_floor],
            type: 'mesh3d',
            color: shadowColor,
            opacity: 0.05,
            showlegend: false,
            hoverinfo: 'skip'
        });
        }
    }

    return traces;
};

// An orbit derived FROM a camera rather than replacing it. Both the live
// rotation loop and the GIF export used to hard-code radius 2.2 / elevation 0.6,
// so each of them silently threw away whatever the user had dragged to — and the
// GIF then disagreed with the screen it was exported from.
const orbitFrom = (cam: SceneCamera | null | undefined) => {
  const e = cam?.eye ?? DEFAULT_CAMERA.eye;
  const fallback = Math.hypot(DEFAULT_CAMERA.eye.x, DEFAULT_CAMERA.eye.y);
  const radius = Math.hypot(e.x, e.y) || fallback;
  const elevation = e.z;
  const rest: Partial<SceneCamera> = {};
  if (cam?.center) rest.center = { ...cam.center };
  if (cam?.up) rest.up = { ...cam.up };
  if (cam?.projection) rest.projection = { ...cam.projection };
  return {
    /** Azimuth the camera is currently at, so an orbit starts where the eye is. */
    start: Math.atan2(e.y, e.x),
    /** center / up / projection, preserved verbatim. */
    rest,
    eyeAt: (angle: number) => ({
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
      z: elevation,
    }),
  };
};

// The starting 3-D viewpoint, and what "Reset view" returns to. Was written out
// as a literal in three places, which is one more than can be kept in step.
//
// (1.8, 1.2, 0.5) sat at 13 degrees elevation — nearly edge-on. A cube seen from
// there projects wide and flat: it overran the canvas left and right while
// leaving 191px of unused space above it, which is the "plot sits too low, and
// long plots clip off the bottom" complaint. Raising the eye to ~30 degrees and
// pulling back slightly (|eye| 2.22 -> 2.44) makes the cube present squarer, so
// it fits the width and uses the height.
/**
 * Shape of the 3-D box. 'cube' forces equal-length axes; 'data' makes each axis
 * length proportional to its own span, so a unit on one axis is the same length
 * as a unit on another.
 */
type AspectMode = 'cube' | 'data';
const DEFAULT_ASPECT: AspectMode = 'cube';

type Vec3 = { x: number; y: number; z: number };
type SceneCamera = {
  eye: Vec3;
  /** Look-at point. Shifting it moves the scene on screen without resizing it. */
  center?: Vec3;
  up?: Vec3;
  projection?: { type?: string };
};

const DEFAULT_CAMERA: SceneCamera = {
  eye: { x: 1.5, y: 1.5, z: 1.2 },
  // gl-plot3d leaves the box low in its viewport once the tick labels and axis
  // titles below it are accounted for — measured 155px of dead space above the
  // scene against 9px below. Looking slightly beneath the box centre lifts the
  // whole scene instead of shrinking it, which is what reducing the plot's
  // height or its domain would have done.
  center: { x: 0, y: 0, z: -0.12 },
};

const CHART_COLORS = ['#4195DE', '#D23B72', '#FFD600', '#5F4690', '#1D6996', '#38A6A5', '#0F8554', '#73AF48', '#EDAD08', '#E17C05'];

// Inline distribution sparkline for a numeric column
const MiniHistogram = ({ values, color }: { values: any[], color: string }) => {
    const bars = useMemo(() => {
        // Two passes over the column, no copy of it. The `values.filter(...)`
        // this replaces duplicated the whole column to compute fourteen bins —
        // 7.9 ms of the component's 12.7 ms at 200k rows (finding F14).
        let min = Infinity, max = -Infinity, count = 0;
        for (const v of values) {
            if (typeof v !== 'number' || Number.isNaN(v)) continue;
            count++;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        if (count < 2 || min === max) return null;
        const N = 14;
        const counts = new Array(N).fill(0);
        const scale = N / (max - min);
        for (const v of values) {
            if (typeof v !== 'number' || Number.isNaN(v)) continue;
            counts[Math.min(N - 1, Math.floor((v - min) * scale))]++;
        }
        let peak = 0;
        for (const c of counts) if (c > peak) peak = c;
        return counts.map(c => c / peak);
    }, [values]);
    if (!bars) return null;
    return (
        <svg width="56" height="16" className="flex-shrink-0 opacity-80" aria-hidden="true">
            {bars.map((h, i) => (
                <rect key={i} x={i * 4} y={16 - Math.max(1, h * 16)} width="3" height={Math.max(1, h * 16)} fill={color} />
            ))}
        </svg>
    );
};

// Proportion bar of the top categories for a categorical column
const MiniCatBar = ({ values }: { values: any[] }) => {
    const segs = useMemo(() => {
        const counts = new Map<string, number>();
        let total = 0;
        for (const v of values) {
            if (v == null) continue;
            const k = String(v);
            counts.set(k, (counts.get(k) ?? 0) + 1);
            total++;
        }
        if (!total) return null;
        return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([k, c]) => ({ k, frac: c / total }));
    }, [values]);
    if (!segs) return null;
    let acc = 0;
    return (
        <svg width="56" height="16" className="flex-shrink-0 opacity-80" aria-hidden="true">
            {segs.map((s, i) => {
                const x = acc * 56;
                acc += s.frac;
                return <rect key={s.k} x={x} y={4} width={Math.max(1, s.frac * 56 - 1)} height={8} fill={CHART_COLORS[i % CHART_COLORS.length]} />;
            })}
        </svg>
    );
};

// One row per column: profile (kind, range, missing, sparkline) plus one-click
// plot assignment — X/Y/Z axis for numeric columns, C (color) for any column.
// This is the app's data inspector and its variable picker in one surface.
const VariablesPanel = ({ dataset, viewMode, colorBy, shapeBy, theme, onAxis, onColor, onShape }: {
    dataset: Dataset, viewMode: "3D" | "2D", colorBy: string, shapeBy: string, theme: string | undefined,
    onAxis: (axis: 'x' | 'y' | 'z', col: string) => void, onColor: (col: string) => void, onShape: (col: string) => void,
}) => {
    const table = dataset.table;
    const axes = viewMode === "2D" ? { ...dataset.axes2d, z: null as string | null } : dataset.axes;
    // The shared scan (F14). This pass used to be written out here, again in
    // PCASection and again in ClusterBreakdown, three times per table change.
    const profiles = useMemo(
        () => scanTable(table).map(s => ({ ...s, vals: table.data[s.col] ?? [] })),
        [table],
    );

    const fmt = (v: number) => Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, '');
    // Assignment buttons carry the Bauhaus triad in primary; terminal goes green
    const AXIS_STYLE: Record<string, string> = { x: 'var(--p-red)', y: 'var(--p-blue)', z: 'var(--p-yellow)', c: 'var(--p-black)', s: 'var(--p-white)' };
    const activeStyle = (slot: string) => theme === 'primary'
        ? { backgroundColor: AXIS_STYLE[slot], color: slot === 'z' || slot === 's' ? '#111111' : '#FFFFFF', borderColor: '#111111' }
        : { backgroundColor: 'var(--system-green)', color: '#000000', borderColor: 'var(--system-green)' };

    const slotTitle = (slot: string, col: string, active: boolean) =>
        slot === 'c' ? `Color by ${col}`
        : slot === 's' ? (active ? `Stop encoding ${col} as marker shape` : `Encode ${col} as marker shape`)
        : `Plot ${col} on the ${slot.toUpperCase()} axis`;

    const slotBtn = (slot: 'x' | 'y' | 'z' | 'c' | 's', p: { col: string }, active: boolean, disabled = false) => (
        <button
            key={slot}
            disabled={disabled}
            onClick={() => slot === 'c' ? onColor(p.col) : slot === 's' ? onShape(p.col) : onAxis(slot, p.col)}
            title={slotTitle(slot, p.col, active)}
            className="w-5 h-5 text-[9px] font-bold uppercase border flex items-center justify-center transition-colors disabled:opacity-20 cursor-pointer"
            style={active ? activeStyle(slot) : { borderColor: 'var(--border)', opacity: 0.45 }}
        >
            {slot}
        </button>
    );

    return (
        <div className="space-y-0.5 max-h-[380px] overflow-y-auto pr-1 -mr-1">
            {profiles.map(p => {
                const kind = p.isNumeric ? null : getColorFieldKind(p.vals);
                return (
                    <div key={p.col} className="flex items-center gap-2 py-1.5 border-b border-[var(--border)]/15">
                        <div className="flex-1 min-w-0">
                            <div className="text-xs font-bold truncate" title={p.col}>{p.col}</div>
                            <div className="text-[10px] opacity-50 truncate">
                                {p.isNumeric
                                    ? `${fmt(p.min)} – ${fmt(p.max)}`
                                    : `${p.nUnique} categories`}
                                {p.missing > 0 && ` · ${p.missing} NA`}
                            </div>
                        </div>
                        {p.isNumeric
                            ? <MiniHistogram values={p.vals} color={theme === 'primary' ? '#0045AD' : '#10ff50'} />
                            : <MiniCatBar values={p.vals} />}
                        <div className="flex gap-0.5 flex-shrink-0">
                            {p.isNumeric && slotBtn('x', p, axes.x === p.col)}
                            {p.isNumeric && slotBtn('y', p, axes.y === p.col)}
                            {p.isNumeric && viewMode === "3D" && slotBtn('z', p, axes.z === p.col)}
                            {kind !== 'too-many' && slotBtn('c', p, colorBy === p.col)}
                            {/* Shape only reads at low cardinality — offered for any
                                column inside the cap, numeric Likert scales included */}
                            {p.nUnique > 1 && p.nUnique <= MAX_SHAPE_CATEGORIES && slotBtn('s', p, shapeBy === p.col)}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

// First-run landing: an abstract scatter built from the Bauhaus glyphs, three
// steps, and a zero-friction demo loader. Occupies the otherwise-blank canvas.
const EmptyState = ({ theme, onLoadDemo, onUpload, busy, dimmed }: { theme: string | undefined, onLoadDemo: () => void, onUpload: () => void, busy: boolean, dimmed: boolean }) => {
    const steps = [
        "Add a dataset — CSV, XLSX, or Parquet",
        "Assign variables to X · Y · Z and color",
        "Cluster, pin comparisons, export",
    ];
    // During the walkthrough the card is scenery, not a control surface: the
    // tour's own anchored button is the one way forward, and two more live
    // buttons underneath it would compete with it (and the dropzone pointer).
    const dimCls = dimmed ? ' opacity-40 pointer-events-none select-none' : '';

    if (theme === 'terminal') {
        return (
            <div className={`w-full h-full flex items-center justify-center${dimCls}`} aria-hidden={dimmed || undefined}>
                <div className="max-w-md w-full mx-6 border border-[var(--system-green)]/40 bg-black/60 p-8 space-y-5">
                    <div className="text-[var(--system-green)] text-lg font-bold tracking-widest uppercase system-green-glow">Awaiting data_</div>
                    <div className="space-y-2">
                        {steps.map((s, i) => (
                            <div key={i} className="flex gap-3 text-sm text-[var(--foreground)]">
                                <span className="text-[var(--system-green)] flex-shrink-0">[{i + 1}]</span>
                                <span>{s}</span>
                            </div>
                        ))}
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={onUpload}
                            disabled={busy}
                            className="flex-1 py-2 text-sm font-bold bg-[var(--system-green)]/15 border border-[var(--system-green)] text-[var(--system-green)] hover:bg-[var(--system-green)]/25 disabled:opacity-40 cursor-pointer"
                        >
                            {"> upload data"}
                        </button>
                        <button
                            onClick={onLoadDemo}
                            disabled={busy}
                            className="flex-1 py-2 text-sm font-bold border border-[var(--system-green)]/60 text-[var(--system-green)]/80 hover:bg-[var(--system-green)]/10 disabled:opacity-40 cursor-pointer"
                        >
                            {busy ? "loading…" : "> load demo"}
                        </button>
                    </div>
                    <p className="text-[11px] text-[var(--foreground)]/60">
                        <span className="text-[var(--system-green)]">load demo</span> opens a five-minute guided walkthrough of the Iris data — click-through, no API key. Skip it any time.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className={`w-full h-full flex items-center justify-center${dimCls}`} aria-hidden={dimmed || undefined}>
            <div className="max-w-md w-full mx-6 bg-white border-[3px] border-[#111111] shadow-[8px_8px_0px_#111111] p-8 space-y-6">
                <svg viewBox="0 0 336 120" className="w-full" aria-hidden="true">
                    {/* faint grid */}
                    {Array.from({ length: 7 }, (_, i) => (
                        <line key={`v${i}`} x1={i * 56} y1="0" x2={i * 56} y2="120" stroke="#111111" strokeOpacity="0.08" />
                    ))}
                    {Array.from({ length: 4 }, (_, i) => (
                        <line key={`h${i}`} x1="0" y1={i * 40} x2="336" y2={i * 40} stroke="#111111" strokeOpacity="0.08" />
                    ))}
                    {/* three loose clusters of the three glyphs */}
                    {[[38, 84], [62, 96], [50, 70], [82, 88], [70, 108]].map(([x, y], i) => (
                        <rect key={`sq${i}`} x={x - 6} y={y - 6} width="12" height="12" fill="#0045AD" stroke="#111111" strokeWidth="2" />
                    ))}
                    {[[168, 34], [192, 22], [180, 50], [210, 40], [156, 54]].map(([x, y], i) => (
                        <circle key={`ci${i}`} cx={x} cy={y} r="7" fill="#EB1A26" stroke="#111111" strokeWidth="2" />
                    ))}
                    {[[272, 78], [296, 92], [284, 62], [310, 72], [264, 100]].map(([x, y], i) => (
                        <path key={`tr${i}`} d={`M ${x - 8} ${y + 6} L ${x} ${y - 8} L ${x + 8} ${y + 6} Z`} fill="#FFD600" stroke="#111111" strokeWidth="2" />
                    ))}
                </svg>
                <div>
                    <h2 className="text-lg font-bold leading-tight">See the shape of your data.</h2>
                    <p className="text-xs opacity-60 mt-1">Plot any variables in 2D or 3D, color by anything, find the clusters.</p>
                </div>
                <div className="space-y-2.5">
                    {steps.map((s, i) => (
                        <div key={i} className="flex items-center gap-3 text-sm">
                            <span className="bauhaus-step" style={{ backgroundColor: STEP_COLORS[i].bg, color: STEP_COLORS[i].fg }}>{i + 1}</span>
                            <span>{s}</span>
                        </div>
                    ))}
                </div>
                <div className="flex gap-3">
                    <button
                        onClick={onUpload}
                        disabled={busy}
                        className="bauhaus-btn flex-1 py-2.5 text-sm font-bold bg-[var(--p-blue)] text-white disabled:opacity-40 cursor-pointer"
                    >
                        Upload data
                    </button>
                    <button
                        onClick={onLoadDemo}
                        disabled={busy}
                        className="bauhaus-btn flex-1 py-2.5 text-sm font-bold bg-[var(--p-yellow)] text-[#111111] disabled:opacity-40 cursor-pointer"
                    >
                        {busy ? "Loading…" : "Load demo"}
                    </button>
                </div>
                <p className="text-[11px] opacity-50 text-center -mt-2">
                    <span className="font-bold">Load demo</span> opens a five-minute guided walkthrough of the Iris data — click-through, no API key. Skip it any time.
                </p>
            </div>
        </div>
    );
};

// In-app PCA: pick variables, pick k, run — scores land as PC columns and the
// scree bars show what each component buys you.
const PCASection = ({ table, datasetId, theme, lastRun, runs, onRun, externalRun }: {
    table: DataTable,
    datasetId: number,
    theme: string | undefined,
    lastRun: { varianceExplained: number[]; cumulative: number[]; spectrum?: number[]; eigenvalues?: number[]; standardize?: boolean; k?: number; columns?: string[] } | null,
    runs: PcaRun[],
    onRun: (vars: string[], k: number, standardize: boolean, label: string, missing: MissingStrategy) => void,
    // A run started outside this panel — by the assistant or the walkthrough.
    // `seq` increments per run so a repeat of the same settings still syncs.
    externalRun?: { vars: string[]; k: number; standardize: boolean; missing: MissingStrategy; label: string; seq: number } | null,
}) => {
    // Component columns (bare or labeled) don't feed new PCAs; COMP_ composites
    // stay selectable on purpose — feeding composites into a second-order PCA
    // is a legitimate technique.
    const numericVars = useMemo(
        () => numericColumnsOf(table).filter(c => !isPCColumn(c) && c !== 'Cluster'),
        [table]
    );
    const [selected, setSelected] = useState<Set<string>>(() => new Set(numericVars));
    const [k, setK] = useState(3);
    const [standardize, setStandardize] = useState(true);
    const [missing, setMissing] = useState<MissingStrategy>('median');
    const [label, setLabel] = useState('');
    // Auto-suggest tracks the selection until the user types a label of their
    // own; a cleared field re-arms the suggestion.
    const labelTouched = useRef(false);
    // Replacement confirm: what's waiting for an OK, and whether the user has
    // opted out of being asked (persisted).
    const [pendingRun, setPendingRun] = useState<{ vars: string[]; k: number; standardize: boolean; label: string; missing: MissingStrategy; replaces: string[] } | null>(null);
    // New dataset → fresh default selection and label. A mere table change
    // (a run adding columns) must NOT reset — that would wipe the user's
    // subset selection mid-iteration — it only prunes columns that vanished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { setSelected(new Set(numericVars)); setLabel(''); labelTouched.current = false; }, [datasetId]);
    const varsKey = numericVars.join('\u0000');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { setSelected(prev => new Set(Array.from(prev).filter(c => numericVars.includes(c)))); }, [varsKey]);
    // A run started from the assistant or the walkthrough leaves the panel
    // showing what it actually ran. Without this the controls kept their
    // defaults while the run used something else — so the walkthrough could
    // point at the PCA section, say "Id is excluded", and have Id ticked.
    const externalSeq = externalRun?.seq ?? 0;
    useEffect(() => {
        if (!externalRun) return;
        setSelected(new Set(externalRun.vars.filter(c => numericVars.includes(c))));
        setK(externalRun.k);
        setStandardize(externalRun.standardize);
        setMissing(externalRun.missing);
        // The run's own label, and pinned: the auto-suggestion derives a label
        // from shared affixes in the selection, which on the four Iris columns
        // is "thCm" — a name for columns the run did not create. The panel is
        // reporting a finished run here, not composing the next one.
        setLabel(externalRun.label);
        labelTouched.current = true;
        // Keyed on the sequence number alone: this fires per external RUN, not
        // whenever the object identity or the column list happens to change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [externalSeq]);
    useEffect(() => {
        if (labelTouched.current) return;
        setLabel(selected.size === numericVars.length ? '' : (deriveRunLabel(Array.from(selected)) ?? ''));
    }, [selected, numericVars.length]);

    // Per-variable missingness for the picker. methods.ts (pca_workflow) advises
    // dropping columns above ~50% missing rather than imputing them — at that
    // level an imputed column is mostly one repeated value, which enters the
    // correlation matrix as a near-constant.
    const missingPct = useMemo(() => {
        const out: Record<string, number> = {};
        for (const c of numericVars) {
            const vals = table.data[c] ?? [];
            let have = 0;
            for (const v of vals) if (typeof v === 'number') have++;
            out[c] = table.nRows ? (1 - have / table.nRows) * 100 : 0;
        }
        return out;
    }, [numericVars, table]);
    const heavilyMissing = Array.from(selected).filter(c => (missingPct[c] ?? 0) > 50);
    // Rows with no gap across the current selection — what complete-case would keep.
    const completeRows = useMemo(() => {
        const sel = Array.from(selected).filter(c => numericVars.includes(c));
        if (!sel.length) return table.nRows;
        let count = 0;
        for (let i = 0; i < table.nRows; i++) {
            if (sel.every(c => typeof (table.data[c] ?? [])[i] === 'number')) count++;
        }
        return count;
    }, [selected, numericVars, table]);

    const toggle = (c: string) => setSelected(prev => {
        const next = new Set(prev);
        if (next.has(c)) next.delete(c); else next.add(c);
        return next;
    });
    const maxK = Math.max(1, Math.min(10, selected.size));
    // The full spectrum drives the height, since it is what gets drawn (B4).
    const screeBars = lastRun ? (lastRun.spectrum ?? lastRun.varianceExplained) : [];
    const screeMaxBarHeight = screeBars.length ? Math.max(...screeBars.map(v => v * 100 * 1.4)) : 0;
    // Reserve the label line too. A high-variance first component should grow
    // the chart rather than spilling out of a fixed-height bar box.
    const screeHeight = Math.max(56, Math.ceil(screeMaxBarHeight) + 18);

    const submit = () => {
        const vars = Array.from(selected).filter(c => numericVars.includes(c));
        const cleanLabel = sanitizeLabel(label);
        const effK = Math.min(k, maxK);
        const existing = runs.find(r => r.label === cleanLabel);
        const suppressed = typeof localStorage !== 'undefined' && localStorage.getItem('scatterlab.pca.confirmReplace') === 'off';
        if (existing && !suppressed) {
            setPendingRun({ vars, k: effK, standardize, label: cleanLabel, missing, replaces: existing.columns });
            return;
        }
        onRun(vars, effK, standardize, cleanLabel, missing);
    };

    return (
        <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
                <span className="opacity-60">{selected.size}/{numericVars.length} variables</span>
                <span className="flex gap-2">
                    <button onClick={() => setSelected(new Set(numericVars))} className="underline-offset-2 hover:underline opacity-60 hover:opacity-100 cursor-pointer">all</button>
                    <button onClick={() => setSelected(new Set())} className="underline-offset-2 hover:underline opacity-60 hover:opacity-100 cursor-pointer">none</button>
                </span>
            </div>
            <div className="max-h-36 overflow-y-auto space-y-0.5 pr-1 border border-[var(--border)]/30 p-1.5">
                {numericVars.map(c => {
                    const miss = missingPct[c] ?? 0;
                    return (
                        <label key={c} className="flex items-center gap-2 cursor-pointer hover:opacity-80">
                            <input type="checkbox" checked={selected.has(c)} onChange={() => toggle(c)} />
                            <span className="truncate flex-1" title={c}>{c}</span>
                            {miss > 0 && (
                                <span
                                    className={`flex-shrink-0 text-[10px] ${miss > 50 ? 'font-bold text-[var(--p-red)]' : 'opacity-50'}`}
                                    title={`${miss.toFixed(0)}% of rows are missing this variable`}
                                >
                                    {miss.toFixed(0)}% NA
                                </span>
                            )}
                        </label>
                    );
                })}
                {numericVars.length === 0 && <div className="opacity-50 p-1">No numeric variables available.</div>}
            </div>
            <label className="flex justify-between items-center">
                <span className="opacity-70">Components: <b>{Math.min(k, maxK)}</b>{Math.min(k, maxK) === 1 ? ' (composite)' : ''}</span>
                <input type="range" min={1} max={maxK} step={1} value={Math.min(k, maxK)} onChange={e => setK(parseInt(e.target.value))} className="w-32" />
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={standardize} onChange={e => setStandardize(e.target.checked)} />
                <span className="opacity-80">Standardize variables (correlation PCA)</span>
                <InfoTip topic="standardize_pca" />
            </label>
            <input
                type="text"
                value={label}
                onChange={e => { labelTouched.current = e.target.value.trim().length > 0; setLabel(e.target.value); }}
                placeholder={selected.size < numericVars.length ? 'name this run (e.g. openness)' : 'run label (optional)'}
                title={'Names this run\'s columns: 1 component → COMP_<label>; several → PC1_<label>… Re-running the same label replaces its columns; different labels coexist, so subsets like "openness" and "neuroticism" can each keep their own scores. Empty = plain PC1…PCk.'}
                className="w-full bg-[var(--input)] border border-[var(--border)] p-1.5 text-xs outline-none"
            />
            {label && sanitizeLabel(label) && (
                <div className="text-[10px] opacity-50">
                    → {pcaColumnNames(sanitizeLabel(label), Math.min(k, maxK)).join(', ')}
                </div>
            )}
            <div className="space-y-1">
                <span className="opacity-70">Missing values<InfoTip topic="median_imputation" /></span>
                <div className="flex gap-1">
                    {([['median', 'Median'], ['iterative', 'Iterative PCA'], ['complete', 'Complete cases']] as const).map(([v, lbl]) => (
                        <button
                            key={v}
                            onClick={() => setMissing(v)}
                            className={`flex-1 py-1 text-[10px] font-bold border ${missing === v
                                ? 'bg-[var(--foreground)] text-[var(--background)] border-[var(--foreground)]'
                                : 'bg-[var(--input)] border-[var(--border)] opacity-60 hover:opacity-100'}`}
                        >
                            {lbl}
                        </button>
                    ))}
                </div>
                {missing === 'complete' && (
                    <div className={`text-[10px] leading-snug ${completeRows < 3 ? 'text-[var(--p-red)]' : 'opacity-60'}`}>
                        {completeRows} of {table.nRows} rows have no gaps in this selection
                        {completeRows < table.nRows && ' — the rest will have no score'}.
                    </div>
                )}
            </div>
            {heavilyMissing.length > 0 && (
                <div className="text-[10px] leading-snug text-[var(--p-red)]">
                    ⚠ {heavilyMissing.map(c => `"${c}"`).join(', ')} {heavilyMissing.length === 1 ? 'is' : 'are'} over 50% missing.
                    Imputing that much makes a column mostly one repeated value; dropping it is usually better than filling it.
                </div>
            )}
            <button
                onClick={submit}
                disabled={selected.size < 2}
                className={`w-full text-sm font-bold py-2 disabled:opacity-40 cursor-pointer ${theme === 'primary' ? 'bauhaus-btn bg-[var(--p-blue)] text-white' : 'bg-[var(--input)] border border-[var(--border)] hover:bg-[var(--border)] text-[var(--mauk)]'}`}
            >
                Run PCA
            </button>
            <p className="text-[10px] leading-snug opacity-60">
                Missing values are filled with the column median before the decomposition.
                <InfoTip topic="median_imputation" />
            </p>
            {/* Portalled to <body>: the sidebar is a positioned, scrolling
                stacking context, so a z-100 backdrop rendered inside it still
                sits BELOW the plot canvas in <main>. elementFromPoint at the
                Replace button returned the canvas, and neither Replace nor
                Cancel could be clicked once a plot was on screen. */}
            {pendingRun && typeof document !== 'undefined' && createPortal(
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={() => setPendingRun(null)}>
                    <div
                        className={`max-w-sm w-full mx-4 p-4 space-y-3 text-xs bg-[var(--card)] text-[var(--foreground)] ${theme === 'primary' ? 'border-[3px] border-[var(--p-black)]' : 'border border-[var(--system-green)]'}`}
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="font-bold text-sm">
                            Replace {pendingRun.label ? `"${pendingRun.label}"` : 'the unnamed PCA'}?
                        </div>
                        <p className="opacity-80">
                            A previous run with this label exists — running again replaces its
                            column{pendingRun.replaces.length > 1 ? 's' : ''} ({pendingRun.replaces.join(', ')}).
                            Use a different label to keep both.
                        </p>
                        <label className="flex items-center gap-2 cursor-pointer select-none opacity-70">
                            <input
                                type="checkbox"
                                onChange={e => localStorage.setItem('scatterlab.pca.confirmReplace', e.target.checked ? 'off' : 'on')}
                            />
                            Don't ask again
                        </label>
                        <div className="flex gap-2 justify-end">
                            <button
                                onClick={() => setPendingRun(null)}
                                className="px-3 py-1.5 border border-[var(--border)] hover:bg-[var(--border)] cursor-pointer"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => { onRun(pendingRun.vars, pendingRun.k, pendingRun.standardize, pendingRun.label, pendingRun.missing); setPendingRun(null); }}
                                className={`px-3 py-1.5 font-bold cursor-pointer ${theme === 'primary' ? 'bauhaus-btn bg-[var(--p-red)] text-white' : 'bg-[var(--system-green)]/20 border border-[var(--system-green)] text-[var(--system-green)]'}`}
                            >
                                Replace
                            </button>
                        </div>
                    </div>
                </div>,
                document.body,
            )}
            {lastRun && (
                <div className="space-y-1 pt-1 border-t border-[var(--border)]/40">
                    <div className="font-bold uppercase tracking-wider opacity-60 text-[10px]">
                        Scree — all components<InfoTip topic="variance_explained" />
                    </div>
                    {/* Every component, with the kept ones solid and the rest
                        faded (B4). Plotting only the kept ones made the chart
                        useless for the job the methods reference sends people
                        here to do: the Cattell elbow is invisible if the plot
                        stops at the elbow. */}
                    <div className="flex items-end gap-1" style={{ height: `${screeHeight}px` }}>
                        {screeBars.map((v, i) => {
                            const kept = i < (lastRun.k ?? lastRun.varianceExplained.length);
                            return (
                                <div key={i} className="flex-1 flex flex-col items-center gap-0.5" title={`${lastRun.columns?.[i] ?? `PC${i + 1}`}: ${(v * 100).toFixed(1)}% of variance${lastRun.eigenvalues ? `, eigenvalue ${lastRun.eigenvalues[i].toFixed(2)}` : ''}${kept ? ' — kept' : ' — not kept'}`}>
                                    <div className="w-full" style={{ height: `${Math.max(2, v * 100 * 1.4)}px`, backgroundColor: theme === 'primary' ? 'var(--p-blue)' : 'var(--system-green)', opacity: kept ? 0.85 : 0.25 }} />
                                    <span className="text-[9px]" style={{ opacity: kept ? 0.75 : 0.35 }}>{i + 1}</span>
                                </div>
                            );
                        })}
                    </div>
                    <div className="text-[10px] opacity-70">
                        {/* Uses the run's own column names (B6): a COMP_openness
                            run used to report its bar as "PC1". */}
                        {lastRun.varianceExplained.map((v, i) => `${lastRun.columns?.[i] ?? `PC${i + 1}`} ${(v * 100).toFixed(0)}%`).join(' · ')} — cumulative {(lastRun.cumulative[lastRun.cumulative.length - 1] * 100).toFixed(0)}%
                        {screeBars.length > lastRun.varianceExplained.length && (
                            <> · {screeBars.length - lastRun.varianceExplained.length} more component{screeBars.length - lastRun.varianceExplained.length === 1 ? '' : 's'} shown faded, not kept</>
                        )}
                    </div>
                    {lastRun.eigenvalues && lastRun.standardize && (
                        <div className="text-[10px] opacity-60">
                            Kaiser criterion (eigenvalue &gt; 1): {lastRun.eigenvalues.filter(e => e > 1).length} component{lastRun.eigenvalues.filter(e => e > 1).length === 1 ? '' : 's'}. A rule of thumb that tends to over-extract — read it beside the elbow, not instead of it.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

// Cluster × attribute cross-tab: per cluster, what share each attribute value
// holds. Pure client-side compute over the columnar table.
const ClusterBreakdown = ({ table, attr, onAttrChange, direction, onDirectionChange, palette, onPaletteChange }: {
    table: DataTable, attr: string, onAttrChange: (v: string) => void,
    direction: BreakdownDirection, onDirectionChange: (v: BreakdownDirection) => void,
    palette: HeatmapPalette, onPaletteChange: (v: HeatmapPalette) => void,
}) => {
    // 'cluster': composition within each cluster (denominator = cluster size).
    // 'group': where each attribute group's members land (denominator = group size) —
    // normalizes away base rates, so dominant groups stop swamping every cluster.
    const [isSaving, setIsSaving] = useState(false);
    const candidates = useMemo(
        () => categoricalColumnsOf(table).filter(c => c !== 'Cluster'),
        [table]
    );
    const effAttr = candidates.includes(attr) ? attr : candidates[0];
    const crosstab = useMemo(() => effAttr ? buildClusterCrosstab(table, effAttr) : null, [table, effAttr]);

    if (!crosstab || !effAttr) return null;
    const sections = direction === 'cluster' ? crosstab.byCluster : crosstab.byGroup;
    const sectionKeys = direction === 'cluster'
        ? Object.keys(sections).sort(sortClusterLabels)
        : Object.keys(sections).sort((a, b) => sections[b].total - sections[a].total || a.localeCompare(b));
    const saveHeatmap = async () => {
        if (isSaving) return;
        setIsSaving(true);
        try {
            await downloadClusterHeatmapPng({
                heatmap: buildClusterHeatmap(crosstab, direction),
                attribute: effAttr,
                palette,
            });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="space-y-2 text-xs border-t border-[var(--border)] pt-3 mt-1">
            <div className="flex items-center justify-between gap-2">
                <span className="font-bold uppercase tracking-wider opacity-60 text-[10px] flex-shrink-0">Cluster Info by</span>
                <select
                    className="flex-1 min-w-0 bg-[var(--input)] border border-[var(--border)] p-1 text-xs outline-none"
                    value={effAttr}
                    onChange={e => onAttrChange(e.target.value)}
                >
                    {candidates.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
            </div>
            <div className="flex gap-1">
                {(['cluster', 'group'] as const).map(d => (
                    <button
                        key={d}
                        onClick={() => onDirectionChange(d)}
                        className={`flex-1 py-1 text-[10px] font-bold border ${direction === d ? 'bg-[var(--foreground)] text-[var(--background)] border-[var(--foreground)]' : 'bg-[var(--input)] border-[var(--border)] opacity-60 hover:opacity-100'}`}
                    >
                        % of {d}
                    </button>
                ))}
            </div>
            <div className="flex gap-1.5">
                <select
                    aria-label="Heatmap palette"
                    className="min-w-0 flex-1 bg-[var(--input)] border border-[var(--border)] p-1 text-[10px] outline-none"
                    value={palette}
                    onChange={e => onPaletteChange(e.target.value as HeatmapPalette)}
                >
                    {HEATMAP_PALETTES.map(option => <option key={option} value={option}>{option}</option>)}
                </select>
                <button
                    onClick={saveHeatmap}
                    disabled={isSaving}
                    className="flex items-center justify-center gap-1 whitespace-nowrap border border-[var(--border)] bg-[var(--input)] px-2 py-1 text-[10px] font-bold hover:bg-[var(--foreground)] hover:text-[var(--background)] disabled:opacity-40"
                    title="Download the selected cluster composition as a PNG heatmap"
                >
                    <Download className="h-3 w-3" /> {isSaving ? 'Saving…' : 'Save heatmap'}
                </button>
            </div>
            <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                {sectionKeys.map(sk => {
                    const { total, counts } = sections[sk];
                    const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
                    return (
                        <div key={sk} className="leading-snug">
                            <div className="font-bold">{sk} <span className="opacity-50 font-normal">· n={total}</span></div>
                            {rows.slice(0, 8).map(([val, cnt]) => (
                                <div key={val} className="relative flex justify-between gap-2 px-1">
                                    <div className="absolute inset-y-0 left-0 bg-[var(--foreground)]/8" style={{ width: `${(cnt / total) * 100}%` }} />
                                    <span className="relative truncate opacity-80" title={val}>{val}</span>
                                    <span className="relative flex-shrink-0 opacity-70">{Math.round((cnt / total) * 100)}% <span className="opacity-60">({cnt})</span></span>
                                </div>
                            ))}
                            {rows.length > 8 && <div className="opacity-50 px-1">… +{rows.length - 8} more</div>}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

/**
 * Do these two datasets appear to be the same respondents in the same order?
 *
 * The manual panel has always run this and shown "Check (Id): 140/150 agree ⚠"
 * in red. The assistant path checked only that the row counts matched — and of
 * everything the assistant can do, an order-mode transfer is the one operation
 * that silently produces WRONG SCIENCE rather than a wrong-looking picture, so
 * it should be the best guarded, not the least (finding D3).
 *
 * Deliberately avoids PC/axis columns: those are recomputed per dataset and will
 * legitimately differ even when the respondents really are aligned.
 */
const alignmentProbe = (
  srcTable: DataTable, tgtTable: DataTable,
): { col: string; agree: number; total: number } | null => {
  if (srcTable.nRows !== tgtTable.nRows || tgtTable.nRows === 0) return null;
  const shared = srcTable.columns.filter(c => tgtTable.columns.includes(c));
  const isAxisLike = (c: string) => /^(PC\d|Axis|Component|COMP_)/i.test(c);
  const idLike = shared.find(c => /\bid\b/i.test(c) && !isAxisLike(c));
  const best = idLike ?? shared
    .filter(c => !isAxisLike(c))
    .map(c => ({ c, distinct: new Set(srcTable.data[c]).size }))
    .sort((a, b) => b.distinct - a.distinct)[0]?.c;
  if (!best) return null;
  const a = srcTable.data[best], b = tgtTable.data[best];
  let agree = 0;
  for (let i = 0; i < tgtTable.nRows; i++) if (String(a[i]) === String(b[i])) agree++;
  return { col: best, agree, total: tgtTable.nRows };
};

// Copy a column (typically a Cluster label) from another dataset into the active
// one, so e.g. romance-space points can be colored by sex-space clusters. The
// alignment guard matters: silently mis-joining respondents yields wrong science.
type TransferSpec = { sourceId: number, sourceCol: string, mode: 'order' | 'match', keyCol: string, name: string };
const ColumnTransfer = ({ datasets, activeId, onTransfer }: { datasets: Dataset[], activeId: number | null, onTransfer: (s: TransferSpec) => void }) => {
    const active = datasets.find(d => d.id === activeId) ?? null;
    const others = datasets.filter(d => d.id !== activeId);
    const [sourceId, setSourceId] = useState<number | null>(null);
    const [sourceCol, setSourceCol] = useState("");
    const [mode, setMode] = useState<'order' | 'match'>('order');
    const [keyCol, setKeyCol] = useState("");
    const [name, setName] = useState("");

    const src = others.find(d => d.id === sourceId) ?? others[0] ?? null;

    // Every hook below runs unconditionally, and the "nothing to show" return
    // sits under them. It used to sit HERE, above three useMemos — so a render
    // where `src` went null (the other dataset removed while this stayed
    // mounted) would run fewer hooks than the previous one and React would
    // throw. Latent rather than theoretical; adding a fourth hook made it worth
    // fixing rather than matching.
    const srcCols = src?.table.columns ?? [];
    const effSrcCol = srcCols.includes(sourceCol) ? sourceCol : (srcCols.includes('Cluster') ? 'Cluster' : srcCols[0]);
    // Memoized because `probe` below depends on it: computed inline this was a
    // fresh array every render, so the O(n*C) alignment scan re-ran on every
    // keystroke and every rotation frame whenever two datasets were loaded
    // (finding F14).
    const shared = useMemo(
        () => (src && active ? src.table.columns.filter(c => active.table.columns.includes(c)) : []),
        [src, active],
    );
    const effKey = shared.includes(keyCol) ? keyCol : shared[0];
    const countsMatch = !!src && !!active && src.table.nRows === active.table.nRows;
    const defaultName = `${effSrcCol}·${src?.name ?? ''}`;

    // Auto alignment probe (order mode): pick a stable identity/demographic column
    // to sanity-check row order — NOT a PC/axis score, which is recomputed per
    // dataset and will legitimately differ even when respondents ARE aligned.
    // Shared with the assistant's transfer_column, so both run the same check (D3).
    const probe = useMemo(
        () => (src && active && mode === 'order' && countsMatch
            ? alignmentProbe(src.table, active.table)
            : null),
        [mode, countsMatch, src, active],
    );

    const matchStats = useMemo(() => {
        if (!src || !active || mode !== 'match' || !effKey) return null;
        const sk = src.table.data[effKey], tk = active.table.data[effKey];
        const srcKeys = new Set(sk.map(String));
        const uniqueSrc = srcKeys.size === src.table.nRows;
        let matched = 0;
        for (let i = 0; i < active.table.nRows; i++) if (srcKeys.has(String(tk[i]))) matched++;
        return { matched, total: active.table.nRows, uniqueSrc };
    }, [mode, effKey, src, active]);

    const canTransfer = mode === 'order' ? countsMatch : (!!effKey && (matchStats?.matched ?? 0) > 0);

    if (!active || !src) return null;

    return (
        <div className="space-y-2 text-xs border-t border-[var(--border)] pt-3 mt-1">
            <div className="font-bold uppercase tracking-wider opacity-60 text-[10px]">Transfer column from another dataset</div>
            <div className="flex items-center gap-1.5">
                <span className="opacity-60 w-10 flex-shrink-0">From</span>
                <select className="flex-1 min-w-0 bg-[var(--input)] border border-[var(--border)] p-1 outline-none" value={src.id} onChange={e => setSourceId(Number(e.target.value))}>
                    {others.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
            </div>
            <div className="flex items-center gap-1.5">
                <span className="opacity-60 w-10 flex-shrink-0">Column</span>
                <select className="flex-1 min-w-0 bg-[var(--input)] border border-[var(--border)] p-1 outline-none" value={effSrcCol} onChange={e => setSourceCol(e.target.value)}>
                    {srcCols.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
            </div>
            <div className="flex gap-1">
                <button onClick={() => setMode('order')} className={`flex-1 py-1 text-[10px] font-bold border ${mode === 'order' ? 'bg-[var(--foreground)] text-[var(--background)] border-[var(--foreground)]' : 'bg-[var(--input)] border-[var(--border)] opacity-60'}`}>By row order</button>
                <button onClick={() => setMode('match')} disabled={!shared.length} className={`flex-1 py-1 text-[10px] font-bold border disabled:opacity-30 ${mode === 'match' ? 'bg-[var(--foreground)] text-[var(--background)] border-[var(--foreground)]' : 'bg-[var(--input)] border-[var(--border)] opacity-60'}`}>Match by column</button>
            </div>
            {mode === 'match' && (
                <div className="flex items-center gap-1.5">
                    <span className="opacity-60 w-10 flex-shrink-0">Key</span>
                    <select className="flex-1 min-w-0 bg-[var(--input)] border border-[var(--border)] p-1 outline-none" value={effKey} onChange={e => setKeyCol(e.target.value)}>
                        {shared.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                </div>
            )}
            {/* alignment feedback */}
            {mode === 'order' && (
                countsMatch ? (
                    <div className="opacity-70">
                        {active.table.nRows} rows, aligned by position.
                        {probe && <span className={probe.agree === probe.total ? ' text-green-600' : ' text-red-500'}> {' '}Check ({probe.col}): {probe.agree}/{probe.total} agree {probe.agree === probe.total ? '✓' : '⚠'}</span>}
                    </div>
                ) : (
                    <div className="text-red-500">Row counts differ ({src.table.nRows} vs {active.table.nRows}) — use Match by column.</div>
                )
            )}
            {mode === 'match' && matchStats && (
                <div className={matchStats.matched === matchStats.total ? 'text-green-600' : 'opacity-70'}>
                    {matchStats.matched}/{matchStats.total} rows matched{!matchStats.uniqueSrc && <span className="text-red-500"> · ⚠ key not unique in source</span>}
                </div>
            )}
            <div className="flex items-center gap-1.5">
                <span className="opacity-60 w-10 flex-shrink-0">Save as</span>
                <input type="text" className="flex-1 min-w-0 bg-[var(--input)] border border-[var(--border)] p-1" value={name} onChange={e => setName(e.target.value)} placeholder={defaultName} />
            </div>
            <button
                onClick={() => onTransfer({ sourceId: src.id, sourceCol: effSrcCol, mode, keyCol: effKey, name: name.trim() || defaultName })}
                disabled={!canTransfer}
                className="w-full py-1.5 text-xs font-bold border border-[var(--border)] bg-[var(--input)] hover:bg-[var(--border)] disabled:opacity-30"
            >
                Transfer →
            </button>
        </div>
    );
};

// Memoizes trace construction so camera/rotation re-renders don't rebuild the
// (potentially large) data arrays every frame — Plotly.react then diffs cheaply.
// Module-level (not inside Home): inline component definitions get a fresh
// identity per render, so React remounts their whole subtree on every state
// change — losing input focus and recreating plot divs.
// Ephemeral on-screen pointer: scrolls the target into view, then rings it and
// bounces an arrow beside it for ~5s. Position is re-read on an interval so it
// tracks sidebar scrolling and layout shifts while visible.
const GUIDE_SECTION: Record<string, string> = {
    workspace: 'workspace',
    'upload-dropzone': 'data',
    'add-dataset': 'data',
    'components-toggle': 'data',
    'datasets-list': 'data',
    variables: 'variables',
    pca: 'pca',
    cluster: 'cluster',
    analyze: 'analyze',
    'table-view': 'data',
    view: 'view',
    export: 'export',
};

// Returns a disposer, or null when the target is not on screen.
//
// `persist` exists for the scripted walkthrough. The 5.4 s timeout is right for
// the assistant, which points while it is talking; in a click-to-advance tour a
// user reading a paragraph for twenty seconds would watch the pointer die on
// them, so the walkthrough holds the ring and drops it when the step changes.
const flashGuide = (target: string, color: string, persist = false, showArrow = true): (() => void) | null => {
    let el = document.querySelector(`[data-guide="${target}"]`) as HTMLElement | null;
    // Puxel's Accordion only mounts an item's body while open. When the
    // assistant is aiming at a hidden control, open its titled section first
    // and let the ring move from that header to the actual target on render.
    if (!el) {
        const section = GUIDE_SECTION[target];
        el = section ? document.querySelector(`[data-guide="${section}"]`) as HTMLElement | null : null;
        const trigger = el?.closest('[data-scatter-section]')?.querySelector<HTMLButtonElement>('.px-accordion-trigger');
        if (trigger?.getAttribute('aria-expanded') === 'false') trigger.click();
    }
    if (!el) return null;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const ring = document.createElement('div');
    const arrow = document.createElement('div');
    ring.style.cssText = `position:fixed;z-index:95;pointer-events:none;border:3px solid ${color};box-shadow:0 0 0 3px rgba(255,214,0,.4);border-radius:4px;`;
    arrow.textContent = '◀';
    arrow.style.cssText = `position:fixed;z-index:95;pointer-events:none;color:${color};font-size:22px;font-weight:bold;text-shadow:0 1px 3px rgba(0,0,0,.35);${showArrow ? '' : 'display:none;'}`;
    document.body.append(ring, arrow);
    const place = () => {
        const current = document.querySelector(`[data-guide="${target}"]`) as HTMLElement | null ?? el;
        const r = current.getBoundingClientRect();
        // generous padding so the target sits fully inside the ring
        const pad = 12;
        ring.style.left = `${r.left - pad}px`;
        ring.style.top = `${r.top - pad}px`;
        ring.style.width = `${r.width + pad * 2}px`;
        ring.style.height = `${r.height + pad * 2}px`;
        arrow.style.left = `${r.right + pad + 6}px`;
        arrow.style.top = `${r.top + r.height / 2 - 13}px`;
    };
    place();
    const tracker = setInterval(place, 100);
    // Infinite while held; the pulse is what makes it read as a pointer rather
    // than a border, so it keeps running for as long as the ring is up.
    const iterations = persist ? Infinity : 6;
    ring.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 900, iterations });
    arrow.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], { duration: 600, iterations: persist ? Infinity : 9 });
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearInterval(tracker);
        clearTimeout(timer);
        ring.remove();
        arrow.remove();
    };
    const timer = persist ? undefined : setTimeout(dispose, 5400);
    return dispose;
};

// Steps cycle through the Bauhaus triad; yellow flips to black text for contrast
const STEP_COLORS = [
    { bg: 'var(--p-red)', fg: '#FFFFFF' },
    { bg: 'var(--p-blue)', fg: '#FFFFFF' },
    { bg: 'var(--p-yellow)', fg: '#111111' },
];

// Keep an opened sidebar section in view without turning every accordion click
// into a distracting recenter. Extra-tall sections align their header instead:
// no scroll position can make an oversized panel fully visible at once.
const revealOpenedSidebarSection = (event: { target: EventTarget | null }, section: HTMLElement) => {
    const trigger = event.target instanceof Element ? event.target.closest('button') : null;
    if (!trigger) return;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const expanded = trigger.getAttribute('aria-expanded') === 'true' || trigger.textContent?.trim() === '▾';
        if (!expanded) return;
        const sidebar = section.closest('aside');
        if (!sidebar) return;
        const frame = sidebar.getBoundingClientRect();
        const box = section.getBoundingClientRect();
        const inset = 12;
        const top = frame.top + inset;
        const bottom = frame.bottom - inset;
        const availableHeight = bottom - top;
        let delta = 0;
        if (box.height > availableHeight) delta = box.top - top;
        else if (box.bottom > bottom) delta = box.bottom - bottom;
        else if (box.top < top) delta = box.top - top;
        if (Math.abs(delta) > 1) sidebar.scrollBy({ top: delta, behavior: 'smooth' });
    }));
};

// CyberContainer exposes only its tiny chevron as a toggle. Make the complete
// header a forgiving pointer target while retaining the package button for
// keyboard access and its aria-expanded state.
const toggleTerminalSectionFromHeader = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const header = target?.closest('header');
    const toggle = header?.querySelector<HTMLButtonElement>('button[type="button"]');
    if (header && toggle && !target?.closest('button')) toggle.click();
    revealOpenedSidebarSection(event, event.currentTarget);
};

const SidebarSection = ({ title, step, children, hasBorder = false, theme, guide, order }: { title: string, step?: number, children: React.ReactNode, hasBorder?: boolean, theme: string | undefined, guide?: string, order?: number }) => {
    const sectionId = guide ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (theme === 'terminal') {
        return (
            <div data-guide={guide} data-scatter-section={sectionId} style={{ order }} onClick={toggleTerminalSectionFromHeader}>
                <CyberContainer title={step != null ? `${step}. ${title}` : title} collapsible defaultOpen width={"100%" as any} className="scatterlab-terminal-accordion [&>header]:!px-2 [&>div]:!px-2">
                    {children}
                </CyberContainer>
            </div>
        );
    }
    const c = step != null ? STEP_COLORS[(step - 1) % STEP_COLORS.length] : null;
    if (theme === 'primary') {
        return (
            // data-guide sits on the whole section, not the title: it used to be
            // on the heading span below, so pointing at "variables" ringed three
            // words of header while the panel being described sat outside the
            // ring. The terminal branch above always anchored the section, which
            // is why only this theme looked wrong.
            <div data-guide={guide ?? sectionId} data-scatter-section={sectionId} style={{ order }} onClick={event => revealOpenedSidebarSection(event, event.currentTarget)}>
                <AccordionItem
                    value={sectionId}
                    title={
                        <span role="heading" aria-level={2} className="scatterlab-primary-accordion-title">
                            {c && <span className="bauhaus-step" style={{ backgroundColor: c.bg, color: c.fg }}>{step}</span>}
                            <span>{title}</span>
                        </span>
                    }
                >
                    <div className="space-y-3">{children}</div>
                </AccordionItem>
            </div>
        );
    }
    return (
        <div data-guide={guide} style={{ order }} className={`space-y-3 ${hasBorder ? 'border-t border-[var(--border)] pt-6' : ''}`}>
            <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
                {c && <span className="bauhaus-step" style={{ backgroundColor: c.bg, color: c.fg }}>{step}</span>}
                <span className="opacity-60">{title}</span>
            </h2>
            {children}
        </div>
    );
};

const SidebarGroup = ({ children, theme }: { children: React.ReactNode, theme: string | undefined }) => {
    if (theme === 'terminal') {
        return <CyberStackGroup className="flex-grow flex flex-col !space-y-0 gap-3">{children}</CyberStackGroup>;
    }
    if (theme === 'primary') {
        return (
            <Accordion
                multiple
                defaultOpen={['workspace', 'data', 'variables', 'pca', 'cluster', 'view', 'export']}
                className="scatterlab-primary-accordion"
            >
                {children}
            </Accordion>
        );
    }
    return <div className="flex-grow flex flex-col gap-6">{children}</div>;
};

// Plot chrome, as a pure function of its inputs.
//
// Pulled out of the component for two reasons. Referential stability: it used to
// be called inline in render, so every pane got a fresh layout object and
// `react-plotly.js` — which re-plots whenever `prev.layout !== layout`,
// regardless of `revision` — ran Plotly.react on all four plots on every render
// (F9, F13). And so it can be memoized where it is used.
//
// Colours are CONCRETE. This function used to pass `template: 'plotly_white'`
// and `var(--foreground)` as font colours; measured in the browser, Plotly
// resolved the template to `undefined` and every one of those colours to its own
// default `#444` — the theme-aware chrome the code intended had never once
// applied (F17). exportHTML always used real hex values, which was the clue.
const PLOT_CHROME = {
    light: { fg: '#111111', grid3d: '#bbbbbb', grid2d: '#cccccc', tick: '#888888', zero: '#888888' },
    dark: { fg: '#10ff50', grid3d: '#3a3a3a', grid2d: '#333333', tick: '#9a9a9a', zero: '#555555' },
};

type PlotLayoutOpts = {
    dark: boolean;
    title: string;
    colorBy: string;
    axisNames: AxisLabels;
    mode: "3D" | "2D";
    axesOn: boolean;
    /** 'cube' = equal-length axes; 'data' = axis lengths proportional to their spans. */
    aspect: AspectMode;
    window2d: { x: [number, number], y: [number, number] } | null;
    camera: SceneCamera;
};

const buildPlotLayout = ({ dark, title, colorBy, axisNames, mode, axesOn, aspect, window2d, camera }: PlotLayoutOpts) => {
    const c = dark ? PLOT_CHROME.dark : PLOT_CHROME.light;
    const baseLayout: any = {
        autosize: true,
        // Terminal panes carry their own label — a Plotly title would duplicate it
        margin: { l: mode === "2D" ? 40 : 0, r: 20, b: mode === "2D" ? 40 : 0, t: dark ? 10 : 40 },
        ...(dark ? {} : { title: { text: title, font: { color: c.fg } } }),
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        showlegend: false,
        legend: { title: { text: colorBy, font: { color: c.fg } }, font: { color: c.fg } },
    };

    if (mode === "3D") {
        // The title is gated on axesOn like everything else. It used not to be,
        // which made "Axes: Off" mean "no box, no grid, no ticks — but keep three
        // labels floating in space". During rotation they swung between box edges
        // with nothing to anchor them, which read as the axes misbehaving.
        const axis3d = (label: string) => ({
            showgrid: axesOn, zeroline: axesOn, showticklabels: axesOn,
            gridcolor: c.grid3d, zerolinecolor: c.zero,
            tickfont: { size: 10, color: c.tick },
            title: { text: axesOn ? label : '', font: { color: c.fg } },
        });
        baseLayout.scene = {
            camera,
            // 'cube' orbits uniformly and always fits, but stretches each axis by
            // a different factor, so the tick spacing is not comparable between
            // them. 'data' keeps the axes proportional to their spans — faithful,
            // but an elongated box swings its projected size with the azimuth and
            // can run off the canvas. The user picks; the disclosure says which
            // trade they are looking at.
            aspectmode: aspect,
            xaxis: axis3d(axisNames.x),
            yaxis: axis3d(axisNames.y),
            zaxis: axis3d(axisNames.z),
            bgcolor: 'transparent',
        };
    } else {
        const axis2d = (label: string) => ({
            showgrid: axesOn, zeroline: axesOn, showticklabels: axesOn,
            gridcolor: c.grid2d, zerolinecolor: c.zero,
            tickfont: { color: c.tick },
            title: { text: axesOn ? label : '', font: { color: c.fg } },
        });
        baseLayout.xaxis = axis2d(axisNames.x);
        baseLayout.yaxis = axis2d(axisNames.y);
        // Each view brings its own viewport — the active one's live state, a
        // pin's captured one — since these are data-space bounds and pins are
        // framed on their own columns. `autorange` is set explicitly so a reset
        // actually refits: dropping `range` alone lets Plotly keep the old window.
        if (window2d) {
            baseLayout.xaxis.range = [...window2d.x];
            baseLayout.yaxis.range = [...window2d.y];
            baseLayout.xaxis.autorange = false;
            baseLayout.yaxis.autorange = false;
        } else {
            baseLayout.xaxis.autorange = true;
            baseLayout.yaxis.autorange = true;
        }
    }

    return baseLayout;
};

// Memoized: without it, any state change in Home — a slider tick, a Notes
// keystroke, a streaming assistant token — re-rendered every pane and, because
// the layout object was rebuilt inline, made react-plotly.js re-plot all four
// (F13). None of those values affect the plot.
const ViewPlot = memo(({ view, title, colorBy, axesOn, aspect, window2d, camera, onRelayout }: {
    view: any, title: string, colorBy: string, axesOn: boolean, aspect: AspectMode,
    window2d: { x: [number, number], y: [number, number] } | null,
    camera: SceneCamera,
    // The pane's own id travels with the event: every pane shares one handler,
    // and it has to know whether the live view or a pin was dragged.
    onRelayout: (e: any, viewId: string | number) => void,
}) => {
    const { theme } = useTheme();
    const traces = useMemo(
        () => buildTraces(view.data, view.colorBy, view.viewMode, view.axes, view.labels, view.muted ?? {}, theme === 'terminal', view.shapeBy ?? ""),
        [view.data, view.colorBy, view.viewMode, view.axes, view.labels, view.muted, theme, view.shapeBy]
    );
    // The layout object is now stable across renders that do not change it,
    // which is what react-plotly.js actually keys on: it re-plots whenever
    // `prev.layout !== layout`, and `revision` does NOT override that.
    const layout = useMemo(
        () => buildPlotLayout({
            dark: theme === 'terminal', title, colorBy,
            axisNames: view.labels, mode: view.viewMode, axesOn, aspect, window2d, camera,
        }),
        [theme, title, colorBy, view.labels, view.viewMode, axesOn, aspect, window2d, camera],
    );
    const divId = view.id === 'active' ? 'active-plot' : `pin-plot-${view.id}`;

    // `useResizeHandler` only listens to WINDOW resize. Pinning or closing a view
    // re-splits the CSS grid, which changes this pane's box without any window
    // event — so Plotly kept its old pixel size: a new pin overlapped its
    // neighbour, and closing one left the survivor stranded in whitespace at its
    // former size. A ResizeObserver on the pane is the event Plotly was missing.
    const wrap = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = wrap.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        let raf = 0;
        let dead = false;
        // ResizeObserver delivers one callback the moment it starts observing.
        // For a pane that has just mounted that is a resize to the size Plotly
        // already laid itself out at — pure waste, and it lands in the same
        // frame as the real resizes of every other pane, which is what makes
        // adding a pin one long task instead of n-1 short ones.
        let firstObservation = true;
        const ro = new ResizeObserver(() => {
            if (firstObservation) { firstObservation = false; return; }
            // Coalesce: a grid re-split fires this for every pane in the same
            // frame, and Plots.resize is not free.
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(async () => {
                const gd = document.getElementById(divId) as (HTMLElement & { _fullLayout?: unknown }) | null;
                if (dead || !gd?._fullLayout) return;
                const Plotly = (await import('plotly.js-gl3d-dist-min')).default;
                if (dead || !gd._fullLayout) return;   // unmounted while importing
                try { Plotly.Plots.resize(gd); } catch { /* purged mid-flight */ }
            });
        });
        ro.observe(el);
        return () => { dead = true; cancelAnimationFrame(raf); ro.disconnect(); };
    }, [divId]);

    return (
        <div ref={wrap} className="w-full h-full">
            <Plot
                divId={divId}
                data={traces}
                layout={layout}
                useResizeHandler={true}
                style={{ width: "100%", height: "100%" }}
                onRelayout={(e: any) => onRelayout(e, view.id)}
            />
        </div>
    );
});
ViewPlot.displayName = 'ViewPlot';

// --- Analysis views (run_test results, plot_chart charts) -------------------
// A third kind of pane alongside the live view and pins: the outputs of the
// Analyze panel and the assistant's run_test/plot_chart tools. Charts arrive
// pre-compiled (chartCompile.ts) as plain scatter traces; a test result is a
// styled card, no Plotly involved. They share the pins' 3-extra-pane budget so
// the grid never silently drops one.

export type AnalysisView = {
    id: number;
    kind: 'analysis';
    label: string;
    chart?: CompiledChart;
    test?: TestResult;
};

const fmtStat = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.round(v * 1000) / 1000);
const fmtP = (p: number) => (p < 0.001 ? p.toExponential(2) : String(Math.round(p * 10000) / 10000));

const TestResultCard = ({ result, dark }: { result: TestResult; dark: boolean }) => {
    const sig = result.p < 0.05;
    const NAMES: Record<string, string> = {
        t: "Welch's t-test", mann_whitney: 'Mann–Whitney U', kruskal_wallis: 'Kruskal–Wallis',
        ks: 'Kolmogorov–Smirnov (2-sample)', chi_square: 'Chi-square independence',
    };
    return (
        <div className="w-full h-full overflow-auto p-4 flex flex-col gap-3 text-sm">
            <div className="font-bold">{NAMES[result.test] ?? result.test}</div>
            <div className="text-2xl font-bold tracking-tight">
                {result.statLabel} = {fmtStat(result.statistic)}
                {result.df !== null && <span className="text-sm font-normal opacity-70">  df = {fmtStat(result.df)}</span>}
            </div>
            {/* Exact p, bolded (and red) below alpha = .05 — never stars. */}
            <div className={sig ? `font-bold ${dark ? 'text-[#10ff50]' : 'text-[var(--p-red,#D23B72)]'}` : ''}>
                p = {fmtP(result.p)}
            </div>
            <div>
                {result.effect.label} = <b>{fmtStat(result.effect.value)}</b>
                {result.ci95 && <span className="block opacity-80">95% CI on the mean difference: [{fmtStat(result.ci95[0])}, {fmtStat(result.ci95[1])}]</span>}
            </div>
            <div className="opacity-70 text-xs">
                {result.groups.map(g => `${g.group} (n=${g.n})`).join(' · ')}
            </div>
            {result.caveats.map((c, i) => (
                <div key={i} className="text-xs leading-snug border-l-2 pl-2 opacity-80 border-current">{c}</div>
            ))}
        </div>
    );
};

const AnalysisPane = memo(({ view }: { view: AnalysisView }) => {
    const { theme } = useTheme();
    const dark = theme === 'terminal';
    const chart = view.chart;
    const layout = useMemo(() => {
        if (!chart) return null;
        const c = dark ? PLOT_CHROME.dark : PLOT_CHROME.light;
        const axis = (title: string, isTickAxis: boolean) => ({
            showgrid: true, gridcolor: c.grid2d, zerolinecolor: c.zero,
            tickfont: { color: c.tick, size: 10 },
            title: { text: title, font: { color: c.fg, size: 11 } },
            ...(isTickAxis && chart.ticks
                ? { tickvals: chart.ticks.vals, ticktext: chart.ticks.text, showgrid: false }
                : {}),
            ...(chart.xIsDate && !isTickAxis ? {} : {}),
        });
        const xaxis: Record<string, unknown> = axis(chart.xTitle, chart.ticks?.axis === 'x');
        const yaxis: Record<string, unknown> = axis(chart.yTitle, chart.ticks?.axis === 'y');
        if (chart.xIsDate) xaxis.type = 'date';
        // House zero policy: bars anchor at zero; distributions autoscale.
        if (chart.zeroBased) (chart.ticks?.axis === 'y' ? xaxis : yaxis).rangemode = 'tozero';
        return {
            autosize: true, margin: { l: 55, r: 16, b: 45, t: dark ? 12 : 40 },
            ...(dark ? {} : { title: { text: chart.title, font: { color: c.fg, size: 13 } } }),
            paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
            showlegend: chart.traces.some(t => t.showlegend !== false && t.name),
            legend: { font: { color: c.fg, size: 10 } },
        // xaxis/yaxis attached below so the tick branches above stay readable
            xaxis, yaxis,
        };
    }, [chart, dark]);
    if (view.test) return <TestResultCard result={view.test} dark={dark} />;
    if (!chart || !layout) return null;
    return (
        <div className="w-full h-full relative flex flex-col">
            <div className="flex-grow min-h-0">
                <Plot
                    data={chart.traces.map(t => ({ type: 'scatter', ...t }))}
                    layout={layout}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%', height: '100%' }}
                    useResizeHandler
                />
            </div>
            {chart.notes.length > 0 && (
                <div className="px-3 pb-2 text-[10px] leading-snug opacity-60">
                    {chart.notes.join(' ')}
                </div>
            )}
        </div>
    );
});
AnalysisPane.displayName = 'AnalysisPane';

// Tabled: the sidebar section rendering this panel is behind
// ANALYZE_PANEL_ENABLED (currently off) while the analysis engine is being
// polished. The component and its gate stay wired and tested for the flip.
const ANALYZE_PANEL_ENABLED = false;

// The Analyze panel: the assistant-free path to run_test/plot_chart. Its
// dropdowns are populated from the SAME AnalysisProfile the validator reads,
// so the UI can barely express an invalid plan — and whatever it expresses
// still goes through the one shared gate (runAnalysisPlan), never around it.
const AnalyzePanel = ({ profile, theme, onRun }: {
    profile: import('@/lib/analysisPlan').AnalysisProfile | null;
    theme: string | undefined;
    onRun: (plan: AnalysisPlan) => string;
}) => {
    const [kind, setKind] = useState<'test' | 'chart'>('test');
    const [test, setTest] = useState<TestPlan['test']>('t');
    const [mark, setMark] = useState<ChartPlan['mark']>('ecdf');
    const [column, setColumn] = useState('');
    const [groupBy, setGroupBy] = useState('');
    const [groupA, setGroupA] = useState('');
    const [groupB, setGroupB] = useState('');
    const [orientation, setOrientation] = useState<'vertical' | 'horizontal'>('vertical');
    const [xCol, setXCol] = useState('');
    const [bins, setBins] = useState('');
    const [agg, setAgg] = useState<'mean' | 'median' | 'sum' | 'count'>('mean');
    const [feedback, setFeedback] = useState('');

    const numeric = (profile?.columns ?? []).filter(c => c.isNumeric && !c.isIdentifier).map(c => c.name);
    const categorical = (profile?.columns ?? []).filter(c => c.isCategorical && !c.isIdentifier).map(c => c.name);
    const temporal = (profile?.columns ?? []).filter(c => c.isTemporal).map(c => c.name);
    const groupOptions = (profile?.columns.find(c => c.name === groupBy)?.groups ?? [])
        .filter(g => !g.withheld).map(g => g.value);
    const twoGroup = kind === 'test' && (test === 't' || test === 'mann_whitney' || test === 'ks');
    const wantsCategorical = kind === 'test' ? test === 'chi_square' : mark === 'bar';
    const columnOptions = wantsCategorical ? categorical : numeric;

    const TEST_LABELS: Record<TestPlan['test'], string> = {
        t: "Welch's t-test (2 group means)", mann_whitney: 'Mann–Whitney U (2 groups, ranks)',
        kruskal_wallis: 'Kruskal–Wallis (2+ groups, ranks)', ks: 'Kolmogorov–Smirnov (2 distributions)',
        chi_square: 'Chi-square (two categoricals)',
    };
    const MARK_LABELS: Record<ChartPlan['mark'], string> = {
        ecdf: 'ECDF (cumulative distribution)', histogram: 'Histogram', box: 'Box plot',
        violin: 'Violin plot', qq: 'Normal Q–Q', bar: 'Bar chart (counts)', line: 'Line (over time)',
    };

    const run = () => {
        const plan: AnalysisPlan = kind === 'test'
            ? {
                kind: 'test', test, column, groupBy,
                ...(twoGroup && groupA && groupB ? { groups: [groupA, groupB] } : {}),
            }
            : {
                kind: 'chart', mark, column,
                ...(groupBy && mark !== 'bar' ? { groupBy } : {}),
                ...(mark === 'bar' ? { orientation } : {}),
                ...(mark === 'line' ? { x: xCol, agg } : {}),
                ...(mark === 'histogram' && bins.trim() !== '' ? { bins: Number(bins) } : {}),
            };
        setFeedback(onRun(plan));
    };

    const isError = /^(Plan rejected|Analysis error|Pane limit|No dataset)/.test(feedback);
    const selectCls = "w-full bg-[var(--input)] border border-[var(--border)] p-1.5 text-xs outline-none";
    const labelCls = "block text-[10px] uppercase tracking-wider opacity-60 pt-1";
    return (
        <div className="space-y-2 text-sm">
            <div className="grid grid-cols-2 gap-1 text-xs">
                {(['test', 'chart'] as const).map(k => (
                    <button key={k} onClick={() => { setKind(k); setFeedback(''); setColumn(''); }}
                        className={`py-1.5 font-bold border ${kind === k
                            ? (theme === 'primary' ? 'bauhaus-btn bg-[var(--p-blue)] text-white' : 'border-[var(--primary)] text-[var(--primary)] bg-[var(--border)]')
                            : 'border-[var(--border)] bg-[var(--input)] opacity-70 hover:opacity-100'}`}>
                        {k === 'test' ? 'Statistical test' : 'Chart'}
                    </button>
                ))}
            </div>
            {kind === 'test' ? (
                <select aria-label="Test" className={selectCls} value={test} onChange={e => { setTest(e.target.value as TestPlan['test']); setFeedback(''); setColumn(''); }}>
                    {TEST_KINDS.map(t => <option key={t} value={t}>{TEST_LABELS[t]}</option>)}
                </select>
            ) : (
                <select aria-label="Chart type" className={selectCls} value={mark} onChange={e => { setMark(e.target.value as ChartPlan['mark']); setFeedback(''); setColumn(''); }}>
                    {MARK_KINDS.map(m => <option key={m} value={m}>{MARK_LABELS[m]}</option>)}
                </select>
            )}
            <label className={labelCls}>{wantsCategorical ? 'Categorical column' : kind === 'chart' && mark === 'line' ? 'Value column' : 'Numeric column'}</label>
            <select aria-label="Column" className={selectCls} value={column} onChange={e => setColumn(e.target.value)}>
                <option value="">— choose —</option>
                {columnOptions.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            {(kind === 'test' || (mark !== 'bar')) && (
                <>
                    <label className={labelCls}>{kind === 'test' ? (test === 'chi_square' ? 'Against categorical' : 'Group by') : 'Group by (optional)'}</label>
                    <select aria-label="Group by" className={selectCls} value={groupBy} onChange={e => { setGroupBy(e.target.value); setGroupA(''); setGroupB(''); }}>
                        <option value="">{kind === 'chart' ? '— none —' : '— choose —'}</option>
                        {categorical.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                </>
            )}
            {twoGroup && groupOptions.length > 0 && (
                <div className="grid grid-cols-2 gap-1">
                    <select aria-label="Group A" className={selectCls} value={groupA} onChange={e => setGroupA(e.target.value)}>
                        <option value="">Group A</option>
                        {groupOptions.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                    <select aria-label="Group B" className={selectCls} value={groupB} onChange={e => setGroupB(e.target.value)}>
                        <option value="">Group B</option>
                        {groupOptions.filter(g => g !== groupA).map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                </div>
            )}
            {kind === 'chart' && mark === 'bar' && (
                <select aria-label="Orientation" className={selectCls} value={orientation} onChange={e => setOrientation(e.target.value as 'vertical' | 'horizontal')}>
                    <option value="vertical">Vertical bars</option>
                    <option value="horizontal">Horizontal bars</option>
                </select>
            )}
            {kind === 'chart' && mark === 'line' && (
                <>
                    <label className={labelCls}>Time column</label>
                    <select aria-label="Time column" className={selectCls} value={xCol} onChange={e => setXCol(e.target.value)}>
                        <option value="">— choose —</option>
                        {temporal.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <select aria-label="Aggregation" className={selectCls} value={agg} onChange={e => setAgg(e.target.value as typeof agg)}>
                        {(['mean', 'median', 'sum', 'count'] as const).map(a => <option key={a} value={a}>daily {a}</option>)}
                    </select>
                </>
            )}
            {kind === 'chart' && mark === 'histogram' && (
                <input aria-label="Bins" type="number" min={5} max={100} placeholder="bins (auto)" value={bins}
                    onChange={e => setBins(e.target.value)}
                    className="w-full bg-[var(--input)] border border-[var(--border)] p-1.5 text-xs outline-none" />
            )}
            <button onClick={run} disabled={!column || (kind === 'test' && !groupBy) || (kind === 'chart' && mark === 'line' && !xCol)}
                className={`w-full text-sm font-bold py-2 disabled:opacity-50 ${theme === 'primary' ? 'bauhaus-btn bg-[var(--p-blue)] text-white' : 'bg-[var(--input)] border border-[var(--border)] hover:bg-[var(--border)] text-[var(--abaci)]'}`}>
                {kind === 'test' ? 'Run test' : 'Draw chart'}
            </button>
            {feedback && (
                <pre className={`whitespace-pre-wrap text-[10px] leading-snug max-h-40 overflow-auto ${isError
                    ? (theme === 'primary' ? 'text-[var(--p-red)] font-bold' : 'text-red-400 font-bold')
                    : 'opacity-70'}`}>
                    {feedback}
                </pre>
            )}
            <p className="text-[10px] leading-snug opacity-60">
                Exact p-values with effect size and CI — no significance stars. Results and charts appear as panes on the canvas.
                <InfoTip topic="statistical_tests" />
            </p>
        </div>
    );
};

// Read-only raw-rows viewer: sortable, filterable, paged. Renders locally in
// both data modes — the modes gate what reaches the assistant's endpoint,
// never what the user may see of their own data.
const TableViewDialog = ({ table, name, onClose }: { table: DataTable; name: string; onClose: () => void }) => {
    const [sortCol, setSortCol] = useState<string | null>(null);
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
    const [filter, setFilter] = useState('');
    const [page, setPage] = useState(0);
    const PAGE = 100;

    const rows = useMemo(() => {
        let idx = Array.from({ length: table.nRows }, (_, i) => i);
        const f = filter.trim().toLowerCase();
        if (f) {
            idx = idx.filter(i => table.columns.some(c => String(table.data[c]?.[i] ?? '').toLowerCase().includes(f)));
        }
        if (sortCol) {
            const vals = table.data[sortCol] ?? [];
            const dir = sortDir === 'asc' ? 1 : -1;
            idx = [...idx].sort((a, b) => {
                const va = vals[a], vb = vals[b];
                if (va == null) return 1;           // nulls last either direction
                if (vb == null) return -1;
                const na = asNumber(va), nb = asNumber(vb);
                if (na !== null && nb !== null) return (na - nb) * dir;
                return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
            });
        }
        return idx;
    }, [table, filter, sortCol, sortDir]);

    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    const cur = Math.min(page, pages - 1);
    const slice = rows.slice(cur * PAGE, cur * PAGE + PAGE);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
            <div className="bg-[var(--background)] border-2 border-[var(--border)] w-[min(92vw,1100px)] h-[min(85vh,760px)] flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-3 p-3 border-b border-[var(--border)]">
                    <span className="font-bold text-sm truncate">{name} — {table.nRows} rows × {table.columns.length} columns</span>
                    <input
                        aria-label="Filter rows" placeholder="Filter…" value={filter}
                        onChange={e => { setFilter(e.target.value); setPage(0); }}
                        className="ml-auto w-40 bg-[var(--input)] border border-[var(--border)] px-2 py-1 text-xs outline-none"
                    />
                    <span className="text-xs opacity-60 flex-shrink-0">{rows.length} match{rows.length === 1 ? '' : 'es'}</span>
                    <button onClick={onClose} className="border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--border)]" aria-label="Close table view">
                        <X className="w-4 h-4" />
                    </button>
                </div>
                <div className="flex-grow overflow-auto">
                    <table className="text-xs border-collapse min-w-full">
                        <thead className="sticky top-0 bg-[var(--background)]">
                            <tr>
                                <th className="text-left px-2 py-1 border-b border-[var(--border)] opacity-50 font-normal">#</th>
                                {table.columns.map(c => (
                                    <th key={c}
                                        onClick={() => {
                                            if (sortCol === c) { if (sortDir === 'asc') setSortDir('desc'); else { setSortCol(null); setSortDir('asc'); } }
                                            else { setSortCol(c); setSortDir('asc'); }
                                        }}
                                        className="text-left px-2 py-1 border-b border-[var(--border)] font-bold cursor-pointer select-none whitespace-nowrap hover:opacity-70"
                                        title="Click to sort">
                                        {c}{sortCol === c ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {slice.map(i => (
                                <tr key={i} className="odd:bg-[var(--input)]/40">
                                    <td className="px-2 py-0.5 opacity-40">{i + 1}</td>
                                    {table.columns.map(c => (
                                        <td key={c} className="px-2 py-0.5 whitespace-nowrap max-w-[220px] overflow-hidden text-ellipsis" title={String(table.data[c]?.[i] ?? '')}>
                                            {table.data[c]?.[i] == null ? <span className="opacity-30">·</span> : String(table.data[c][i])}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {pages > 1 && (
                    <div className="flex items-center justify-center gap-3 p-2 border-t border-[var(--border)] text-xs">
                        <button disabled={cur === 0} onClick={() => setPage(cur - 1)} className="px-2 py-0.5 border border-[var(--border)] disabled:opacity-30">‹ Prev</button>
                        <span className="opacity-70">Page {cur + 1} / {pages}</span>
                        <button disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} className="px-2 py-0.5 border border-[var(--border)] disabled:opacity-30">Next ›</button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default function Home() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [datasetFile, setDatasetFile] = useState<File | null>(null);
  const [componentsFile, setComponentsFile] = useState<File | null>(null);
  // Data mode for the NEXT upload. Reset to 'private' after every successful
  // add — the declaration is per file, deliberately not sticky.
  const [uploadDataMode, setUploadDataMode] = useState<DataMode>('private');
  // Mode-switch dialog for an already-loaded dataset (badge in the list).
  // Info-only: a dataset's mode is LOCKED at upload (owner's call) — the badge
  // and the assistant's access chip open this explainer, never a switch.
  const [accessInfo, setAccessInfo] = useState<number | null>(null);
  // The no-sensitive-data confirmation lives in the ADD dialog now, since
  // upload time is the only moment a dataset can become open.
  const [uploadOpenConfirmed, setUploadOpenConfirmed] = useState(false);
  // A failed upload opens a dialog instead of relying on the small status
  // line: the error, a local column-shape diagnosis, and — when the culprit is
  // numbers stored as formatted text — an in-app fix.
  const [uploadFailure, setUploadFailure] = useState<{
    message: string; name: string; dataMode: DataMode; recodeAfter: 'configure' | 'skip';
    table: DataTable | null; comp: DataTable | null; diags: ColumnDiagnosis[] | null;
  } | null>(null);
  const [fixCols, setFixCols] = useState<string[]>([]);
  // The add-dataset config modal: opens as soon as a file is dropped/picked,
  // and gathers everything about the add in one place — sheet, components
  // file, data mode, missing-value handling.
  const [showAddConfig, setShowAddConfig] = useState(false);
  // Two-way choice, decided IN the add config — no second "scan?" prompt
  // after adding. 'configure' opens the checker straight after the add.
  const [recodeAfterAdd, setRecodeAfterAdd] = useState<'configure' | 'skip'>('configure');
  // Per-dataset settings modal (gear on the dataset row) and delete confirm.
  const [datasetSettings, setDatasetSettings] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  // Sheets in the selected workbook, and which one to read. Empty string means
  // "let the parser choose", which is the right default — it picks the first
  // sheet that actually has data rather than blindly the first sheet.
  const [showInfo, setShowInfo] = useState(false);
  const [sheetOptions, setSheetOptions] = useState<SheetInfo[]>([]);
  const [selectedSheet, setSelectedSheet] = useState<string>("");
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const [isUploading, setIsUploading] = useState(false);
  const [isExporting, setIsExporting] = useState("");
  const [includeExportInfo, setIncludeExportInfo] = useState(true);
  
  // Data state: cached datasets (columnar — see DataTable), one active at a time
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [colorBy, setColorBy] = useState<string>("");
  // Second categorical channel, rendered as marker symbols. "" = off.
  const [shapeBy, setShapeBy] = useState<string>("");
  const activeDataset = datasets.find(d => d.id === activeId) ?? null;
  const processedData = activeDataset?.table ?? null;
  
  // Plot state
  const [viewMode, setViewMode] = useState<"3D" | "2D">("3D");
  const [showAxes, setShowAxes] = useState<{ "3D": boolean, "2D": boolean }>({ "3D": true, "2D": true });
  // 'ask' is the free post-upload question; 'configure' runs the scan.
  const [showRecode, setShowRecode] = useState<null | 'ask' | 'configure'>(null);
  // Box shape for 3-D. Cube by default: it orbits uniformly and always fits.
  const [aspect, setAspect] = useState<AspectMode>(DEFAULT_ASPECT);
  const [camera, setCamera] = useState(DEFAULT_CAMERA);
  // The live camera, readable without a re-render. During rotation the angle
  // changes 60 times a second and React never hears about it (F9) — but pinning,
  // exporting and saving a workspace all need the angle currently on screen, so
  // the rAF loop keeps this in step with what it hands Plotly.
  const cameraRef = useRef(camera);
  useEffect(() => { cameraRef.current = camera; }, [camera]);
  // 2D viewport, the flat-mode counterpart of `camera`. null = autorange (fit all
  // points). Set by assistant zoom/pan and by the user's own mouse zoom, so a
  // React re-render can't silently snap the plot back to the full extent.
  const [range2d, setRange2d] = useState<{ x: [number, number], y: [number, number] } | null>(null);
  const [isRotating, setIsRotating] = useState(false);
  // Mirrored into a ref so handleRelayout can stay referentially stable.
  const isRotatingRef = useRef(false);
  useEffect(() => { isRotatingRef.current = isRotating; }, [isRotating]);
  const cntRef = useRef(0);
  const reqRef = useRef<number | undefined>(undefined);

  // Feature state
  const [pinnedViews, setPinnedViews] = useState<any[]>([]); // array of { id, data, colorBy, axes, labels, viewMode, label }
  // Analysis outputs (test cards, statistical charts) — pane peers of pins,
  // sharing their 3-extra-pane budget so the grid never silently drops one.
  const [analysisViews, setAnalysisViews] = useState<AnalysisView[]>([]);
  // Raw-rows table view (read-only). Pure local rendering, so it exists in
  // BOTH data modes: the modes gate what reaches the assistant's endpoint,
  // never what the user may see of their own data.
  const [showTableView, setShowTableView] = useState(false);
  const [notes, setNotes] = useState("");
  // Legend mute states for the active view's colorBy, keyed by String(value)
  const [mutedMap, setMutedMap] = useState<MuteMap>({});

  const toggleMuted = (val: any) => {
      const key = String(val);
      setMutedMap(prev => {
          const next = { ...prev };
          if (!prev[key]) next[key] = 'muted';
          else if (prev[key] === 'muted') next[key] = 'hidden';
          else delete next[key];
          return next;
      });
  };

  // Muting is scoped to one colorBy of one dataset — reset when either changes.
  // Skip once during a workspace load, which restores muted state deliberately.
  const skipMuteReset = useRef(false);
  useEffect(() => {
      if (skipMuteReset.current) { skipMuteReset.current = false; return; }
      setMutedMap({});
  }, [colorBy, activeId]);


  // A 2D viewport is only meaningful for the columns it was framed on — dropping
  // different variables onto the axes would leave the old window clipping the new
  // data (or showing empty space), so refit whenever the framing changes.
  const skipRangeReset = useRef(false);
  useEffect(() => {
      if (skipRangeReset.current) { skipRangeReset.current = false; return; }
      setRange2d(null);
  }, [activeId, activeDataset?.axes2d.x, activeDataset?.axes2d.y]);

  // Drop the shape encoding when the column it points at is gone (dataset switch,
  // Clear All) or has grown past the cap (a clustering run adding levels)
  useEffect(() => {
      if (!shapeBy) return;
      const vals = activeDataset?.table.data[shapeBy];
      if (!vals || shapeCategories(vals).length > MAX_SHAPE_CATEGORIES) setShapeBy("");
  }, [activeId, activeDataset?.table, shapeBy]);

  // PCA state: scree info from the most recent in-app run (per active dataset)
  const [pcaInfo, setPcaInfo] = useState<{ varianceExplained: number[]; cumulative: number[]; spectrum?: number[]; eigenvalues?: number[]; standardize?: boolean; k?: number; columns?: string[] } | null>(null);
  useEffect(() => { setPcaInfo(null); }, [activeId]);

  // Clustering state
  const [clusterMethod, setClusterMethod] = useState("NONE");
  const [eps, setEps] = useState(0.5);
  const [minSamples, setMinSamples] = useState(5);
  const [k, setK] = useState(3);
  const [standardize, setStandardize] = useState(false);
  const [isClustering, setIsClustering] = useState(false);
  const [breakdownBy, setBreakdownBy] = useState<string>("");
  const [breakdownDirection, setBreakdownDirection] = useState<BreakdownDirection>('cluster');
  const [heatmapPalette, setHeatmapPalette] = useState<HeatmapPalette>('Viridis');

  // The standardize toggle defaults by data regime (PC scores or shared-scale
  // columns → off, mixed scales → on; see suggestStandardize). Recomputed when
  // the clustered columns change; skipped once when a workspace load or undo
  // restore supplies a deliberate value.
  const skipStdReset = useRef(false);
  const axNow = activeDataset ? effectiveAxes(activeDataset, viewMode) : null;
  useEffect(() => {
      if (skipStdReset.current) { skipStdReset.current = false; return; }
      if (!activeDataset || !axNow) return;
      const t = activeDataset.table;
      const names = [axNow.x, axNow.y, ...(axNow.z ? [axNow.z] : [])];
      const cols = names.map(nm => t.data[nm]).filter(Boolean);
      setStandardize(suggestStandardize(cols, names));
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, axNow?.x, axNow?.y, axNow?.z]);

  // Workspace persistence (file-based via backend)
  const [workspaces, setWorkspaces] = useState<{ name: string, saved_at: string, bytes: number }[]>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceBusy, setWorkspaceBusy] = useState("");

  const dsInputRef = useRef<HTMLInputElement>(null);
  const compInputRef = useRef<HTMLInputElement>(null);
  const gifButtonRef = useRef<HTMLButtonElement>(null);
  // Which dropzone a file is currently being dragged over
  const [dragOver, setDragOver] = useState<'ds' | 'comp' | null>(null);
  // Components projection is the exception now, not the rule — hidden until asked for
  const [showComponents, setShowComponents] = useState(false);



  useEffect(() => {
    setMounted(true);
  }, []);

  // Auto-rotation drives Plotly directly instead of going through React (F9).
  //
  // `setCamera` in the rAF loop re-rendered the whole Home subtree sixty times a
  // second — sidebar, Variables panel, PCA section, cluster breakdown, all four
  // panes and the assistant — and `react-plotly.js` guards on
  // `prev.layout === layout`, which a freshly-built layout object never
  // satisfies, so all four plots ran Plotly.react every frame. Writing the eye
  // straight to the active plot collapses that to one camera write and one
  // redraw, and the win does not depend on dataset size.
  //
  // Only the ACTIVE plot is driven: since F11 a pin holds the angle it was taken
  // at, so rotating the live view must not move them.
  useEffect(() => {
    if (!(isRotating && viewMode === "3D")) {
        if (reqRef.current) cancelAnimationFrame(reqRef.current);
        return;
    }
    let cancelled = false;
    let stopped = false;

    // Orbit from wherever the camera already is, read synchronously before the
    // first frame. The previous version recomputed the eye from scratch every
    // frame at a hard-coded radius 2.2 and elevation 0.6, and never seeded its
    // angle counter — so pressing Start Rotation teleported the view, discarding
    // whatever zoom, tilt and angle the user had dragged to.
    const liveCam = (() => {
        try {
            const gd = getActivePlotDiv();
            return gd?._fullLayout?.scene?._scene?.getCamera?.()
                ?? gd?._fullLayout?.scene?.camera
                ?? null;
        } catch { return null; }
    })();
    // `up`, `center` and `projection` are carried through untouched. Rebuilding
    // the camera as `{ eye }` alone dropped them, so a panned view silently
    // re-centred itself the first time it was rotated.
    const orbit = orbitFrom(liveCam ?? cameraRef.current ?? DEFAULT_CAMERA);
    cntRef.current = orbit.start;

    (async () => {
        const Plotly = (await import('plotly.js-gl3d-dist-min')).default;
        if (cancelled) return;
        const rotate = () => {
            cntRef.current += 0.005;
            const eye = orbit.eyeAt(cntRef.current);
            cameraRef.current = { ...orbit.rest, eye };
            const gd = getActivePlotDiv();
            // `_fullLayout` marks a plot Plotly has actually initialised;
            // relayout on a div mid-mount throws.
            if (gd?._fullLayout) Plotly.relayout(gd, { 'scene.camera.eye': eye });
            reqRef.current = requestAnimationFrame(rotate);
        };
        reqRef.current = requestAnimationFrame(rotate);
    })();
    return () => {
        cancelled = true;
        stopped = true;
        if (reqRef.current) cancelAnimationFrame(reqRef.current);
        // Commit the angle we stopped on, so an export, a pin or a workspace
        // save records what the user was looking at rather than where rotation
        // began. React state is only touched here — once per stop, not per frame.
        if (stopped) setCamera(cameraRef.current);
    };
  }, [isRotating, viewMode]);

  // Peek at a workbook's sheets as soon as it is chosen, so the user can pick
  // one BEFORE pressing Add Dataset rather than discovering afterwards that the
  // wrong sheet was read. Costs one structure-only read; no cell conversion.
  useEffect(() => {
    let cancelled = false;
    setSelectedSheet("");
    if (!datasetFile) { setSheetOptions([]); return; }
    listSheets(datasetFile).then(sheets => { if (!cancelled) setSheetOptions(sheets); });
    return () => { cancelled = true; };
  }, [datasetFile]);

  // Everything happens in the browser: parse → (optionally) project → plot.
  // No network round-trip, no server, no dataset upload.
  // The success half of an upload — project/validate a parsed table and
  // install it as a dataset. Split out of uploadFiles so the upload-error
  // dialog's "fix & add" path can re-enter it with a repaired table.
  const ingestParsed = (
    dsTable: DataTable,
    compTable: DataTable | null,
    parserWarnings: string[],
    name: string,
    initialView: InitialUploadView | undefined,
    dataMode: DataMode,
    provenanceNotes: string[] = [],
    recodeAfter: 'configure' | 'skip' = 'skip',
  ): DataTable => {
    const result = processUpload(dsTable, compTable);
    // Parser warnings describe things that silently changed the data, so they
    // lead — the success message is the part the user can already see.
    const warnings = [
      ...parserWarnings,
      // What the projection did to the numbers — coverage, fuzzy name
      // matches, unreadable loadings, fewer than three components (C10).
      ...result.warnings,
    ];
    setUploadStatus(warnings.length
      ? `${warnings.map(w => `⚠ ${w}`).join('\n')}\n${result.message}`
      : result.message);
    const id = Date.now();
    const table = result.table;
    const axes = initialView?.axes ?? pickDefaultAxes(table);
    const dataset: Dataset = {
      id,
      name,
      table,
      summary: result.topContributors ? { top_contributors: result.topContributors } : null,
      axes,
      labels: defaultLabels(axes),
      axes2d: { x: axes.x, y: axes.y },
      labels2d: { x: axes.x, y: axes.y },
      dataMode,
      provenance: [
        `Loaded "${name}" — ${table.nRows} rows × ${table.columns.length} columns, ${dataMode} data mode` +
          (compTable ? ', projected through a PCA components file' : ''),
        ...provenanceNotes,
      ].map(action => ({ at: new Date().toISOString(), action })),
    };
    setDatasets(prev => [...prev, dataset]);
    setActiveId(id);
    // The scan-or-not question was answered in the add-dataset config, so the
    // checker either opens straight away or not at all — no second prompt.
    // (The detector still only runs on request: scanning every column on
    // import was measurable latency on wide survey tables.) The demo is
    // curated and known clean — it arrives with an initialView.
    if (!initialView && recodeAfter === 'configure') setShowRecode('configure');
    setColorBy(initialView?.colorBy ?? pickDefaultColorBy(table, colorBy));
    // Ordinary uploads preserve a compatible shape channel; the demo supplies
    // an initial view specifically so it can start with shape unassigned.
    if (initialView) setShapeBy(initialView.shapeBy ?? "");
    setViewMode(initialView?.viewMode ?? (axes.z ? viewMode : "2D"));
    // Consume the file selections so the slots are free for the next dataset.
    // Mode and scan choices reset too — both are per-file decisions.
    setDatasetFile(null);
    setComponentsFile(null);
    setUploadDataMode('private');
    setUploadOpenConfirmed(false);
    setRecodeAfterAdd('configure');
    if (dsInputRef.current) dsInputRef.current.value = "";
    if (compInputRef.current) compInputRef.current.value = "";
    return table;
  };

  const uploadFiles = async (
    dsFile: File,
    compFile: File | null,
    initialView?: InitialUploadView,
    sheet?: string,
    dataMode: DataMode = 'private',
    recodeAfter: 'configure' | 'skip' = 'skip',
  ): Promise<DataTable | null> => {
    setIsUploading(true);
    setUploadStatus("Processing…");
    // Kept outside the try: when validation rejects the table AFTER parsing
    // succeeded, this is what the error dialog diagnoses.
    let parsedTable: DataTable | null = null;
    let parsedComp: DataTable | null = null;
    // Naming the sheet matters now that two sheets of one workbook can be
    // loaded as two datasets — otherwise both arrive with the same name.
    const name = dsFile.name.replace(/\.(csv|xlsx|parquet)$/i, '') + (sheet ? ` — ${sheet}` : '');
    try {
      // Yield until the busy state has actually PAINTED before heavy parsing
      // starts. A 30ms setTimeout sat here before, but a timer can fire ahead
      // of the click frame's presentation, which re-attached the whole
      // parse+ingest to the Add button's interaction (its INP flag).
      await paintYield();
      const [dsParsed, compParsed] = await Promise.all([
        readTable(dsFile, { sheet }),
        compFile ? readTable(compFile) : Promise.resolve(null),
      ]);
      parsedTable = dsParsed.table;
      parsedComp = compParsed?.table ?? null;
      const table = ingestParsed(
        dsParsed.table,
        parsedComp,
        [...dsParsed.warnings, ...(compParsed?.warnings ?? []).map(w => `Components file: ${w}`)],
        name, initialView, dataMode, [], recodeAfter,
      );
      setShowAddConfig(false);
      return table;
    } catch (err: any) {
      const message = String(err?.message ?? err);
      setUploadStatus(`Error: ${message}`);
      // The prominent path: a dialog with a local, column-shape diagnosis and
      // (when the problem is formatted-text numbers) an in-app fix. Counts and
      // column names only — no cell values — so it behaves identically in
      // Private and Open data modes, and needs no assistant.
      const diags = parsedTable ? diagnoseTable(parsedTable) : null;
      setFixCols(diags?.filter(d => d.kind === 'fixable').map(d => d.col) ?? []);
      setShowAddConfig(false);
      setUploadFailure({ message, name, dataMode, recodeAfter, table: parsedTable, comp: parsedComp, diags });
      return null;
    } finally {
      setIsUploading(false);
    }
  };

  // "Fix & add" from the upload-error dialog: coerce the chosen formatted-text
  // columns to numbers and run the same ingest the upload would have.
  const retryUploadWithFix = async () => {
    if (!uploadFailure?.table || fixCols.length === 0) return;
    const { table, comp, name, dataMode, recodeAfter } = uploadFailure;
    setUploadFailure(null);
    // Let the dialog-close frame paint before the synchronous coerce+ingest.
    await paintYield();
    try {
      const fixed = applyNumericFix(table, fixCols);
      const note = `Converted ${fixCols.length} formatted-text column${fixCols.length === 1 ? '' : 's'} to numeric: ${fixCols.join(', ')}.`;
      ingestParsed(fixed, comp, [note], name, undefined, dataMode, [note], recodeAfter);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setUploadStatus(`Error: ${message}`);
      setUploadFailure({ message, name, dataMode, recodeAfter, table, comp, diags: diagnoseTable(table) });
      setFixCols([]);
    }
  };

  const handleUpload = () => { if (datasetFile) uploadFiles(datasetFile, componentsFile, undefined, selectedSheet || undefined, uploadDataMode, recodeAfterAdd); };

  // Closing the add-config without adding releases the chosen files so the
  // dropzone is ready for the next attempt.
  const cancelAddConfig = () => {
    setShowAddConfig(false);
    setDatasetFile(null);
    setComponentsFile(null);
    setShowComponents(false);
    setUploadDataMode('private');
    setUploadOpenConfirmed(false);
    setRecodeAfterAdd('configure');
    if (dsInputRef.current) dsInputRef.current.value = "";
    if (compInputRef.current) compInputRef.current.value = "";
  };

  // Demo data ships with the app (public/demo) so the empty state can offer a
  // zero-friction first run: the public Iris CSV, no projection file required.
  const loadDemo = async (): Promise<DataTable | null> => {
    setIsUploading(true);
    setUploadStatus("Loading demo data…");
    try {
      const response = await fetch('/demo/iris.csv');
      if (!response.ok) throw new Error(`Demo data request failed (${response.status})`);
      const ds = await response.blob();
      return await uploadFiles(
        new File([ds], 'iris.csv', { type: 'text/csv' }),
        null,
        {
          axes: { x: 'PetalLengthCm', y: 'PetalWidthCm', z: 'SepalLengthCm' },
          colorBy: 'Species',
          viewMode: '3D',
        },
        undefined,
        // Iris is a textbook-public dataset, so the demo arrives in open mode —
        // it doubles as the zero-risk way to try the row-access tools.
        'open',
      );
    } catch {
      setUploadStatus("Demo data failed to load.");
      setIsUploading(false);
      return null;
    }
  };

  const selectDataset = (id: number) => {
      setActiveId(id);
      const ds = datasets.find(d => d.id === id);
      if (ds) {
          setColorBy(pickDefaultColorBy(ds.table, colorBy));
          if (!ds.axes.z) setViewMode("2D");
      }
  };

  // Append one step to a dataset's audit trail (see Dataset.provenance).
  const logProvenance = (datasetId: number | null, action: string) => {
      if (datasetId == null) return;
      setDatasets(prev => prev.map(d => d.id === datasetId
          ? { ...d, provenance: [...(d.provenance ?? []), { at: new Date().toISOString(), action }] }
          : d));
  };

  // --- Workspace persistence (IndexedDB — fully local) -----------------------
  const refreshWorkspaces = async () => {
      try {
          setWorkspaces(await wsStore.listWorkspaces());
      } catch { /* IndexedDB unavailable — list stays empty */ }
  };
  useEffect(() => { refreshWorkspaces(); }, []);

  // Dedupe tables by object identity: datasets and pins that share a table
  // (or a pin's snapshot) are stored once and referenced by id
  const buildWorkspacePayload = () => {
      const registry = new Map<DataTable, string>();
      const regTable = (t: DataTable | null) => {
          if (!t) return null;
          if (!registry.has(t)) registry.set(t, `t${registry.size}`);
          return registry.get(t);
      };
      const datasetsOut = datasets.map(d => ({ ...d, table: regTable(d.table) }));
      const pinsOut = pinnedViews.map(v => ({ ...v, data: regTable(v.data) }));
      const tables: Record<string, DataTable> = {};
      registry.forEach((id, tbl) => { tables[id] = tbl; });
      return {
          version: wsStore.WORKSPACE_VERSION,
          tables, datasets: datasetsOut, pinnedViews: pinsOut, analysisViews,
          activeId, colorBy, shapeBy, viewMode, showAxes, aspect, camera, range2d,
          notes, mutedMap,
          clusterMethod, eps, minSamples, k, standardize, breakdownBy, breakdownDirection, heatmapPalette, includeExportInfo,
          workspaceName: workspaceName.trim() || undefined,
          // Assistant transcript + wire history ride along (optional section,
          // still format 1 — older builds simply ignore it). Falls back to the
          // bridge's pending value during the startup window before the
          // dynamically-imported panel has mounted.
          conversation: convBridge.current.handle?.get() ?? convBridge.current.pending ?? undefined,
      };
  };

  const saveWorkspace = async () => {
      const name = workspaceName.trim();
      if (!name) return;
      setWorkspaceBusy("Saving…");
      try {
          await wsStore.saveWorkspace(name, buildWorkspacePayload());
          setWorkspaceBusy("");
          await refreshWorkspaces();
      } catch (err: any) {
          setWorkspaceBusy("");
          setUploadStatus(`Save failed: ${err?.message ?? err}`);
      }
  };

  // Download the active dataset's audit trail as a plain-text file — the
  // recoverable record of every step applied to the in-app copy.
  const downloadProvenance = () => {
      const d = activeDataset;
      if (!d?.provenance?.length) return;
      const text = [
          `Scatter Lab data trace — ${d.name}`,
          `${d.table.nRows} rows × ${d.table.columns.length} columns, ${d.dataMode} data mode`,
          `Exported ${new Date().toISOString()}`,
          '',
          ...d.provenance.map(p => `${p.at}  ${p.action}`),
          '',
          'The original file was never modified; these steps describe the in-app copy only.',
      ].join('\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${d.name}_trace.txt`;
      link.click();
      URL.revokeObjectURL(url);
  };

  const exportWorkspace = () => {
      const name = workspaceName.trim() || activeDataset?.name || 'workspace';
      wsStore.exportWorkspaceFile(name, buildWorkspacePayload());
  };

  const importWorkspace = async (file: File) => {
      setWorkspaceBusy("Importing…");
      try {
          const { name, payload } = await wsStore.importWorkspaceFile(file);
          await wsStore.saveWorkspace(name, payload);
          await refreshWorkspaces();
          applyWorkspace(name, payload);
          setWorkspaceBusy("");
      } catch (err: any) {
          setWorkspaceBusy("");
          setUploadStatus(`Import failed: ${err?.message ?? err}`);
      }
  };

  const loadWorkspace = async (name: string) => {
      setWorkspaceBusy("Loading…");
      try {
          const ws = await wsStore.loadWorkspace(name);
          if (!ws) { setWorkspaceBusy(""); setUploadStatus("Workspace not found."); return; }
          // Stored workspaces get the same check as imported ones: an entry
          // written by an older build, or half-written when a tab closed, would
          // otherwise white-screen on render exactly as a bad file did (C11).
          wsStore.validateWorkspace(ws);
          applyWorkspace(name, ws);
          setWorkspaceBusy("");
      } catch (err: any) {
          setWorkspaceBusy("");
          setUploadStatus(`Load failed: ${err?.message ?? err}`);
      }
  };

  const applyWorkspace = (name: string, ws: any, opts?: { silent?: boolean }) => {
          const tables: Record<string, DataTable> = ws.tables ?? {};
          const rehydrate = (ref: any) => (typeof ref === 'string' ? tables[ref] : ref);
          // Restore muted state deliberately — suppress the reset that colorBy/activeId would trigger
          skipMuteReset.current = true;
          setIsRotating(false);
          // dataMode runs through asDataMode: workspaces saved before data
          // modes existed carry none, and must load as private (fail closed).
          setDatasets((ws.datasets ?? []).map((d: any) => ({ ...d, table: rehydrate(d.table), dataMode: asDataMode(d.dataMode) })));
          setPinnedViews((ws.pinnedViews ?? []).map((v: any) => ({ ...v, data: rehydrate(v.data) })));
          // Analysis views are self-contained (compiled traces / result cards,
          // no table references) — restore verbatim, tolerate their absence.
          setAnalysisViews(Array.isArray(ws.analysisViews) ? ws.analysisViews : []);
          setActiveId(ws.activeId ?? null);
          setColorBy(ws.colorBy ?? "");
          setShapeBy(ws.shapeBy ?? "");
          setViewMode(ws.viewMode ?? "3D");
          setShowAxes(ws.showAxes ?? { "3D": true, "2D": true });
          setAspect(ws.aspect === 'data' ? 'data' : DEFAULT_ASPECT);
          // Merged, not replaced: workspaces saved before the camera grew a `center`
          // carry only an eye, and would otherwise reload sitting low in the frame.
          // Anything the file does specify still wins.
          setCamera({ ...DEFAULT_CAMERA, ...ws.camera });
          // Restored deliberately — suppress the refit that the axis change would trigger
          skipRangeReset.current = true;
          setRange2d(ws.range2d ?? null);
          setNotes(ws.notes ?? "");
          setMutedMap(ws.mutedMap ?? {});
          setClusterMethod(ws.clusterMethod ?? "NONE");
          setEps(ws.eps ?? 0.5);
          setMinSamples(ws.minSamples ?? 5);
          setK(ws.k ?? 3);
          skipStdReset.current = true;
          setStandardize(ws.standardize ?? false);
          setBreakdownBy(ws.breakdownBy ?? "");
          setBreakdownDirection(ws.breakdownDirection === 'group' ? 'group' : 'cluster');
          setHeatmapPalette(HEATMAP_PALETTES.includes(ws.heatmapPalette) ? ws.heatmapPalette : 'Viridis');
          setIncludeExportInfo(ws.includeExportInfo ?? true);
          setWorkspaceName(name);
          // Snapshot semantics: the workspace's conversation (or none) replaces
          // the current one. Sanitized, never validated-and-refused — damaged
          // chat must not cost the user their data.
          const conv = wsStore.sanitizeConversation(ws.conversation);
          if (convBridge.current.handle) convBridge.current.handle.set(conv);
          else convBridge.current.pending = conv;
          if (!opts?.silent) setUploadStatus(`Loaded workspace "${name}".`);
  };

  // --- Session continuity (autosave + restore) --------------------------------
  // One 'current session' record in IndexedDB, saved as you work and restored
  // on the next load — refresh no longer resets the app. Named workspaces stay
  // deliberate checkpoints; this record never touches them.
  const convBridge = useRef<ConversationBridge>({ handle: null });
  // Bumped when the assistant finishes a turn so the autosave effect fires;
  // useCallback so the memoized panel isn't re-rendered by a fresh closure.
  const [convVersion, setConvVersion] = useState(0);
  const noteConversationChange = useCallback(() => setConvVersion(v => v + 1), []);

  // Latest payload builder for callbacks that outlive a render (timer, pagehide);
  // reassigned post-commit so the ref is never written during render
  const buildPayloadRef = useRef<() => unknown>(() => ({}));
  useEffect(() => { buildPayloadRef.current = buildWorkspacePayload; });

  const sessionReady = useRef(false);       // block autosave until the restore attempt settles
  const discardingSession = useRef(false);  // "start fresh" in flight — suppress flushes
  const sessionSaveTimer = useRef<number | null>(null);
  const [sessionNotice, setSessionNotice] = useState<'restored' | 'recovery' | null>(null);

  // Debounced, event-driven autosave: a timer-based "every X minutes" loses up
  // to X minutes and writes while idle; this writes 1.5s after the last change.
  // Camera drags land here too — the debounce is what absorbs them.
  useEffect(() => {
      if (!sessionReady.current || discardingSession.current) return;
      if (sessionSaveTimer.current) window.clearTimeout(sessionSaveTimer.current);
      sessionSaveTimer.current = window.setTimeout(() => {
          sessionSaveTimer.current = null;
          wsStore.saveSession(buildPayloadRef.current()).catch(() => { /* IndexedDB unavailable */ });
      }, 1500);
  }, [datasets, pinnedViews, analysisViews, activeId, colorBy, shapeBy, viewMode, showAxes, aspect, camera, range2d,
      notes, mutedMap, clusterMethod, eps, minSamples, k, standardize, breakdownBy,
      breakdownDirection, heatmapPalette, includeExportInfo, workspaceName, convVersion]);

  // Flush a pending save when the tab hides or unloads — this is what catches
  // a close/refresh inside the debounce window. No pending timer = nothing new.
  useEffect(() => {
      const flush = () => {
          if (!sessionReady.current || discardingSession.current || !sessionSaveTimer.current) return;
          window.clearTimeout(sessionSaveTimer.current);
          sessionSaveTimer.current = null;
          wsStore.saveSession(buildPayloadRef.current()).catch(() => { /* best effort */ });
      };
      const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
          window.removeEventListener('pagehide', flush);
          document.removeEventListener('visibilitychange', onVisibility);
      };
  }, []);

  // Auto-restore on load, behind a crash-loop guard: the flag is set before
  // applying and cleared only after the restored state has rendered (the
  // effect below runs post-commit). If a restore ever white-screens the app
  // (the C11 failure class), the next load finds the flag still set, skips
  // auto-restore, and offers the session manually instead of looping.
  const RESTORE_GUARD = 'scatterlab.session.restoreGuard';
  const restoreAttempted = useRef(false);
  useEffect(() => {
      // Single-shot even under StrictMode's dev double-mount, which would
      // otherwise see the guard this effect just set and cry crash-loop.
      if (restoreAttempted.current) return;
      restoreAttempted.current = true;
      (async () => {
          try {
              if (localStorage.getItem(RESTORE_GUARD)) {
                  localStorage.removeItem(RESTORE_GUARD);
                  if (await wsStore.loadSession()) setSessionNotice('recovery');
                  return;
              }
              const s = await wsStore.loadSession();
              if (!s) return;
              localStorage.setItem(RESTORE_GUARD, '1');
              wsStore.validateWorkspace(s);
              const savedName = (s as { workspaceName?: unknown }).workspaceName;
              applyWorkspace(typeof savedName === 'string' ? savedName : '', s, { silent: true });
              setSessionNotice('restored');
          } catch {
              // Damaged session record — start blank rather than refuse to load.
              localStorage.removeItem(RESTORE_GUARD);
          } finally {
              sessionReady.current = true;
          }
      })();
  }, []);

  // Runs after the restored state committed without throwing: safe to drop the
  // guard. Also lets the toast fade on its own.
  useEffect(() => {
      if (sessionNotice !== 'restored') return;
      localStorage.removeItem(RESTORE_GUARD);
      const t = window.setTimeout(() => setSessionNotice(null), 10000);
      return () => window.clearTimeout(t);
  }, [sessionNotice]);

  const startFresh = async () => {
      discardingSession.current = true;
      if (sessionSaveTimer.current) { window.clearTimeout(sessionSaveTimer.current); sessionSaveTimer.current = null; }
      try { await wsStore.clearSession(); } catch { /* nothing to clear */ }
      localStorage.removeItem(RESTORE_GUARD);
      window.location.reload();
  };

  const resumeSession = async () => {
      setSessionNotice(null);
      try {
          const s = await wsStore.loadSession();
          if (!s) { setUploadStatus('No saved session found.'); return; }
          wsStore.validateWorkspace(s);
          const savedName = (s as { workspaceName?: unknown }).workspaceName;
          applyWorkspace(typeof savedName === 'string' ? savedName : '', s, { silent: true });
          setUploadStatus('Session restored.');
      } catch (err) {
          setUploadStatus(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
      }
  };

  const discardSession = async () => {
      setSessionNotice(null);
      try { await wsStore.clearSession(); } catch { /* nothing to clear */ }
  };

  const handleTransfer = ({ sourceId, sourceCol, mode, keyCol, name }: TransferSpec) => {
      const src = datasets.find(d => d.id === sourceId);
      const tgt = activeDataset;
      if (!src || !tgt) return;
      const srcColArr = src.table.data[sourceCol];
      let newCol: any[];
      if (mode === 'order') {
          newCol = Array.from({ length: tgt.table.nRows }, (_, i) => srcColArr[i] ?? null);
      } else {
          const sk = src.table.data[keyCol], tk = tgt.table.data[keyCol];
          const map = new Map<string, any>();
          for (let i = 0; i < src.table.nRows; i++) map.set(String(sk[i]), srcColArr[i]);
          newCol = Array.from({ length: tgt.table.nRows }, (_, i) => map.get(String(tk[i])) ?? null);
      }
      const newTable: DataTable = {
          columns: tgt.table.columns.includes(name) ? tgt.table.columns : [...tgt.table.columns, name],
          data: { ...tgt.table.data, [name]: newCol },
          nRows: tgt.table.nRows,
      };
      setDatasets(prev => prev.map(d => d.id === tgt.id ? { ...d, table: newTable } : d));
      const filled = newCol.filter(v => v != null).length;
      logProvenance(tgt.id, `Column "${name}" copied from "${src.name}" (${mode === 'order' ? 'by row order' : `matched on "${keyCol}"`}) — ${filled}/${tgt.table.nRows} rows filled`);
      setColorBy(name);
      setUploadStatus(`Transferred "${sourceCol}" from ${src.name} → "${name}" (${filled}/${tgt.table.nRows} rows filled).`);
      return newTable;
  };

  const deleteWorkspace = async (name: string) => {
      try {
          await wsStore.deleteWorkspace(name);
          await refreshWorkspaces();
      } catch { /* ignore */ }
  };

  const updateAxis = (axis: 'x' | 'y' | 'z', col: string | null) => {
      if (viewMode === "2D") {
          if (axis === 'z' || !col) return;
          setDatasets(prev => prev.map(d => d.id === activeId
              ? { ...d, axes2d: { ...d.axes2d, [axis]: col }, labels2d: { ...d.labels2d, [axis]: col } }
              : d));
          return;
      }
      setDatasets(prev => prev.map(d => d.id === activeId
          ? { ...d, axes: { ...d.axes, [axis]: col }, labels: { ...d.labels, [axis]: col ?? 'Z' } }
          : d));
      if (axis === 'z' && !col) setViewMode("2D");
  };

  const updateLabel = (axis: 'x' | 'y' | 'z', text: string) => {
      setDatasets(prev => prev.map(d => {
          if (d.id !== activeId) return d;
          return viewMode === "2D"
              ? { ...d, labels2d: { ...d.labels2d, [axis]: text } }
              : { ...d, labels: { ...d.labels, [axis]: text } };
      }));
  };

  const removeDataset = (id: number) => {
      const remaining = datasets.filter(d => d.id !== id);
      setDatasets(remaining);
      if (activeId === id) {
          const next = remaining[0] ?? null;
          setActiveId(next?.id ?? null);
          if (next) setColorBy(pickDefaultColorBy(next.table, colorBy));
      }
  };

  const handleClearData = () => {
      setDatasets([]);
      setActiveId(null);
      setColorBy("");
      setShapeBy("");
      setPinnedViews([]);
      setDatasetFile(null);
      setComponentsFile(null);
      setUploadStatus("");
      setClusterMethod("NONE");
      setIsRotating(false);
      // Reset the hidden inputs so re-selecting the same file fires onChange again
      if (dsInputRef.current) dsInputRef.current.value = "";
      if (compInputRef.current) compInputRef.current.value = "";
  };

  // eps is a DISTANCE in the units of the plotted axes, so a fixed 0.1–5 range
  // is meaningless on anything but standardized or small-range data (B5). Scale
  // the slider to the actual spread; the number box beside it removes the
  // ceiling entirely.
  const epsSliderMax = useMemo(() => {
      if (standardize) return 5;                    // z-scores: 5 SD is already generous
      if (!processedData || !activeDataset) return 5;
      const ax = effectiveAxes(activeDataset, viewMode);
      let span = 0;
      for (const c of [ax.x, ax.y, ax.z].filter(Boolean) as string[]) {
          let lo = Infinity, hi = -Infinity;
          for (const raw of processedData.data[c] ?? []) {
              const v = asNumber(raw);
              if (v !== null) { if (v < lo) lo = v; if (v > hi) hi = v; }
          }
          if (hi > lo) span = Math.max(span, hi - lo);
      }
      // Half the widest axis span is well past where DBSCAN merges everything.
      return span > 0 ? Math.max(1, Math.round(span / 2)) : 5;
  }, [standardize, processedData, activeDataset, viewMode]);
  const epsSliderStep = useMemo(
      () => Math.max(0.001, Math.round((epsSliderMax / 100) * 1000) / 1000),
      [epsSliderMax],
  );

  const handleCluster = async () => {
      if (clusterMethod === "NONE" || !processedData) return;
      setIsClustering(true);
      // Yield until the busy state has PAINTED before the O(n²) work starts —
      // a plain 30ms timer can fire before the click frame presents.
      await paintYield();
      try {
          const ax = effectiveAxes(activeDataset!, viewMode);
          const rawCols = [processedData.data[ax.x], processedData.data[ax.y]];
          if (ax.z) rawCols.push(processedData.data[ax.z]);
          const axNames = [ax.x, ax.y, ...(ax.z ? [ax.z] : [])];
          // Refuse before running: a text axis used to be filled with zeros and
          // clustered on silently, reporting a full set of sizes (A11).
          const unusable = nonNumericAxes(rawCols, axNames);
          if (unusable.length) {
              setUploadStatus(`Error: ${unusable.map(c => `"${c}"`).join(', ')} ${unusable.length === 1 ? 'has' : 'have'} no numeric values, so ${unusable.length === 1 ? 'it cannot' : 'they cannot'} be used as ${unusable.length === 1 ? 'an axis' : 'axes'} for clustering. Assign a numeric column to each axis first.`);
              setIsClustering(false);
              return;
          }
          const cols = standardize ? zscoreCellColumns(rawCols) : rawCols;
          const imp = countImputed(rawCols, axNames);
          const labels = clusterMethod === "DBSCAN"
              ? dbscan(cols, eps, minSamples)
              : kmeans(cols, k);
          const newTable: DataTable = {
              columns: processedData.columns.includes("Cluster") ? processedData.columns : [...processedData.columns, "Cluster"],
              data: { ...processedData.data, Cluster: labels },
              nRows: processedData.nRows
          };
          setDatasets(prev => prev.map(d => d.id === activeId ? { ...d, table: newTable } : d));
          logProvenance(activeId, `${clusterMethod} clustering on ${axNames.join(' · ')}${standardize ? ' (z-scored)' : ''} wrote the "Cluster" column`);
          // The pre-cluster coloring is the natural default for composition breakdowns
          if (colorBy !== "Cluster") setBreakdownBy(colorBy);
          setColorBy("Cluster");
          const sizes = new Map<string, number>();
          for (const l of labels) sizes.set(l, (sizes.get(l) ?? 0) + 1);
          setUploadStatus(
              `${clusterMethod} on ${axNames.join(' · ')} — ${sortCategories(Array.from(sizes.keys())).map(l => `${l}: ${sizes.get(l)}`).join(', ')}.`
              + missingNote({ strategy: 'median', imputedCells: imp.cells, totalCells: imp.total, byVariable: imp.byVariable, rowsUsed: processedData.nRows, rowsDropped: 0 }, processedData.nRows));
      } catch (err: any) {
          setUploadStatus(`Clustering failed: ${err?.message ?? err}`);
      } finally {
          setIsClustering(false);
      }
  };

  // Target by id — NOT .js-plotly-plot: Plotly.toImage spawns (and can leak) a
  // temporary clone div with that class, and grabbing the purged clone exports
  // empty default axes instead of the real plot
  const getActivePlotDiv = () => document.getElementById('active-plot') as any;

  // The window the user is actually looking at in 2D. When no explicit viewport
  // is set we read the autoranged bounds Plotly computed (`_fullLayout` is
  // internal, but it is the only place the resolved range exists), so a relative
  // zoom/pan starts from what is on screen rather than from raw data extents.
  const get2dRange = (): { x: [number, number], y: [number, number] } | null => {
      if (range2d) return range2d;
      const fl = getActivePlotDiv()?._fullLayout;
      const x = fl?.xaxis?.range, y = fl?.yaxis?.range;
      if (!Array.isArray(x) || !Array.isArray(y)) return null;
      const vals = [x[0], x[1], y[0], y[1]].map(Number);
      if (!vals.every(Number.isFinite) || x[0] === x[1] || y[0] === y[1]) return null;
      return { x: [vals[0], vals[1]], y: [vals[2], vals[3]] };
  };

  const fmtRange = (a: number, b: number) => {
      const p = Math.abs(b - a) >= 10 ? 0 : 2;
      return `${a.toFixed(p)}…${b.toFixed(p)}`;
  };

  // Temporarily dress the live plot with a descriptive title + legend for
  // capture, then undress. Any later re-render also restores the props-driven
  // layout, so a failed restore can't stick.
  const setExportDressing = async (Plotly: any, gd: any, on: boolean) => {
      if (!includeExportInfo || !activeDataset || !processedData) return;
      const labels = effectiveLabels(activeDataset, viewMode);
      const axesStr = viewMode === "3D" ? `${labels.x} × ${labels.y} × ${labels.z}` : `${labels.x} × ${labels.y}`;
      const kind = getColorFieldKind(processedData.data[colorBy] ?? []);
      await Plotly.relayout(gd, on
          ? {
              'title.text': `${axesStr} · colored by ${colorBy}`,
              'title.font.color': '#111111',
              showlegend: kind === "categorical",
              'legend.font.color': '#444444',
              'legend.bgcolor': 'rgba(255,255,255,0.7)',
            }
          : { 'title.text': `${activeDataset.name} · live`, showlegend: false });
      if (kind === "continuous") {
          // The single continuous trace is index 0 — show its colorbar instead of a legend
          await Plotly.restyle(gd, on
              ? {
                  'marker.showscale': true,
                  'marker.colorbar.title.text': colorBy,
                  'marker.colorbar.title.font.color': '#444444',
                  'marker.colorbar.tickfont.color': '#444444',
                  'marker.colorbar.thickness': 12,
                }
              : { 'marker.showscale': false }, [0]);
      }
  };

  const exportPNG = async (): Promise<string | null> => {
      if (!activeDataset) return 'No active dataset to export.';
      const Plotly = (await import('plotly.js-gl3d-dist-min')).default;
      const gd = getActivePlotDiv();
      if (!gd || !gd.data) return 'The active plot is not ready to export yet.';
      // Hold the camera still for the capture, as exportGIF already did: a PNG
      // saved mid-rotation catches the camera in motion, so the saved angle is
      // not the one on screen when the button was pressed (C13).
      const wasRotating = isRotating;
      setIsRotating(false);
      try {
          // One frame for the rAF loop to observe the flag before capturing.
          await new Promise(r => requestAnimationFrame(() => r(null)));
          await setExportDressing(Plotly, gd, true);
          await Plotly.downloadImage(gd, {
              format: 'png',
              width: gd.offsetWidth || 900,
              height: gd.offsetHeight || 700,
              scale: 2,
              filename: `${activeDataset.name}_${colorBy}_${viewMode}`,
          });
      } catch (err) {
          console.error(err);
          const message = 'PNG export failed — see console.';
          setUploadStatus(message);
          return message;
      } finally {
          try { await setExportDressing(Plotly, gd, false); } catch { /* a re-render restores the live plot */ }
          setIsRotating(wasRotating);
      }
      return null;
  };

  const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

  const exportGIF = async (): Promise<string | null> => {
      const gd = getActivePlotDiv();
      if (!gd || !activeDataset) return 'The active plot is not ready to export yet.';
      if (viewMode !== "3D") return 'A rotating GIF is available only for a 3D view.';
      if (isExporting) return 'Another export is already in progress.';
      const wasRotating = isRotating;
      setIsRotating(false);
      // The whole camera, not just the eye: restoring `{ eye }` alone dropped
      // `center`, which would undo the vertical centring on every GIF export.
      const prevCam: SceneCamera = { ...camera, eye: { ...camera.eye } };
      const gifOrbit = orbitFrom(camera);
      const FRAMES = 36;
      // Cap size — GIF bytes grow fast with dimensions
      const W = Math.min(gd.offsetWidth || 700, 720);
      const H = Math.round(W * ((gd.offsetHeight || 600) / (gd.offsetWidth || 700)));
      // One state update up front, then NO React state changes until the loop
      // ends: a Plotly.react (from any re-render) landing mid-toImage deadlocks
      // WebGL capture. Progress is written straight into the button's DOM text.
      setIsExporting("Rendering GIF…");
      await new Promise(r => setTimeout(r, 100));
      try {
          const Plotly = (await import('plotly.js-gl3d-dist-min')).default;
          const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
          await setExportDressing(Plotly, gd, true);
          const canvas = document.createElement('canvas');
          canvas.width = W; canvas.height = H;
          const ctx = canvas.getContext('2d')!;
          const gif = GIFEncoder();
          let palette: ReturnType<typeof quantize> | undefined;
          const progressNode = gifButtonRef.current;
          for (let i = 0; i < FRAMES; i++) {
              if (progressNode) progressNode.textContent = `Rendering ${i + 1}/${FRAMES}…`;
              const t = (2 * Math.PI * i) / FRAMES;
              const frameGd = getActivePlotDiv();
              if (!frameGd || !frameGd.data) throw new Error("Plot div disappeared mid-export");
              await withTimeout(Plotly.relayout(frameGd, {
                  'scene.camera.eye': gifOrbit.eyeAt(gifOrbit.start + t)
              }), 10000, "camera move");
              const url: string = await withTimeout(
                  Plotly.toImage(frameGd, { format: 'png', width: W, height: H, scale: 1 }) as Promise<string>,
                  15000, `frame ${i + 1} capture`);
              const img = new Image();
              await withTimeout(new Promise((res, rej) => {
                  img.onload = res;
                  img.onerror = () => rej(new Error("frame image decode failed"));
                  img.src = url;
              }), 10000, `frame ${i + 1} decode`);
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, W, H);
              ctx.drawImage(img, 0, 0, W, H);
              const { data: rgba } = ctx.getImageData(0, 0, W, H);
              // Quantize once and reuse the palette (finding F16). Building a
              // fresh 256-colour palette per frame measured 313 ms/frame at 50k
              // points, ~36 ms when reused — and rotation is the case where
              // reuse is safe by construction: every frame shows the same points
              // in the same colours, only from a different angle, so frame 0's
              // palette already covers the sequence. (A palette built per frame
              // can also make flat regions shimmer between frames, so this is
              // marginally better looking as well as much faster.)
              palette ??= quantize(rgba, 256);
              gif.writeFrame(applyPalette(rgba, palette), W, H, { palette, delay: 80 });
          }
          gif.finish();
          const blob = new Blob([gif.bytes()], { type: 'image/gif' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${activeDataset.name}_${colorBy}_rotation.gif`;
          a.click();
          URL.revokeObjectURL(a.href);
      } catch (err) {
          console.error(err);
          const message = "GIF export failed — see console.";
          setUploadStatus(message);
          return message;
      } finally {
          try {
              const Plotly = (await import('plotly.js-gl3d-dist-min')).default;
              const finalGd = getActivePlotDiv();
              if (finalGd && finalGd.data) await setExportDressing(Plotly, finalGd, false);
          } catch { /* a re-render restores the props-driven layout anyway */ }
          setCamera(prevCam);
          setIsRotating(wasRotating);
          setIsExporting("");
      }
      return null;
  };

  const exportHTML = async (): Promise<string | null> => {
      if (!activeDataset || !processedData) return 'No active dataset to export.';
      setIsExporting("Building HTML…");
      try {
          const labels = effectiveLabels(activeDataset, viewMode);
          const axes = effectiveAxes(activeDataset, viewMode);
          const axesStr = viewMode === "3D" ? `${labels.x} × ${labels.y} × ${labels.z}` : `${labels.x} × ${labels.y}`;
          const kind = getColorFieldKind(processedData.data[colorBy] ?? []);
          const title = includeExportInfo ? `${axesStr} · colored by ${colorBy}` : `${activeDataset.name}`;

          // No decorative floor, and coordinates at 6 significant figures: no
          // scatter plot resolves the 17th digit, and the two together took a
          // measured 20,000-point 3D export from 3,831 KB to 2,148 KB with no
          // visible difference (finding F3).
          const data = buildTraces(processedData, colorBy, viewMode, axes, labels, mutedMap, false, shapeBy, false)
              .map(trace => {
                  const t = { ...trace } as Record<string, unknown>;
                  for (const key of ['x', 'y', 'z'] as const) {
                      const arr = t[key];
                      if (Array.isArray(arr)) {
                          t[key] = arr.map(v => (typeof v === 'number' && Number.isFinite(v)
                              ? Number(v.toPrecision(6))
                              : v));
                      }
                  }
                  return t;
              });
          if (includeExportInfo && kind === "continuous" && (data[0] as { marker?: Record<string, unknown> })?.marker) {
              const m = (data[0] as { marker: Record<string, unknown> }).marker;
              m.showscale = true;
              m.colorbar = { title: { text: colorBy }, thickness: 14 };
          }

          // Standalone layout — concrete colors only (no CSS vars, which won't
          // resolve in a bare file); start from the user's current camera angle
          const gd = getActivePlotDiv();
          const startCam = gd?.layout?.scene?.camera ?? camera;
          const axesOn = showAxes[viewMode];
          const exportAspect = aspect;
          const layout: any = {
              autosize: true,
              margin: viewMode === "2D" ? { l: 50, r: 20, b: 50, t: 60 } : { l: 0, r: 0, b: 0, t: 60 },
              title: { text: title, font: { color: '#111111', size: 16 } },
              paper_bgcolor: 'white', plot_bgcolor: 'white',
              showlegend: includeExportInfo && kind === "categorical",
              legend: { font: { color: '#333333' }, bgcolor: 'rgba(255,255,255,0.8)' },
          };
          const axisCfg = (label: string, g: string) => ({
              showgrid: axesOn, zeroline: axesOn, showticklabels: axesOn,
              gridcolor: g, zerolinecolor: '#888888', tickfont: { color: '#888888' },
              title: { text: label, font: { color: '#111111' } },
          });
          if (viewMode === "3D") {
              // Exports must match the screen, including the box shape.
              layout.scene = { camera: startCam, bgcolor: 'white', aspectmode: exportAspect,
                  xaxis: axisCfg(labels.x, '#bbbbbb'), yaxis: axisCfg(labels.y, '#bbbbbb'), zaxis: axisCfg(labels.z, '#bbbbbb') };
          } else {
              layout.xaxis = axisCfg(labels.x, '#cccccc');
              layout.yaxis = axisCfg(labels.y, '#cccccc');
              // Same intent as startCam above: export the view as it is framed now
              const win = get2dRange();
              if (win) {
                  layout.xaxis.range = [...win.x];
                  layout.yaxis.range = [...win.y];
              }
          }

          // Inline the Plotly bundle so the file is fully self-contained (offline-safe).
          // Neutralize any "</script" so it can't close our inline <script> early.
          const bundle = (await (await fetch('/vendor/plotly-gl3d.min.js')).text()).replace(/<\/script/gi, '<\\/script');
          const safeJSON = (o: any) => JSON.stringify(o).replace(/<\//g, '<\\/');
          const rotate = viewMode === "3D";

          const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${title.replace(/[<>&]/g, '')}</title>
<style>
  html,body{margin:0;height:100%;font-family:sans-serif;background:#fff}
  #plot{width:100vw;height:100vh}
  #ctrl{position:fixed;top:10px;right:12px;z-index:10;font-size:13px;
    padding:6px 12px;border:1px solid #333;background:#fff;cursor:pointer}
</style></head><body>
${rotate ? '<button id="ctrl">⏸ Pause rotation</button>' : ''}
<div id="plot"></div>
<script>${bundle}</script>
<script>
  var data=${safeJSON(data)},layout=${safeJSON(layout)};
  Plotly.newPlot('plot',data,layout,{responsive:true});
${rotate ? `  var rotating=true,t=Math.atan2(layout.scene.camera.eye.y,layout.scene.camera.eye.x)||0;
  function step(){ if(rotating){ t+=0.008;
    Plotly.relayout('plot',{'scene.camera.eye':{x:2.2*Math.cos(t),y:2.2*Math.sin(t),z:0.6}}); }
    requestAnimationFrame(step); }
  requestAnimationFrame(step);
  var btn=document.getElementById('ctrl');
  btn.onclick=function(){ rotating=!rotating; btn.textContent=rotating?'⏸ Pause rotation':'▶ Resume rotation'; };` : ''}
</script>
</body></html>`;

          const blob = new Blob([html], { type: 'text/html' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${activeDataset.name}_${colorBy}_${viewMode}.html`;
          a.click();
          URL.revokeObjectURL(a.href);
      } catch (err) {
          console.error(err);
          const message = "HTML export failed — see console.";
          setUploadStatus(message);
          return message;
      } finally {
          setIsExporting("");
      }
      return null;
  };

  const exportDatasetCsv = (): string | null => {
      const table = freshTableRef.current ?? processedData;
      if (!activeDataset || !table) return 'No active dataset to export.';
      const rows = [
          table.columns.map(csvCell).join(','),
          ...Array.from({ length: table.nRows }, (_, row) =>
              table.columns.map(column => csvCell(table.data[column]?.[row])).join(',')
          ),
      ];
      // BOM: without it Excel reads the file as the system codepage, so any
      // non-ASCII column name or value arrives mangled (C12).
      const blob = new Blob([CSV_BOM + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${activeDataset.name}_data.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      return null;
  };

  // Pinning mounts a whole new Plotly pane, WebGL context and all, and then
  // every existing pane resizes into the re-split grid. Measured on the iris
  // demo that was 1312 ms from click to paint (259 ms of it inside the handler,
  // then a 933 ms task) — the button appeared frozen.
  //
  // The work is irreducible; what was wrong is that it was URGENT. As a
  // transition React renders it at low priority, so the browser paints the
  // click before the new pane is built instead of after. The pin object itself
  // is still built synchronously: it reads the live camera off the plot div,
  // which has to be its value at click time.
  const [isPinning, startPinning] = useTransition();

  // Pins and analysis views share the grid's 3 extra panes.
  const extraPanes = () => pinnedViews.length + analysisViews.length;

  const pinCurrentView = () => {
      if (extraPanes() >= 3) {
          setUploadStatus("Pane limit reached — the grid holds the live view plus 3 panels (pins or analyses). Remove one first.");
          return;
      }
      const pin = (
          // Tables are replaced wholesale on change, so sharing the reference is a safe snapshot
          { id: Date.now(), data: processedData, colorBy, shapeBy,
            axes: effectiveAxes(activeDataset!, viewMode), labels: effectiveLabels(activeDataset!, viewMode), viewMode,
            showAxes: showAxes[viewMode],
            aspect,
            // Freeze the 2D framing too, so a pin keeps showing the region it was
            // taken on after the live view is zoomed elsewhere or reset
            range2d: viewMode === "2D" ? get2dRange() : null,
            // ...and the 3D angle, for the same reason. Every 3D pane used to
            // read the single live `camera`, so pins rotated with the live view
            // and could never hold the viewpoint they were taken from — four
            // scene redraws a frame for a picture nobody asked to move (F11).
            // Read from the plot itself so a camera the user dragged is caught
            // even when state has not been told about it yet.
            camera: viewMode === "3D"
                ? (getActivePlotDiv()?.layout?.scene?.camera ?? cameraRef.current)
                : null,
            muted: { ...mutedMap },
            label: `${activeDataset?.name ?? 'Pinned'} · ${colorBy}` });
      startPinning(() => setPinnedViews(prev => [...prev, pin]));
  };

  const removePin = (id: number) => {
      // Unmounting a pane re-splits the grid and resizes the survivors, so it
      // costs what pinning costs. Same treatment.
      startPinning(() => setPinnedViews(prev => prev.filter(v => v.id !== id)));
  };

  const removeAnalysisView = (id: number) => {
      startPinning(() => setAnalysisViews(prev => prev.filter(v => v.id !== id)));
  };

  // The one gate every analysis request goes through — the Analyze panel and
  // the assistant's run_test/plot_chart meet HERE, so the validator, the
  // pane budget, provenance, and the mode fence can never diverge between
  // the two entry points. Returns the aggregate text the caller may show or
  // hand to the model; a rejection returns the typed failures, formatted.
  const runAnalysisPlan = (plan: unknown): string => {
      const t = latestTable();
      if (!t || !activeDataset) return 'No dataset loaded.';
      const profile = analysisProfileOf(t, activePolicy);
      const failures: ValidationFailure[] = validatePlan(plan, profile);
      if (failures.length) return formatFailures(failures);
      if (extraPanes() >= 3) {
          return 'Pane limit reached — the grid holds the live view plus 3 panels (pins or analyses). Remove one first (the X on the pane, or remove_pin for pins).';
      }
      const p = plan as AnalysisPlan;
      try {
          if (p.kind === 'test') {
              const result = runTestPlan(p, t, profile);
              const label = `${result.statLabel}: ${p.column} by ${p.groupBy}`;
              startPinning(() => setAnalysisViews(prev => [...prev, { id: Date.now(), kind: 'analysis', label, test: result }]));
              logProvenance(activeId, `Ran ${p.test} test: ${p.column} by ${p.groupBy}${p.groups ? ` (groups: ${p.groups.join(', ')})` : ''}`);
              return `${formatTestResult(result)}\nA results card was added to the canvas.`;
          }
          const chart = compileChart(p, t, profile);
          startPinning(() => setAnalysisViews(prev => [...prev, { id: Date.now(), kind: 'analysis', label: chart.title, chart }]));
          logProvenance(activeId, `Plotted ${p.mark} chart: ${chart.title}`);
          return `${chart.summary}${chart.notes.length ? `\nNotes: ${chart.notes.join(' ')}` : ''}\nThe chart was added to the canvas.`;
      } catch (err) {
          return `Analysis error: ${(err as Error)?.message ?? err}`;
      }
  };

  const handleRunPCA = (vars: string[], k: number, standardize: boolean, label = '', missing: MissingStrategy = 'median'): string => {
      const t = freshTableRef.current ?? processedData;
      if (!t || !activeDataset) return 'No dataset loaded.';
      try {
          const res = runPCA(t, vars, { k, standardize, label, missing });
          freshTableRef.current = res.table;
          const topContributors = Object.fromEntries(
              Object.entries(res.loadings).map(([pc, rows]) => [pc, rows.slice(0, 5)])
          );
          const cols = res.columns;
          const run: PcaRun = {
              label: res.label, columns: cols, variables: vars, k: res.k, standardize,
              savedAt: new Date().toISOString(), varianceExplained: res.varianceExplained,
              missing: res.missing,
          };
          setDatasets(prev => prev.map(d => {
              if (d.id !== activeId) return d;
              // A single kept component (a composite score) lands on the X axis and
              // leaves the rest of the framing alone — the workflow is "build several
              // composites, then plot them against each other", so wiping Y/Z on each
              // run would fight the user. Multi-component runs re-frame fully.
              const inTable = (c: string | null) => (c && res.table.columns.includes(c) ? c : null);
              const axes = res.k === 1
                  ? { x: cols[0], y: inTable(d.axes.y) ?? cols[0], z: inTable(d.axes.z) }
                  : { x: cols[0], y: cols[1], z: res.k >= 3 ? cols[2] : null };
              const axes2d = res.k === 1
                  ? { x: cols[0], y: inTable(d.axes2d.y) ?? cols[0] }
                  : { x: cols[0], y: cols[1] };
              return {
                  ...d,
                  table: res.table,
                  summary: { ...(d.summary ?? {}), top_contributors: { ...(d.summary?.top_contributors ?? {}), ...topContributors } },
                  axes, labels: { x: axes.x, y: axes.y, z: axes.z ?? 'Z' },
                  axes2d, labels2d: { ...axes2d },
                  pcaRuns: [...(d.pcaRuns ?? []).filter(r => r.label !== res.label), run],
              };
          }));
          logProvenance(activeId, `PCA${res.label ? ` "${res.label}"` : ''} on ${vars.length} variables (${standardize ? 'standardized' : 'unstandardized'}, missing: ${missing}) added column${cols.length === 1 ? '' : 's'} ${cols.join(', ')}${res.replaced.length ? `, replacing ${res.replaced.join(', ')}` : ''}`);
          if (res.k < 3) setViewMode('2D');
          setPcaInfo({ varianceExplained: res.varianceExplained, cumulative: res.cumulative, spectrum: res.spectrum, eigenvalues: res.eigenvalues, standardize, k: res.k, columns: res.columns });
          const pct = res.varianceExplained.map((v, i) => `${cols[i] ?? `PC${i + 1}`} ${(v * 100).toFixed(0)}%`).join(', ');
          const replacedNote = res.replaced.length
              ? ` Replaced the previous ${res.label ? `"${res.label}"` : 'unnamed'} run (${res.replaced.join(', ')}).`
              : '';
          const impNote = missingNote(res.missing, t.nRows);
          const msg = res.k === 1
              ? `PCA on ${vars.length} variables (${standardize ? 'standardized' : 'unstandardized'}): kept the top component as composite "${cols[0]}" — ${pct} of variance.${replacedNote} It is plotted on the X axis.${impNote}`
              : `PCA on ${vars.length} variables (${standardize ? 'standardized' : 'unstandardized'}): kept ${res.k} components — ${pct} (cumulative ${(res.cumulative[res.cumulative.length - 1] * 100).toFixed(0)}%).${replacedNote} Scores added as ${res.label ? `${res.label}-labeled` : 'PC'} columns and plotted.${impNote}`;
          setUploadStatus(msg);
          return msg;
      } catch (err: any) {
          const msg = `PCA failed: ${err?.message ?? err}`;
          setUploadStatus(msg);
          return msg;
      }
  };

  // --- Assistant bridge ------------------------------------------------------
  // Tool calls in one model response run back-to-back, before React re-renders,
  // so a clustering result must be readable by the next tool immediately:
  // freshTableRef carries the just-computed table until the next render.
  const freshTableRef = useRef<DataTable | null>(null);
  useEffect(() => { freshTableRef.current = null; }, [processedData]);
  const latestTable = (): DataTable | null => freshTableRef.current ?? processedData;

  // What the assistant may see is the ACTIVE dataset's own mode — profiles
  // describe one dataset. (The tool list is stricter: combinedPolicy over all
  // loaded datasets, because tools can cross dataset boundaries.)
  const activePolicy = policyFor(activeDataset?.dataMode ?? 'private');
  // The Analyze panel's option lists come from the same profile the validator
  // reads. Memoized on the table + mode, not on activePolicy (fresh object
  // identity every render).
  const analysisProfile = useMemo(
      () => (processedData ? analysisProfileOf(processedData, policyFor(activeDataset?.dataMode ?? 'private')) : null),
      [processedData, activeDataset?.dataMode],
  );
  const sessionPolicy = combinedPolicy(datasets.map(d => d.dataMode));

  const columnProfiles = (): ColumnProfile[] => {
      const t = latestTable();
      if (!t) return [];
      const policy = activePolicy;
      return t.columns.map(col => {
          const vals = t.data[col] ?? [];
          let missing = 0, isNumeric = false;
          const nums: number[] = [];
          const counts = new Map<string, number>();
          for (const v of vals) {
              if (v == null) { missing++; continue; }
              const n = asNumber(v);
              if (n !== null) { isNumeric = true; nums.push(n); }
              else counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
          }

          if (isNumeric) {
              // Shape, not just extent. min/max alone cannot tell the assistant
              // that a variable is skewed, that its "0–100" range is really
              // 0–10 with one outlier at 100, or that a 1–7 item is stacked at
              // the ceiling — all things it should be warning the user about.
              // Still strictly aggregate: no value is attributable to a row.
              nums.sort((a, b) => a - b);
              const n = nums.length;
              const q = (p: number) => n ? nums[Math.min(n - 1, Math.floor(p * n))] : NaN;
              const mean = n ? nums.reduce((s, v) => s + v, 0) / n : NaN;
              // Population sd (÷n), matching the rest of the app.
              const sd = n ? Math.sqrt(nums.reduce((s, v) => s + (v - mean) ** 2, 0) / n) : NaN;
              const r = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);
              return {
                  name: col, kind: 'numeric' as const, missing,
                  min: r(nums[0]), max: r(nums[n - 1]),
                  mean: r(mean), sd: r(sd), q1: r(q(0.25)), median: r(q(0.5)), q3: r(q(0.75)),
              };
          }

          // Per-value guard: a value covering many rows describes a group, one
          // covering a single row IS that row (D8). Filtering per value rather
          // than per column keeps an ordinary 60-level `school` variable usable
          // while still never naming an individual.
          const shown = Array.from(counts.entries())
              .filter(([, c]) => policy.fullCategories || !valueIsTooRare(c))
              .sort((a, b) => b[1] - a[1]);
          // A column explicitly named as an identifier is withheld regardless:
          // in long-format data a participant ID legitimately repeats, and would
          // otherwise clear the frequency bar. (Not in open mode, where the
          // user has declared there is nothing to protect.)
          const identifier = !policy.identifiersVisible && isIdentifierColumn(col);
          const withheld = counts.size - shown.length;
          return {
              name: col, kind: 'categorical' as const, missing, nUnique: counts.size,
              ...(identifier ? {} : { topCategories: shown.slice(0, 8).map(([value, count]) => ({ value, count })) }),
              ...(identifier || withheld ? { rareValuesWithheld: identifier ? counts.size : withheld } : {}),
          };
      });
  };

  const bridgeRef = useRef<AppBridge>(null as any);
  // Lets the sidebar open the assistant with a prefilled question (upload errors)
  const askAssistantRef = useRef<((q: string) => void) | null>(null);
  // Assistant dock mode: right column (default) / bottom row / floating overlay
  const [assistantDock, setAssistantDock] = useState<'right' | 'bottom' | 'float'>('right');
  // The scripted walkthrough is driving the workbench: uploading mid-tour would
  // land a dataset the script does not know about between two of its steps, so
  // the control is disabled and says why, with the way out beside it.
  const [walkthroughActive, setWalkthroughActive] = useState(false);
  const exitWalkthroughRef = useRef<(() => void) | null>(null);
  const startWalkthroughRef = useRef<(() => void) | null>(null);
  // Mirrors an assistant/walkthrough PCA back into the PCA panel's controls.
  const [externalPcaRun, setExternalPcaRun] = useState<{ vars: string[]; k: number; standardize: boolean; missing: MissingStrategy; label: string; seq: number } | null>(null);
  useEffect(() => {
      const saved = localStorage.getItem('scatterlab.assistant.dock');
      if (saved === 'right' || saved === 'bottom' || saved === 'float') setAssistantDock(saved);
  }, []);
  // useCallback so memoizing AssistantPanel is not defeated by a fresh closure
  // on every Home render (F10).
  // The panel header's lock/globe icon opens the mode dialog for the active
  // dataset — the info and the swap confirmation both live there. useCallback
  // so memoizing AssistantPanel is not defeated by a fresh closure (F10); its
  // identity changes only when the active dataset or its mode does, which is
  // when the panel re-renders anyway.
  const activeDatasetId = activeDataset?.id ?? null;
  const openActiveAccessInfo = useCallback(() => {
      if (activeDatasetId == null) return;
      setAccessInfo(activeDatasetId);
  }, [activeDatasetId]);

  const changeDock = useCallback((d: 'right' | 'bottom' | 'float') => {
      setAssistantDock(d);
      localStorage.setItem('scatterlab.assistant.dock', d);
  }, []);
  bridgeRef.current = {
      getState: () => ({
          datasets: datasets.map(d => ({ name: d.name, nRows: d.table.nRows, active: d.id === activeId, dataMode: d.dataMode })),
          columns: columnProfiles(),
          axes: activeDataset ? effectiveAxes(activeDataset, viewMode) : { x: '', y: '', z: null },
          colorBy,
          shapeBy,
          viewMode,
          pinnedViews: pinnedViews.length,
          clusterSettings: { method: clusterMethod, eps, minSamples, k, standardize },
          clusterBreakdown: { attribute: breakdownBy, direction: breakdownDirection, palette: heatmapPalette },
          pcaRuns: (activeDataset?.pcaRuns ?? []).map(r => ({
              label: r.label || '(unnamed)', columns: r.columns, variables: r.variables,
              standardize: r.standardize, savedAt: r.savedAt,
              varianceExplained: r.varianceExplained.map(v => Math.round(v * 1000) / 1000),
              missing: r.missing && { strategy: r.missing.strategy, imputedCells: r.missing.imputedCells, rowsUsed: r.missing.rowsUsed, rowsDropped: r.missing.rowsDropped },
          })),
      }),

      setPlot: (opts) => {
          const t = latestTable();
          if (!t) return 'No dataset loaded — the user can load one (or the demo) first.';
          const numeric = new Set(numericColumns(t));
          const problems: string[] = [];
          const targetMode = opts.view_mode ?? viewMode;
          for (const [axis, col] of [['x', opts.x], ['y', opts.y], ['z', opts.z]] as const) {
              if (col && !numeric.has(col)) problems.push(`"${col}" is not a numeric column (${axis} axis).`);
          }
          if (opts.color_by && !t.columns.includes(opts.color_by)) problems.push(`"${opts.color_by}" is not a column.`);
          // "" / "none" is the documented way to switch the shape channel off
          const clearShape = opts.shape_by != null && ['', 'none'].includes(String(opts.shape_by).toLowerCase());
          if (opts.shape_by && !clearShape) {
              if (!t.columns.includes(opts.shape_by)) {
                  problems.push(`"${opts.shape_by}" is not a column.`);
              } else {
                  const levels = shapeCategories(t.data[opts.shape_by] ?? []);
                  if (levels.length > MAX_SHAPE_CATEGORIES) {
                      problems.push(`"${opts.shape_by}" has more than ${MAX_SHAPE_CATEGORIES} distinct values — shape encodes at most ${MAX_SHAPE_CATEGORIES}, and is only readable up to about 5. Use color_by for it instead, or shape a coarser column.`);
                  }
              }
          }
          if (problems.length) return `Not applied. ${problems.join(' ')} Numeric columns: ${numericColumns(t).join(', ')}.`;

          if (opts.view_mode) setViewMode(opts.view_mode);
          if (opts.x || opts.y || opts.z) {
              setDatasets(prev => prev.map(d => {
                  if (d.id !== activeId) return d;
                  if (targetMode === '2D') {
                      const axes2d = { x: opts.x ?? d.axes2d.x, y: opts.y ?? d.axes2d.y };
                      return { ...d, axes2d, labels2d: { x: opts.x ?? d.labels2d.x, y: opts.y ?? d.labels2d.y } };
                  }
                  const axes = { x: opts.x ?? d.axes.x, y: opts.y ?? d.axes.y, z: opts.z ?? d.axes.z };
                  return { ...d, axes, labels: { x: axes.x, y: axes.y, z: axes.z ?? 'Z' } };
              }));
          }
          if (opts.color_by) setColorBy(opts.color_by);
          if (opts.shape_by != null) setShapeBy(clearShape ? "" : opts.shape_by);
          const parts = [
              opts.view_mode && `view=${opts.view_mode}`,
              opts.x && `x=${opts.x}`, opts.y && `y=${opts.y}`, opts.z && `z=${opts.z}`,
              opts.color_by && `color=${opts.color_by}`,
              opts.shape_by != null && (clearShape ? 'shape=off' : `shape=${opts.shape_by}`),
          ].filter(Boolean);
          if (!parts.length) return 'Nothing requested — pass at least one of x, y, z, color_by, shape_by, view_mode.';
          const shapeNote = opts.shape_by && !clearShape
              ? ` Marker symbols now encode ${opts.shape_by} (${shapeCategories(t.data[opts.shape_by] ?? []).join(', ')}); a shape key is listed under the legend.`
              : '';
          return `Applied: ${parts.join(', ')}.${shapeNote}`;
      },

      runClustering: (method, opts) => {
          const t = latestTable();
          if (!t || !activeDataset) return 'No dataset loaded.';
          const ax = effectiveAxes(activeDataset, viewMode);
          const rawCols = [t.data[ax.x], t.data[ax.y]];
          if (ax.z) rawCols.push(t.data[ax.z]);
          const useEps = opts.eps ?? eps, useMin = opts.min_samples ?? minSamples, useK = opts.k ?? k;
          const useStd = opts.standardize ?? standardize;
          const axNames = [ax.x, ax.y, ...(ax.z ? [ax.z] : [])];
          const unusable = nonNumericAxes(rawCols, axNames);
          if (unusable.length) {
              return `${unusable.map(c => `"${c}"`).join(', ')} ${unusable.length === 1 ? 'has' : 'have'} no numeric values, so clustering on the current axes would describe nothing. Set the axes to numeric columns first (set_plot), then re-run.`;
          }
          const cols = useStd ? zscoreCellColumns(rawCols) : rawCols;
          const imp = countImputed(rawCols, axNames);
          const labels = method === 'DBSCAN' ? dbscan(cols, useEps, useMin) : kmeans(cols, useK);
          const newTable: DataTable = {
              columns: t.columns.includes('Cluster') ? t.columns : [...t.columns, 'Cluster'],
              data: { ...t.data, Cluster: labels },
              nRows: t.nRows,
          };
          freshTableRef.current = newTable;
          setDatasets(prev => prev.map(d => d.id === activeId ? { ...d, table: newTable } : d));
          logProvenance(activeId, `${method} clustering (assistant) on ${axNames.join(' · ')}${useStd ? ' (z-scored)' : ''} wrote the "Cluster" column`);
          setClusterMethod(method);
          if (opts.eps != null) setEps(opts.eps);
          if (opts.min_samples != null) setMinSamples(opts.min_samples);
          if (opts.k != null) setK(opts.k);
          if (opts.standardize != null) { skipStdReset.current = true; setStandardize(opts.standardize); }
          if (colorBy !== 'Cluster') setBreakdownBy(colorBy);
          setColorBy('Cluster');
          const sizes = new Map<string, number>();
          for (const l of labels) sizes.set(l, (sizes.get(l) ?? 0) + 1);
          const summary = sortCategories(Array.from(sizes.keys())).map(l => `${l}: ${sizes.get(l)}`).join(', ');
          const stdNote = useStd
              ? ` Variables were z-scored first${method === 'DBSCAN' ? ' (eps is in SD units)' : ''}.`
              : ' Variables were used on their raw scales.';
          return `${method} done on ${ax.z ? '3' : '2'} axes (${[ax.x, ax.y, ax.z].filter(Boolean).join(', ')}). Sizes — ${summary}.${stdNote}${missingNote({ strategy: 'median', imputedCells: imp.cells, totalCells: imp.total, byVariable: imp.byVariable, rowsUsed: t.nRows, rowsDropped: 0 }, t.nRows)} Points are now colored by cluster.`;
      },

      getClusterBreakdown: (attribute) => {
          const t = latestTable();
          if (!t) return 'No dataset loaded.';
          const clusterCol = t.data['Cluster'];
          if (!clusterCol) return 'No clustering has been run yet — call run_clustering first.';
          if (!attribute || !t.columns.includes(attribute)) {
              const cats = t.columns.filter(c => c !== 'Cluster' && getColorFieldKind(t.data[c] ?? []) === 'categorical');
              return `"${attribute}" is not a column. Categorical columns: ${cats.join(', ')}.`;
          }
          const attrVals = t.data[attribute];
          // Same principle as the column profile, applied to the whole column:
          // if almost no value covers enough rows to be a group, the breakdown
          // would list individuals verbatim — and would say nothing anyway,
          // every cell reading "value 100% (1)" (D8).
          const attrCounts = new Map<string, number>();
          for (const v of attrVals) if (v != null) attrCounts.set(String(v), (attrCounts.get(String(v)) ?? 0) + 1);
          const groupable = Array.from(attrCounts.values()).filter(c => !valueIsTooRare(c)).length;
          if (!activePolicy.fullCategories && (isIdentifierColumn(attribute) || groupable === 0)) {
              return `"${attribute}" has ${attrCounts.size} distinct values across ${t.nRows} rows, none of them covering enough rows to describe a group — a breakdown would just list individual values rather than say anything about the clusters. Pick a column with repeated categories.`;
          }
          const byCluster: Record<string, { total: number, counts: Record<string, number> }> = {};
          for (let i = 0; i < t.nRows; i++) {
              const c = String(clusterCol[i] ?? 'N/A');
              const a = String(attrVals[i] ?? 'N/A');
              if (!byCluster[c]) byCluster[c] = { total: 0, counts: {} };
              byCluster[c].total++;
              byCluster[c].counts[a] = (byCluster[c].counts[a] || 0) + 1;
          }
          return sortCategories(Object.keys(byCluster)).map(ck => {
              const { total, counts } = byCluster[ck];
              // Filter here too, not just at the guard above: a column can hold
              // three common categories AND a hundred one-off values, and only
              // the per-value test keeps the latter out of the output.
              const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
              const passing = entries.filter(([, n]) => activePolicy.fullCategories || !valueIsTooRare(n));
              const shown = passing.slice(0, 6);
              // In open mode nothing is withheld, only truncated to the top 6.
              const hidden = activePolicy.fullCategories ? entries.length - shown.length : entries.length - passing.length;
              const rows = shown.map(([v, n]) => `${v} ${Math.round((n / total) * 100)}% (${n})`).join(', ');
              const tail = hidden ? `${shown.length ? ', ' : ''}${hidden} rarer value${hidden === 1 ? '' : 's'} not listed` : '';
              return `${ck} (n=${total}): ${rows}${tail}`;
          }).join('\n');
      },

      saveClusterHeatmap: async ({ attribute, direction, palette }) => {
          const t = latestTable();
          if (!t) return 'No dataset loaded.';
          if (!t.data.Cluster) return 'No clustering has been run yet — call run_clustering first.';
          const candidates = t.columns.filter(c => c !== 'Cluster' && getColorFieldKind(t.data[c] ?? []) === 'categorical');
          if (!candidates.includes(attribute)) {
              return `"${attribute}" is not available for a cluster heatmap. Categorical columns: ${candidates.join(', ')}.`;
          }
          const useDirection = direction === 'group' ? 'group' : 'cluster';
          const usePalette = HEATMAP_PALETTES.includes(palette as HeatmapPalette) ? palette as HeatmapPalette : heatmapPalette;
          const crosstab = buildClusterCrosstab(t, attribute);
          if (!crosstab) return 'No composition values are available to export.';
          setBreakdownBy(attribute);
          setBreakdownDirection(useDirection);
          setHeatmapPalette(usePalette);
          await downloadClusterHeatmapPng({
              heatmap: buildClusterHeatmap(crosstab, useDirection),
              attribute,
              palette: usePalette,
          });
          return `Saved a ${usePalette} cluster-composition heatmap by ${attribute} (% of ${useDirection}); its 0–100% colour scale is included in the PNG.`;
      },

      saveRotatingGif: async () => {
          const error = await exportGIF();
          return error ?? `Saved a rotating GIF of the current 3D view (${colorBy} color${shapeBy ? `, ${shapeBy} marker shape` : ''}).`;
      },

      saveActiveViewPng: async () => {
          const error = await exportPNG();
          return error ?? `Saved a 2× PNG of the current ${viewMode} view.`;
      },

      saveInteractiveHtml: async () => {
          const error = await exportHTML();
          return error ?? `Saved an offline interactive HTML version of the current ${viewMode} view.`;
      },

      saveActiveDatasetCsv: () => {
          const error = exportDatasetCsv();
          return error ?? 'Saved the active dataset as CSV, including any PCA scores and Cluster labels.';
      },

      pinView: () => {
          if (pinnedViews.length >= 3) return 'Pin limit reached (3). Ask the user to remove a pin first.';
          pinCurrentView();
          return `Pinned the current view. ${pinnedViews.length + 1}/3 pins used.`;
      },

      loadDemoData: async () => {
          const existing = datasets.find(d => d.name === 'iris');
          if (existing) {
              if (existing.id !== activeId) selectDataset(existing.id);
              freshTableRef.current = existing.table;
              return `The demo dataset is already loaded (${existing.table.nRows} rows) and is now the active dataset — no need to load it again.`;
          }
          const table = await loadDemo();
          if (!table) return 'Demo data failed to load.';
          freshTableRef.current = table;
          return `Iris demo loaded: ${table.nRows} flowers, columns: ${table.columns.join(', ')}. It is now active in 3D: petal length × petal width × sepal length, colored by species. Marker shape is available for the tour to demonstrate.`;
      },

      runPCA: (opts) => {
          const t = latestTable();
          if (!t) return 'No dataset loaded.';
          const numeric = numericColumns(t).filter(c => !isPCColumn(c) && c !== 'Cluster');
          const vars = (opts.variables?.length ? opts.variables : numeric.filter(c => !isIdentifierColumn(c)));
          const bad = vars.filter(v => !numeric.includes(v));
          if (bad.length) return `Not usable numeric variables: ${bad.join(', ')}. Available: ${numeric.join(', ')}.`;
          const label = sanitizeLabel(opts.label ?? '');
          if (opts.label && !label) return `"${opts.label}" is not usable as a run label — use letters, digits, _ or -.`;
          const missing: MissingStrategy =
              opts.missing === 'complete' ? 'complete' : opts.missing === 'iterative' ? 'iterative' : 'median';
          const k = Math.min(Math.max(opts.n_components ?? 3, 1), 10);
          const standardizePCA = opts.standardize ?? true;
          setExternalPcaRun(prev => ({ vars, k, standardize: standardizePCA, missing, label, seq: (prev?.seq ?? 0) + 1 }));
          return handleRunPCA(vars, k, standardizePCA, label, missing);
      },

      correlate: (colA, colB) => {
          const t = latestTable();
          if (!t) return 'No dataset loaded.';
          const bad = [colA, colB].filter(c => !c || !numericColumns(t).includes(c));
          if (bad.length) return `Not numeric columns: ${bad.join(', ')}. Numeric: ${numericColumns(t).join(', ')}.`;
          const { n, pearson, spearman } = correlation(t.data[colA], t.data[colB]);
          if (pearson == null) return `Not enough complete pairs (n=${n}) to correlate ${colA} and ${colB}.`;
          return `${colA} × ${colB}: Pearson r=${pearson.toFixed(3)}, Spearman rho=${spearman?.toFixed(3) ?? 'n/a'}, n=${n} (pairwise complete).`;
      },

      // Both go through the ONE analysis gate (validator → executor → pane →
      // provenance) shared with the Analyze panel.
      runTest: (plan) => runAnalysisPlan(plan),
      plotChart: (plan) => runAnalysisPlan(plan),

      compareGroups: (numericCol, groupCol) => {
          const t = latestTable();
          if (!t) return 'No dataset loaded.';
          if (!numericColumns(t).includes(numericCol)) return `"${numericCol}" is not a numeric column. Numeric: ${numericColumns(t).join(', ')}.`;
          if (!t.columns.includes(groupCol)) return `"${groupCol}" is not a column.`;
          const res = statsCompareGroups(t.data[numericCol], t.data[groupCol]);
          if (!res.groups.length) return 'No complete observations to compare.';

          // A grouping with (nearly) one row per group is an identifier, not a
          // grouping: eta-squared is 1.000 by construction and means nothing.
          // Refusing beats reporting a number that reads as a perfect result.
          if (res.nGroups >= res.overall.n) {
              return `"${groupCol}" has ${res.nGroups} distinct values across ${res.overall.n} observations — one per row. That is an identifier rather than a grouping, and eta-squared would be exactly 1.000 by construction. Pick a column with repeated values (a condition, demographic, or cluster).`;
          }
          if (res.nGroups > res.overall.n / 2) {
              return `"${groupCol}" has ${res.nGroups} distinct values across only ${res.overall.n} observations (smallest group n=${res.minGroupN}). Group means are not estimable at that granularity and eta-squared would be inflated to near 1 by construction. Pick a coarser grouping.`;
          }

          const lines = res.groups.map(g => `${g.group}: mean=${g.mean.toFixed(2)}, sd=${g.sd == null ? 'n/a' : g.sd.toFixed(2)}, n=${g.n}`);
          // Caveats the number cannot carry on its own.
          const caveats: string[] = [];
          if (res.singletonGroups) {
              caveats.push(`${res.singletonGroups} group${res.singletonGroups === 1 ? ' has' : 's have'} a single observation, so no standard deviation exists for ${res.singletonGroups === 1 ? 'it' : 'them'}`);
          }
          if (res.minGroupN < 30) {
              caveats.push(`the smallest group has n=${res.minGroupN}, so its mean is unstable`);
          }
          if (res.etaSquared != null && res.omegaSquared != null && res.etaSquared - res.omegaSquared > 0.05) {
              caveats.push(`eta-squared is inflated here by the number of groups — omega-squared is the corrected figure`);
          }
          return `${numericCol} by ${groupCol} (overall mean=${res.overall.mean.toFixed(2)}, sd=${res.overall.sd == null ? 'n/a' : res.overall.sd.toFixed(2)} [sample, n-1], n=${res.overall.n}, ${res.nGroups} groups):\n${lines.join('\n')}\neta-squared=${res.etaSquared?.toFixed(3) ?? 'n/a'}, omega-squared=${res.omegaSquared?.toFixed(3) ?? 'n/a'} (share of variance explained by group; descriptive effect sizes, not significance tests).${caveats.length ? ` Note: ${caveats.join('; ')}.` : ''}`;
      },

      suggestK: (maxK, standardizeArg) => {
          const t = latestTable();
          if (!t || !activeDataset) return 'No dataset loaded.';
          const ax = effectiveAxes(activeDataset, viewMode);
          // Diagnostics must see the same units the clustering will use, or the
          // suggestion answers a different question than the run. run_clustering
          // accepts an explicit standardize override while these two only read
          // the UI toggle, so suggest_k → run_clustering(standardize: true) gave
          // a recommendation computed on raw scales for a run on z-scores —
          // exactly the mismatch this comment claims to prevent (D2).
          const useStd = standardizeArg ?? standardize;
          const rawCols = [t.data[ax.x], t.data[ax.y], ...(ax.z ? [t.data[ax.z]] : [])];
          const cols = useStd ? zscoreCellColumns(rawCols) : rawCols;
          const rows = silhouetteByK(cols, kmeans, maxK);
          if (!rows.length) return 'Too few complete rows on the current axes to evaluate.';
          const best = rows.reduce((a, b) => (b.silhouette > a.silhouette ? b : a));
          return `Mean silhouette by k on (${[ax.x, ax.y, ax.z].filter(Boolean).join(', ')})${useStd ? ', z-scored' : ', raw scales'} — pass standardize=${useStd} to run_clustering to match:\n${rows.map(r => `k=${r.k}: ${r.silhouette.toFixed(3)}${r.k === best.k ? '  ← best' : ''}`).join('\n')}\n(Computed on up to 1200 sampled rows. Higher = better separated; values under ~0.25 suggest weak structure.)`;
      },

      suggestEps: (minSamplesArg, standardizeArg) => {
          const t = latestTable();
          if (!t || !activeDataset) return 'No dataset loaded.';
          const ms = minSamplesArg ?? minSamples;
          const useStd = standardizeArg ?? standardize;   // see suggestK (D2)
          const ax = effectiveAxes(activeDataset, viewMode);
          const rawCols = [t.data[ax.x], t.data[ax.y], ...(ax.z ? [t.data[ax.z]] : [])];
          const cols = useStd ? zscoreCellColumns(rawCols) : rawCols;
          if (ms < 2) return 'min_samples must be at least 2 for an eps suggestion — at min_samples=1 every point is its own core point, so eps stops affecting the result.';
          const res = kDistancePercentiles(cols, ms);
          if (!res) return 'Too few complete rows on the current axes.';
          const p = res.percentiles;
          return `k-distance percentiles for min_samples=${ms} on (${[ax.x, ax.y, ax.z].filter(Boolean).join(', ')})${useStd ? ' after z-scoring (eps will be in SD units)' : ' on raw scales'}: p50=${p.p50.toFixed(3)}, p75=${p.p75.toFixed(3)}, p90=${p.p90.toFixed(3)}, p95=${p.p95.toFixed(3)}, max=${p.max.toFixed(3)}. These are distances to each point's ${res.kthNeighbor}-nearest neighbour — min_samples counts the point itself, so that is the eps at which a point becomes a core point. A good eps usually sits near the knee (~p90–p95); smaller eps → more points labeled Noise. Computed on ${res.n} rows${res.n >= 2000 ? ' (a seeded random sample, capped at 2000)' : ''}. Pass standardize=${useStd} to run_clustering so the run uses these units.`;
      },

      switchDataset: (name) => {
          const ds = datasets.find(d => d.name === name) ?? datasets.find(d => d.name.toLowerCase() === String(name).toLowerCase());
          if (!ds) return `No dataset named "${name}". Loaded: ${datasets.map(d => d.name).join(', ') || 'none'}.`;
          if (ds.id === activeId) return `"${ds.name}" is already active.`;
          selectDataset(ds.id);
          freshTableRef.current = ds.table;
          return `Switched active dataset to "${ds.name}" (${ds.table.nRows} rows).`;
      },

      setCategoryVisibility: (categories, state) => {
          const t = latestTable();
          if (!t) return 'No dataset loaded.';
          const vals = new Set((t.data[colorBy] ?? []).map(v => String(v ?? 'N/A')));
          const unknown = categories.filter(c => !vals.has(String(c)));
          if (unknown.length) return `Not categories of "${colorBy}": ${unknown.join(', ')}. Available: ${Array.from(vals).slice(0, 20).join(', ')}.`;
          setMutedMap(prev => {
              const next = { ...prev };
              for (const c of categories) {
                  if (state === 'normal') delete next[String(c)];
                  else next[String(c)] = state;
              }
              return next;
          });
          return `${state === 'normal' ? 'Restored' : state === 'muted' ? 'Muted' : 'Hid'} ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} of ${colorBy}.`;
      },

      transferColumn: ({ source_dataset, column, mode = 'order', key_column, new_name }) => {
          const tgt = activeDataset;
          if (!tgt) return 'No dataset loaded.';
          const src = datasets.find(d => d.name === source_dataset) ?? datasets.find(d => d.name.toLowerCase() === String(source_dataset).toLowerCase());
          if (!src) return `No dataset named "${source_dataset}". Loaded: ${datasets.map(d => d.name).join(', ')}.`;
          if (src.id === tgt.id) return 'Source and target are the same dataset.';
          if (!src.table.columns.includes(column)) return `"${column}" is not a column of ${src.name}. Its columns: ${src.table.columns.join(', ')}.`;
          if (mode === 'order' && src.table.nRows !== tgt.table.nRows) {
              return `Row counts differ (${src.table.nRows} vs ${tgt.table.nRows}) — order alignment would mis-join. Use mode=match with a shared key column. Shared columns: ${src.table.columns.filter(c => tgt.table.columns.includes(c)).join(', ') || 'none'}.`;
          }
          if (mode === 'match' && (!key_column || !src.table.columns.includes(key_column) || !tgt.table.columns.includes(key_column))) {
              return `mode=match needs a key_column present in both datasets. Shared columns: ${src.table.columns.filter(c => tgt.table.columns.includes(c)).join(', ') || 'none'}.`;
          }
          // The same alignment probe the manual panel runs (D3). Matching row
          // counts prove nothing about whether row 7 is the same respondent in
          // both files, and this is the one tool that turns a bad join into
          // plausible-looking results rather than an obvious error.
          const probe = mode === 'order' ? alignmentProbe(src.table, tgt.table) : null;
          if (probe && probe.agree < probe.total) {
              const pct = Math.round((probe.agree / probe.total) * 100);
              if (pct < 90) {
                  return `Refused: order-mode alignment looks wrong. "${probe.col}" is present in both datasets and only ${probe.agree}/${probe.total} rows (${pct}%) agree, so row order does not line up and the transfer would attach values to the wrong respondents. Use mode=match with a shared key column instead.`;
              }
          }

          const name = (new_name?.trim() || `${column}·${src.name}`);
          const nt = handleTransfer({ sourceId: src.id, sourceCol: column, mode, keyCol: key_column ?? '', name });
          if (nt) freshTableRef.current = nt;
          // The real count, not the row count: order mode fills every row only
          // when the source is at least as long, and match mode fills only the
          // keys that were found.
          let filled = Math.min(src.table.nRows, tgt.table.nRows);
          if (mode === 'match' && key_column) {
              const keys = new Set(src.table.data[key_column].map(String));
              filled = tgt.table.data[key_column].filter(v => keys.has(String(v))).length;
          }
          const caveat = probe
              ? ` Alignment check on "${probe.col}": ${probe.agree}/${probe.total} rows agree${probe.agree === probe.total ? '' : ' — verify before interpreting'}.`
              : mode === 'order' ? ' No shared column was available to verify row alignment, so order was assumed.' : '';
          return `Transferred "${column}" from ${src.name} into the active dataset as "${name}" (${mode} mode, ${filled}/${tgt.table.nRows} rows filled).${caveat} Points are now colored by it.`;
      },

      removePin: (index) => {
          if (!pinnedViews.length) return 'There are no pinned views.';
          const i = Math.floor(index) - 1;
          if (i < 0 || i >= pinnedViews.length) return `Pin index out of range — there ${pinnedViews.length === 1 ? 'is 1 pin' : `are ${pinnedViews.length} pins`} (1-based). Pins: ${pinnedViews.map((v: any, j: number) => `${j + 1}: ${v.label}`).join('; ')}.`;
          const removed = pinnedViews[i];
          setPinnedViews(pinnedViews.filter((_: any, j: number) => j !== i));
          return `Removed pin ${index} (“${removed.label}”).`;
      },

      saveWorkspaceAs: async (name) => {
          const trimmed = String(name ?? '').trim();
          if (!trimmed) return 'Workspace name required.';
          if (datasets.length === 0) return 'Nothing to save — no dataset loaded.';
          try {
              await wsStore.saveWorkspace(trimmed, buildWorkspacePayload());
              await refreshWorkspaces();
              setWorkspaceName(trimmed);
              return `Workspace "${trimmed}" saved locally (IndexedDB). Note: this persists outside the view state and is not covered by undo.`;
          } catch (err: any) {
              return `Save failed: ${err?.message ?? err}`;
          }
      },

      controlView: ({ rotation, zoom, pan, pan_amount, reset_camera }) => {
          if (viewMode === '2D') {
              if (rotation) return 'Auto-rotation is 3D-only — the plot is currently 2D. Switch to 3D with set_plot first if you want to rotate.';
              if (reset_camera) {
                  setRange2d(null);
                  return zoom != null || pan
                      ? 'Done: 2D view reset to fit all points. The zoom/pan in the same call was skipped — call control_view again to re-frame from the full extent.'
                      : 'Done: 2D view reset to fit all points.';
              }
              if (zoom == null && !pan) return 'Nothing requested — in 2D pass zoom, pan, or reset_camera.';
              if (zoom != null && !(zoom > 0)) return 'zoom must be a positive number (e.g. 1.5 to zoom in, 0.7 to zoom out).';
              const cur = get2dRange();
              if (!cur) return 'Could not read the current axis ranges — the plot may not have finished rendering. Try again.';
              let [x0, x1] = cur.x;
              let [y0, y1] = cur.y;
              const acts2d: string[] = [];
              if (zoom != null) {
                  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
                  const hx = (x1 - x0) / 2 / zoom, hy = (y1 - y0) / 2 / zoom;
                  [x0, x1, y0, y1] = [cx - hx, cx + hx, cy - hy, cy + hy];
                  acts2d.push(`zoomed ${zoom > 1 ? 'in' : 'out'} (×${zoom})`);
              }
              if (pan) {
                  // Fraction of the visible span per step — clamped so one call
                  // can't fling the viewport somewhere with no points in it
                  const amt = Math.min(Math.max(pan_amount ?? 0.5, 0.05), 2);
                  const dx = (x1 - x0) * amt, dy = (y1 - y0) * amt;
                  if (pan === 'left') { x0 -= dx; x1 -= dx; }
                  else if (pan === 'right') { x0 += dx; x1 += dx; }
                  else if (pan === 'down') { y0 -= dy; y1 -= dy; }
                  else if (pan === 'up') { y0 += dy; y1 += dy; }
                  else return `Unknown pan direction "${pan}". Use left, right, up, or down.`;
                  acts2d.push(`panned ${pan} by ${Math.round(amt * 100)}% of the view`);
              }
              setRange2d({ x: [x0, x1], y: [y0, y1] });
              return `Done: ${acts2d.join('; ')}. Visible window is now x ${fmtRange(x0, x1)}, y ${fmtRange(y0, y1)}.`;
          }
          if (pan) return 'Directional pan is 2D-only — the plot is currently 3D, where framing is the camera angle. Use rotation/zoom/reset_camera, or switch to 2D with set_plot.';
          const acts: string[] = [];
          if (reset_camera) {
              setIsRotating(false);
              setCamera(DEFAULT_CAMERA);
              acts.push('camera reset');
          }
          if (zoom != null) {
              if (!(zoom > 0)) return 'zoom must be a positive number (e.g. 1.5 to zoom in, 0.7 to zoom out).';
              setIsRotating(false);
              const eye = camera.eye;
              const dist = Math.sqrt(eye.x ** 2 + eye.y ** 2 + eye.z ** 2) || 2.2;
              const target = Math.min(Math.max(dist / zoom, 0.4), 12);
              const f = target / dist;
              setCamera({ eye: { x: eye.x * f, y: eye.y * f, z: eye.z * f } });
              acts.push(`zoomed ${zoom > 1 ? 'in' : 'out'} (×${zoom})`);
          }
          if (rotation) {
              setIsRotating(rotation === 'start');
              acts.push(`auto-rotation ${rotation === 'start' ? 'started' : 'stopped'}`);
          }
          return acts.length ? `Done: ${acts.join('; ')}.` : 'Nothing requested — in 3D pass rotation, zoom, or reset_camera.';
      },

      highlightUI: (target) => {
          if (!(GUIDE_TARGETS as readonly string[]).includes(target)) {
              return `Unknown target "${target}". Valid targets: ${GUIDE_TARGETS.join(', ')}.`;
          }
          const ok = flashGuide(target, theme === 'terminal' ? '#10ff50' : '#EB1A26');
          if (!ok) return `"${target}" is not on screen right now${datasets.length === 0 ? ' — sections after Data appear once a dataset is loaded' : ''}.`;
          return `Highlighted ${target} with an ephemeral arrow (~5s). Continue explaining while the user looks.`;
      },

      setAssistantDock: (mode) => {
          if (mode !== 'right' && mode !== 'bottom' && mode !== 'float') return `Unknown dock "${mode}". Use right, bottom, or float.`;
          changeDock(mode);
          return `Moved the assistant panel to the ${mode === 'float' ? 'floating overlay' : `${mode} dock`}.`;
      },

      holdHighlight: (target, opts) => {
          if (!(GUIDE_TARGETS as readonly string[]).includes(target)) return null;
          return flashGuide(target, theme === 'terminal' ? '#10ff50' : '#EB1A26', true, opts?.arrow !== false);
      },

      // --- Open-mode row access ---------------------------------------------
      // Second fence after the tool registry (toolsFor): each method re-checks
      // the SESSION policy — the stricter of the two — so a stale tool call
      // arriving after a mode flip, or against a freshly-loaded private
      // dataset, is refused rather than answered.
      sampleRows: (opts) => {
          if (!sessionPolicy.rowAccess) return 'Row access is not available: the session is in Private data mode.';
          const t = latestTable();
          if (!t) return 'No dataset loaded.';
          return sampleRowsCore(t, opts);
      },

      getRowsWhere: (opts) => {
          if (!sessionPolicy.rowAccess) return 'Row access is not available: the session is in Private data mode.';
          const t = latestTable();
          if (!t) return 'No dataset loaded.';
          return rowsWhereCore(t, opts);
      },

      listCategories: (column) => {
          if (!sessionPolicy.rowAccess) return 'Row access is not available: the session is in Private data mode.';
          const t = latestTable();
          if (!t) return 'No dataset loaded.';
          return listCategoriesCore(t, column);
      },

      snapshot: () => ({
          datasets, activeId, colorBy, shapeBy, viewMode, showAxes, aspect, pinnedViews, analysisViews,
          clusterMethod, eps, minSamples, k, standardize, breakdownBy, breakdownDirection, heatmapPalette, mutedMap,
      }),

      restore: (snap: any) => {
          if (!snap) return;
          skipMuteReset.current = true;
          setDatasets(snap.datasets);
          setActiveId(snap.activeId);
          setColorBy(snap.colorBy);
          setShapeBy(snap.shapeBy ?? "");
          setViewMode(snap.viewMode);
          setShowAxes(snap.showAxes);
          if (snap.aspect) setAspect(snap.aspect);
          setPinnedViews(snap.pinnedViews);
          setAnalysisViews(snap.analysisViews ?? []);
          setClusterMethod(snap.clusterMethod);
          setEps(snap.eps);
          setMinSamples(snap.minSamples);
          setK(snap.k);
          skipStdReset.current = true;
          setStandardize(snap.standardize ?? false);
          setBreakdownBy(snap.breakdownBy);
          setBreakdownDirection(snap.breakdownDirection === 'group' ? 'group' : 'cluster');
          setHeatmapPalette(HEATMAP_PALETTES.includes(snap.heatmapPalette) ? snap.heatmapPalette : 'Viridis');
          setMutedMap(snap.mutedMap);
          freshTableRef.current = null;
      },
  };
  // Console/testing access to the assistant bridge (local state only).
  //
  // In an effect, not during render: assigning to `window` while rendering is a
  // side effect, which React 19 strict mode double-invokes (finding F6). The
  // `bridgeRef.current` write above deliberately stays where it is — the bridge
  // closes over about forty pieces of state, and a dependency list that missed
  // one would hand the assistant a stale view of the app, which is a worse bug
  // than the allocation. The allocation cost itself is a symptom of rendering
  // sixty times a second, which F9 removes at the source.
  useEffect(() => {
      (window as unknown as { __scatterlabBridge?: unknown }).__scatterlabBridge = bridgeRef;
  }, []);

  // Stable across renders, so memoizing ViewPlot is not defeated by a fresh
  // closure on every prop pass (F13). Reads live values from refs where it must,
  // rather than closing over state that would force it to be rebuilt.
  // Mirror a pane's own zoom/pan/rotate back into the state that pane renders
  // from. Without it the next re-render re-applies the stored layout and snaps
  // the plot back to where it was.
  //
  // This used to write everything into the LIVE camera and range2d regardless of
  // which pane fired, while pinned panes rendered from `view.camera` /
  // `view.range2d`. So dragging a pin rotated the live plot and left the pin
  // exactly where it was — the reason pins read as frozen pictures. Each pane
  // now updates its own framing.
  const handleRelayout = useCallback((e: any, viewId: string | number) => {
      const intent = readRelayout(e);
      if (!intent) return;
      const isPin = viewId !== 'active';
      const updatePin = (patch: Record<string, unknown>) =>
          setPinnedViews(prev => prev.map(v => (v.id === viewId ? { ...v, ...patch } : v)));

      if (intent.kind === 'camera') {
          if (isPin) { updatePin({ camera: intent.camera }); return; }
          if (!getActivePlotDiv()) return;
          // A drag during auto-rotation means the user took the wheel — but only
          // when it is the rotating live view being dragged.
          if (isRotatingRef.current) setIsRotating(false);
          setCamera(intent.camera as SceneCamera);
          return;
      }
      if (isPin) updatePin({ range2d: intent.range }); else setRange2d(intent.range);
  }, []);

  const renderView = (view: any, index: number) => {
      // view object is the active state, a pinned state, or an analysis output
      if (view.kind === 'analysis') {
          return (
              <div className="w-full h-full relative">
                  <button
                      onClick={() => removeAnalysisView(view.id)}
                      className="absolute top-2 right-2 z-20 bg-[var(--background)] border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--border)] text-xs px-2 py-1 transition-colors"
                      aria-label={`Close ${view.label}`}
                  >
                      <X className="w-4 h-4" />
                  </button>
                  <AnalysisPane view={view} />
              </div>
          );
      }
      const isPinned = view.id !== 'active';
      return (
          <div className="w-full h-full relative">
              {isPinned && (
                  <button
                      onClick={() => removePin(view.id)}
                      className="absolute top-2 right-2 z-20 bg-[var(--background)] border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--border)] text-xs px-2 py-1 transition-colors"
                  >
                      <X className="w-4 h-4" />
                  </button>
              )}
              <ViewPlot
                  view={view}
                  title={view.label ?? (isPinned ? "Pinned View" : "Active View")}
                  colorBy={colorBy}
                  axesOn={view.showAxes ?? false}
                  aspect={view.aspect ?? DEFAULT_ASPECT}
                  window2d={(isPinned ? view.range2d : range2d) ?? null}
                  camera={isPinned ? (view.camera ?? camera) : camera}
                  onRelayout={handleRelayout}
              />
          </div>
      );
  };

  // Memoized so the live pane's props are referentially stable between renders
  // that do not concern it. In 3D `effectiveAxes` returns the dataset's own
  // `axes` object, so the memo held by accident; the 2D branch builds a fresh
  // literal, which meant every unrelated state change — a slider tick, a Notes
  // keystroke, a streaming token — rebuilt every trace and handed Plotly new
  // array references, in the mode where that costs most (F8).
  const activeView = useMemo(
      () => (processedData && activeDataset
          ? {
              id: 'active', data: processedData, colorBy, shapeBy,
              axes: effectiveAxes(activeDataset, viewMode),
              labels: effectiveLabels(activeDataset, viewMode),
              viewMode, showAxes: showAxes[viewMode], aspect, muted: mutedMap,
              label: `${activeDataset.name} · live`,
          }
          : null),
      [processedData, activeDataset, colorBy, shapeBy, viewMode, showAxes, aspect, mutedMap],
  );
  const allViews = useMemo(
      () => (activeView ? [activeView, ...pinnedViews, ...analysisViews] : []),
      [activeView, pinnedViews, analysisViews],
  );

  // Theme-neutral shell until next-themes reports the client's theme.
  //
  // This used to `return null`, so the app rendered nothing on the server AND
  // nothing on the first client render: a blank white page until React
  // hydrated, then another wait for the ssr:false Plotly chunk, which has no
  // loading fallback. The EmptyState that exists to greet a first-time user was
  // invisible until the moment it was no longer needed (finding F2). The gate
  // itself is legitimate — next-themes cannot know the theme server-side — so
  // the fix is a shell that commits to no theme rather than to nothing.
  if (!mounted) {
      return (
          <div className="flex w-full h-screen items-center justify-center bg-[var(--background)] text-[var(--foreground)]">
              <div className="flex flex-col items-center gap-3 opacity-60">
                  <HardDriveUpload className="w-10 h-10" aria-hidden="true" />
                  <span className="text-sm font-bold tracking-tight">Scatter Lab</span>
                  <span className="text-xs">Loading…</span>
              </div>
          </div>
      );
  }

  // We construct the views array for TmuxGrid: active view is always first, then pinned views

  return (
    <div className={`flex w-full h-screen bg-[var(--background)] text-[var(--foreground)] ${theme === 'terminal' ? 'moving-scanlines' : ''}`}>
      
      {/* Sidebar Controls */}
      <aside className="w-[320px] h-full bg-[var(--card)] border-r border-[var(--border)] flex flex-col p-6 overflow-y-auto relative z-10 flex-shrink-0">
        <div className="flex justify-between items-center mb-2">
            <h1 className={`flex items-center gap-2 text-xl font-bold tracking-tight ${theme === 'terminal' ? 'text-[var(--system-green)] system-green-glow' : ''}`}>
                {theme === 'primary' && (
                    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true" className="flex-shrink-0">
                        <rect x="3" y="14" width="13" height="13" fill="var(--p-blue)" stroke="#111111" strokeWidth="2" />
                        <circle cx="21" cy="11" r="7.5" fill="var(--p-red)" stroke="#111111" strokeWidth="2" />
                        <path d="M 16 28 L 22.5 17 L 29 28 Z" fill="var(--p-yellow)" stroke="#111111" strokeWidth="2" />
                    </svg>
                )}
                {APP_NAME}
            </h1>
            <button
                data-guide="about"
                onClick={() => setShowInfo(true)}
                title="About Scatter Lab — what it does to your data, and the methods behind it"
                aria-label="About Scatter Lab"
                className={`p-2 border ${theme === 'primary' ? 'bauhaus-btn bg-white text-[var(--border)]' : 'border-[var(--border)] hover:bg-[var(--border)] text-[var(--system-green)] rounded'}`}
            >
                <Info className="w-4 h-4" />
            </button>
            <button
                onClick={() => setTheme(theme === 'dark' || theme === 'terminal' ? 'primary' : 'terminal')}
                title={theme === 'terminal' ? 'Switch to Bauhaus theme' : 'Switch to Terminal theme'}
                className={`p-2 border ${theme === 'primary' ? 'bauhaus-btn bg-[var(--p-blue)] text-white' : 'border-[var(--border)] hover:bg-[var(--border)] text-[var(--system-green)] rounded'}`}
            >
                <Monitor className="w-4 h-4" />
            </button>
        </div>

        {/* The privacy story lives in the info dialog and the per-dataset
            lock/globe badges now — the always-on headline banner here was
            retired as sidebar noise (owner's call). */}
        <div className="mb-4" />

        <SidebarGroup theme={theme}>

          {/* Workspace persistence */}
          <SidebarSection title="Workspace" theme={theme} guide="workspace">
            <div className="flex gap-2">
              <input
                type="text"
                value={workspaceName}
                onChange={e => setWorkspaceName(e.target.value)}
                placeholder="Workspace name"
                className="flex-1 min-w-0 bg-[var(--input)] border border-[var(--border)] p-1.5 text-xs outline-none"
              />
              <button
                onClick={saveWorkspace}
                disabled={!workspaceName.trim() || !!workspaceBusy || datasets.length === 0}
                className={`px-3 text-xs font-bold disabled:opacity-40 ${theme === 'primary' ? 'bauhaus-btn bg-[var(--p-blue)] text-white' : 'bg-[var(--input)] border border-[var(--system-green)]/55 hover:bg-[var(--system-green)]/10 text-[var(--system-green)] cursor-pointer'}`}
              >
                Save
              </button>
            </div>
            {workspaces.length > 0 && (
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {workspaces.map(w => (
                  <div key={w.name} className="flex items-center justify-between gap-2 px-2 py-1 border border-[var(--border)] bg-[var(--input)] text-xs">
                    <button onClick={() => loadWorkspace(w.name)} className="flex-1 min-w-0 text-left hover:opacity-70" title={`Load "${w.name}" (saved ${w.saved_at.replace('T', ' ')})`}>
                      <span className="font-bold truncate block">{w.name}</span>
                      <span className="opacity-50 text-[10px]">{w.saved_at.replace('T', ' ')}</span>
                    </button>
                    <button onClick={() => deleteWorkspace(w.name)} className="flex-shrink-0 hover:opacity-50" title="Delete workspace">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* Import is ALWAYS available. It used to share the export row's
                condition, so someone opening the app fresh with a workspace a
                colleague sent them had no control to open it — the one moment
                importing is most likely (C15). Export stays gated: there is
                nothing to write until a dataset is loaded. */}
            <div className="flex gap-2 text-[11px]">
              {datasets.length > 0 && (
                <button onClick={exportWorkspace} className="underline-offset-2 hover:underline opacity-60 hover:opacity-100 cursor-pointer">
                  Export as file
                </button>
              )}
              <label className="underline-offset-2 hover:underline opacity-60 hover:opacity-100 cursor-pointer">
                Import file
                <input
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) importWorkspace(f); e.target.value = ""; }}
                />
              </label>
            </div>
            {workspaceBusy && <p className="text-[11px] opacity-70">{workspaceBusy}</p>}
          </SidebarSection>

          {/* Section 1: Ingestion */}
          <SidebarSection title="Data" step={1} theme={theme} guide="data" order={1}>
            {!processedData && (
              <div className={`flex justify-center mb-2 ${theme === 'terminal' ? 'text-[var(--system-green)] opacity-70' : 'opacity-40'}`}>
                <HardDriveUpload className="w-10 h-10" />
              </div>
            )}
            {/* Choosing a file (drop OR click-to-browse) opens the add-dataset
                config modal, where sheet, components file, data mode, and
                missing-value handling all live together. */}
            <div
              data-guide="upload-dropzone"
              onClick={() => { if (!walkthroughActive) dsInputRef.current?.click(); }}
              onDragOver={e => { e.preventDefault(); if (!walkthroughActive) setDragOver('ds'); }}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => {
                e.preventDefault();
                setDragOver(null);
                if (walkthroughActive) return;
                const f = e.dataTransfer.files?.[0];
                if (f) { setDatasetFile(f); setShowAddConfig(true); }
              }}
              aria-disabled={walkthroughActive || undefined}
              title={walkthroughActive ? 'Paused while the walkthrough is running' : undefined}
              className={`border-2 border-dashed p-3 flex flex-col items-center transition-colors ${walkthroughActive ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${theme === 'primary' ? 'border-[3px] bg-white' : theme === 'terminal' ? 'border-[var(--system-green)]/45 text-[var(--system-green)]' : ''} ${walkthroughActive ? 'border-[var(--border)]' : dragOver === 'ds'
                ? (theme === 'primary' ? 'border-[var(--p-blue)] bg-blue-50' : 'border-[var(--system-green)] bg-[var(--system-green)]/10')
                : `border-[var(--border)] hover:bg-[var(--foreground)]/5 ${theme === 'terminal' ? 'hover:border-[var(--system-green)] hover:bg-[var(--system-green)]/10' : ''}`}`}
            >
              <input type="file" className="hidden" accept=".csv,.xlsx,.parquet" ref={dsInputRef} disabled={walkthroughActive} onChange={(e) => { if (e.target.files?.[0]) { setDatasetFile(e.target.files[0]); setShowAddConfig(true); } }} />
              {walkthroughActive
                ? <span className="text-xs font-medium opacity-70 text-center">Uploads are paused during the walkthrough</span>
                : <span className="text-xs font-medium opacity-50 text-center">Drop dataset here or click to browse</span>}
            </div>
            {walkthroughActive && (
              <button
                onClick={() => exitWalkthroughRef.current?.()}
                className={`scatterlab-action-button w-full text-xs font-bold py-1.5 border cursor-pointer ${theme === 'primary'
                  ? 'border-[var(--border)] bg-[var(--input)] hover:bg-[var(--p-yellow)]'
                  : 'border-[var(--system-green)]/40 bg-[var(--input)] text-[var(--system-green)]/80 hover:bg-[var(--system-green)]/10'}`}
              >
                Quit the walkthrough
              </button>
            )}
            {(datasetFile || componentsFile || processedData) && (
              <button onClick={handleClearData} className={`scatterlab-action-button w-full flex items-center justify-center gap-2 text-sm font-bold py-2 ${theme === 'primary' ? 'bauhaus-btn bg-white text-[var(--p-red)]' : 'bg-[var(--input)] border border-[var(--border)] hover:bg-[var(--border)] text-red-400'}`}>
                <Trash2 className="w-4 h-4" /> Clear All Data
              </button>
            )}
            {uploadStatus && (
              // whitespace-pre-line: parser warnings are newline-separated
              <p className="text-[11px] leading-snug opacity-70 break-words whitespace-pre-line">{uploadStatus}</p>
            )}
            {/^Error|failed|⚠/i.test(uploadStatus) && (
              <button
                onClick={() => askAssistantRef.current?.(/^Error|failed/i.test(uploadStatus)
                  ? `My upload failed with this message: "${uploadStatus}". Explain what's wrong with my file and how to fix it.`
                  : `My upload produced these warnings: "${uploadStatus}". Explain what they mean for my data and how to fix the file.`)}
                className="text-[11px] underline-offset-2 hover:underline opacity-60 hover:opacity-100 text-left cursor-pointer"
              >
                ✳ Ask the assistant about {/^Error|failed/i.test(uploadStatus) ? 'this error' : 'these warnings'}
              </button>
            )}
            {datasets.length > 0 && (
              <div className="space-y-1.5 pt-1" data-guide="datasets-list">
                {datasets.map(d => (
                  <div key={d.id} onClick={() => selectDataset(d.id)}
                    className={`flex items-center justify-between gap-2 px-2 py-1.5 cursor-pointer border text-xs ${d.id === activeId
                      ? (theme === 'primary' ? 'border-[3px] border-[var(--border)] bg-[var(--p-yellow)] font-bold' : 'border-[var(--primary)] text-[var(--primary)] bg-[var(--border)]')
                      : 'border-[var(--border)] bg-[var(--input)] opacity-70 hover:opacity-100'}`}>
                    <span className="truncate" title={d.name}>{d.name}</span>
                    <span className="flex items-center gap-1.5 flex-shrink-0">
                      <span className="opacity-60">{d.table.nRows} rows</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); setAccessInfo(d.id); }}
                        className="hover:opacity-60"
                        title={d.dataMode === 'open'
                          ? 'Public/open data — the assistant may read raw rows. Set when the dataset was added; click for details.'
                          : 'Private research data — the assistant sees aggregates only. Set when the dataset was added; click for details.'}
                      >
                        {d.dataMode === 'open' ? <Globe className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); setDatasetSettings(d.id); }} className="hover:opacity-60" title="Dataset settings — missing-value codes, delete">
                        <Settings2 className="w-3 h-3" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(d.id); }} className="hover:opacity-50" title="Remove dataset (asks first)">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {activeDataset && (
              <button
                onClick={() => setShowTableView(true)}
                data-guide="table-view"
                className="w-full text-left text-[11px] underline-offset-2 hover:underline opacity-70 hover:opacity-100 cursor-pointer"
              >
                ⊞ View dataset table ({activeDataset.table.nRows} rows)
              </button>
            )}
            {(activeDataset?.provenance?.length ?? 0) > 0 && (
              // The audit trail: everything that changed this dataset's in-app
              // copy, in order. Saved with workspaces and the autosaved session.
              <details className="text-[11px]" data-guide="data-history">
                <summary className="cursor-pointer font-bold uppercase tracking-wider opacity-60 text-[10px]">
                  Data history — {activeDataset!.provenance!.length} step{activeDataset!.provenance!.length === 1 ? '' : 's'}
                </summary>
                <ol className="pt-1 space-y-1 opacity-80">
                  {activeDataset!.provenance!.map((p, i) => (
                    <li key={i} className="leading-snug">
                      <span className="opacity-50">{new Date(p.at).toLocaleTimeString()} — </span>{p.action}
                    </li>
                  ))}
                </ol>
                <div className="pt-1 opacity-50 leading-snug">
                  Your original file is never modified — these steps apply only to the in-app copy (export it from section 6).
                </div>
                {activeDataset!.provenance!.length > 1 && (
                  // More than the load entry = the copy has been modified;
                  // that is the moment a downloadable record earns its place.
                  <button
                    onClick={downloadProvenance}
                    className="pt-1 underline-offset-2 hover:underline opacity-60 hover:opacity-100 text-left cursor-pointer"
                  >
                    ⤓ Download trace file
                  </button>
                )}
              </details>
            )}
            {datasets.length >= 2 && (
              <ColumnTransfer datasets={datasets} activeId={activeId} onTransfer={handleTransfer} />
            )}
          </SidebarSection>

          {processedData && (
            <>
              <SidebarSection title="Variables" step={2} hasBorder theme={theme} guide="variables" order={2}>
                <div className="text-[11px] opacity-60 -mt-1">
                  {processedData.nRows} rows × {processedData.columns.length} columns — click X · Y · Z to plot, C to color, S to shape
                </div>
                {activeDataset?.summary?.top_contributors && (
                  <details className="text-xs">
                    <summary className="cursor-pointer font-bold uppercase tracking-wider opacity-60 text-[10px]">
                      Top PC contributors
                    </summary>
                    <div className="text-[10px] opacity-60 pt-1">
                      Unit-norm eigenvector weights (scikit-learn <code>components_</code>).
                      <InfoTip topic="pca_loadings" />
                    </div>
                    <div className="pt-1 space-y-1">
                      {Object.entries(activeDataset.summary.top_contributors).map(([pc, vars]: [string, any]) => (
                        <div key={pc} className="leading-snug">
                          <span className="font-bold">{pc}:</span>{' '}
                          {vars.slice(0, 4).map((v: any, i: number) => (
                            <span key={v.var}>{i > 0 && ', '}{v.var} <span className="opacity-60">{v.loading > 0 ? '+' : ''}{v.loading}</span></span>
                          ))}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {activeDataset && (
                  <VariablesPanel
                    dataset={activeDataset}
                    viewMode={viewMode}
                    colorBy={colorBy}
                    shapeBy={shapeBy}
                    theme={theme}
                    onAxis={(axis, col) => updateAxis(axis, col)}
                    onColor={setColorBy}
                    onShape={col => setShapeBy(prev => (prev === col ? "" : col))}
                  />
                )}
              </SidebarSection>

              <SidebarSection title="PCA" step={3} hasBorder theme={theme} guide="pca" order={3}>
                {processedData && (
                  <PCASection
                    table={processedData}
                    datasetId={activeId ?? -1}
                    theme={theme}
                    lastRun={pcaInfo}
                    runs={activeDataset?.pcaRuns ?? []}
                    // Yield to paint before the synchronous PCA so the Run
                    // button's pressed frame commits first (same INP pattern
                    // as clustering's 30ms yield and the walkthrough steps).
                    onRun={async (vars, k, std, label, missing) => { await paintYield(); handleRunPCA(vars, k, std, label, missing); }}
                    externalRun={externalPcaRun}
                  />
                )}
              </SidebarSection>

              <SidebarSection title="View" step={5} hasBorder theme={theme} guide="view" order={5}>
                <div className="flex gap-2 mb-2">
                    <button onClick={() => setViewMode("2D")} className={`scatterlab-action-button flex-1 py-1 text-xs font-bold border ${viewMode === "2D" ? (theme==='primary'?'bg-[var(--p-yellow)] border-[var(--p-black)] border-[3px]':'bg-[var(--primary)] border-[var(--primary)] text-white') : 'border-[var(--border)] bg-[var(--input)] opacity-60'}`}>2D</button>
                    <button onClick={() => setViewMode("3D")} className={`scatterlab-action-button flex-1 py-1 text-xs font-bold border ${viewMode === "3D" ? (theme==='primary'?'bg-[var(--p-yellow)] border-[var(--p-black)] border-[3px]':'bg-[var(--primary)] border-[var(--primary)] text-white') : 'border-[var(--border)] bg-[var(--input)] opacity-60'}`}>3D</button>
                </div>

                <button
                    onClick={() => setShowAxes({ ...showAxes, [viewMode]: !showAxes[viewMode] })}
                    className={`scatterlab-action-button w-full py-1 mb-2 text-xs font-bold border ${showAxes[viewMode] ? (theme==='primary'?'bg-[var(--p-yellow)] border-[var(--p-black)] border-[3px]':'bg-[var(--system-green)] border-[var(--system-green)] text-black') : (theme==='primary'?'border-[var(--border)] bg-[var(--input)] opacity-60':'bg-[var(--primary)] border-[var(--primary)] text-white')}`}
                >
                    {showAxes[viewMode] ? "Axes: On" : "Axes: Off"}
                </button>

                {/* Box shape. Cube always fits and orbits evenly but stretches each
                    axis by its own factor, so tick spacing is not comparable across
                    them; True scale keeps a unit the same length on every axis. */}
                {viewMode === "3D" && (
                    <div className="flex gap-1 mb-2">
                        {(['cube', 'data'] as const).map(m => (
                            <button
                                key={m}
                                onClick={() => setAspect(m)}
                                title={m === 'cube'
                                    ? 'Equal-length axes. Always fits and orbits evenly, but each axis is stretched by a different factor, so tick spacing is not comparable between them.'
                                    : 'Axis lengths proportional to their data spans, so one unit is the same length on every axis. Faithful, but a long, thin box can run off the canvas as it rotates.'}
                                className={`scatterlab-action-button flex-1 py-1 text-xs font-bold border ${aspect === m
                                    ? (theme === 'primary' ? 'bg-[var(--p-yellow)] border-[var(--p-black)] border-[3px]' : 'bg-[var(--system-green)] border-[var(--system-green)] text-black')
                                    : (theme === 'primary' ? 'border-[var(--border)] bg-[var(--input)] opacity-60' : 'border-[var(--system-green)]/40 bg-[var(--input)] text-[var(--system-green)]/70')}`}
                            >
                                {m === 'cube' ? 'Cube' : 'True scale'}
                            </button>
                        ))}
                        <InfoTip topic="aspect_mode" />
                    </div>
                )}

                <div className="space-y-1">
                    <label className="text-xs font-medium opacity-70">Axis labels</label>
                    {(viewMode === "2D" ? (['x', 'y'] as const) : (['x', 'y', 'z'] as const)).map((axis: 'x' | 'y' | 'z') => {
                        const is2D = viewMode === "2D";
                        const colValue = is2D
                            ? (axis === 'z' ? '' : activeDataset?.axes2d[axis] ?? '')
                            : (activeDataset?.axes[axis] ?? '');
                        const labelValue = is2D
                            ? (axis === 'z' ? '' : activeDataset?.labels2d[axis] ?? '')
                            : (activeDataset?.labels[axis] ?? '');
                        return (
                            <div key={axis} className="flex items-center gap-1.5">
                                <span className="text-[10px] font-bold w-3 uppercase opacity-60">{axis}</span>
                                <span className="w-24 truncate text-[11px] opacity-60" title={colValue}>{colValue || '—'}</span>
                                <input
                                    type="text"
                                    value={labelValue}
                                    onChange={e => updateLabel(axis, e.target.value)}
                                    className="flex-1 min-w-0 bg-[var(--input)] border border-[var(--border)] p-1.5 text-xs"
                                    placeholder="display label"
                                    disabled={!colValue}
                                />
                            </div>
                        );
                    })}
                </div>

                <button onClick={() => setIsRotating(!isRotating)} disabled={viewMode === '2D'} className={`scatterlab-action-button w-full flex items-center justify-center gap-2 py-2 text-sm font-bold transition-colors disabled:opacity-30 ${isRotating ? (theme==='primary'?'bauhaus-btn bg-[var(--p-red)] text-white':'bg-[var(--primary)] text-white border border-[var(--primary)]') : (theme==='primary'?'bauhaus-btn bg-[var(--p-black)] text-white':'bg-[var(--system-green)] text-black border border-[var(--system-green)]')}`}>
                    {isRotating ? <><Square className="w-4 h-4" /> Stop Rotation</> : <><Play className="w-4 h-4" /> Start Rotation</>}
                </button>
                <Separator dashed className="scatterlab-view-divider" />
                {/* The pane is built off the critical path now, so the button
                    says what is happening rather than going quiet mid-work. */}
                <button onClick={pinCurrentView} disabled={isPinning} className={`scatterlab-action-button w-full flex items-center justify-center gap-2 py-2 text-sm font-bold disabled:opacity-60 ${theme==='primary'?'bauhaus-btn bg-[var(--p-red)] text-white':'bg-[var(--primary)] border border-[var(--primary)] text-white'}`}>
                    <Pin className="w-4 h-4" /> {isPinning ? 'Pinning…' : 'Pin View'}
                </button>
              </SidebarSection>

              <SidebarSection title="Cluster" step={4} hasBorder theme={theme} guide="cluster" order={4}>
                <select className="w-full bg-[var(--input)] border border-[var(--border)] p-2 text-sm outline-none" value={clusterMethod} onChange={(e) => setClusterMethod(e.target.value)}>
                    <option value="NONE">None</option>
                    <option value="DBSCAN">DBSCAN (density-based)</option>
                    {/* "reproducible", not "deterministic": this label is the first
                        and sometimes only place the property is named, and
                        "deterministic" invites the reading that the app searched for
                        the best clustering. It did not — see kmeans_deterministic. */}
                    <option value="KMEANS">K-Means (reproducible)</option>
                </select>

                {/* B3: clustering runs on the plotted axes and nothing else. Naming
                    them live also makes the limitation self-evident the moment
                    someone plots two arbitrary raw columns. */}
                {clusterMethod !== "NONE" && activeDataset && (
                    <div className="text-[11px] leading-snug opacity-70">
                        Clusters on the plotted {viewMode === "2D" ? 'axes' : 'axes'}:{' '}
                        <b>{[axNow?.x, axNow?.y, axNow?.z].filter(Boolean).join(' · ')}</b>
                        <InfoTip topic="clusters_plotted_axes" />
                    </div>
                )}

                {clusterMethod === "DBSCAN" && (
                    <div className="space-y-2 text-sm">
                        <label className="flex justify-between">
                            <span className="opacity-70">
                                EPS <span className="opacity-70">({standardize ? 'SD units' : 'axis units'})</span>:
                                <InfoTip topic="dbscan_parameters" />
                            </span>
                            <span>{eps}</span>
                        </label>
                        {/* The range is scaled to the data, not fixed at 5 (B5).
                            With standardize off, eps is in raw axis units — on
                            income-scale axes the old maximum of 5 labelled 100%
                            of points Noise with no way to go higher from the UI,
                            so only the assistant could reach a usable value. The
                            number box accepts anything the slider cannot. */}
                        <div className="flex items-center gap-2">
                            <input type="range" min={epsSliderStep} max={epsSliderMax} step={epsSliderStep} value={Math.min(eps, epsSliderMax)} onChange={e => setEps(parseFloat(e.target.value))} className="w-full" />
                            <input
                                type="number" min={0} step={epsSliderStep} value={eps}
                                onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v > 0) setEps(v); }}
                                aria-label="eps value"
                                className="w-16 flex-shrink-0 bg-[var(--input)] border border-[var(--border)] px-1 py-0.5 text-[10px] outline-none"
                            />
                        </div>
                        <label className="flex justify-between"><span className="opacity-70">Min Samples:</span> <span>{minSamples}</span></label>
                        <input type="range" min="1" max="50" step="1" value={minSamples} onChange={e => setMinSamples(parseInt(e.target.value))} className="w-full" />
                        {minSamples < 2 && (
                            <p className="text-[10px] leading-snug text-[var(--p-red)]">
                                At min samples = 1 every point is its own core point, so eps stops affecting the result.
                            </p>
                        )}
                    </div>
                )}
                {clusterMethod === "KMEANS" && (
                    <div className="space-y-2 text-sm">
                        <label className="flex justify-between">
                            <span className="opacity-70">K (Clusters):<InfoTip topic="kmeans_deterministic" /></span>
                            <span>{k}</span>
                        </label>
                        <input type="range" min="2" max="20" step="1" value={k} onChange={e => setK(parseInt(e.target.value))} className="w-full" />
                    </div>
                )}
                {clusterMethod !== "NONE" && (
                    <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                        <input type="checkbox" checked={standardize} onChange={e => setStandardize(e.target.checked)} />
                        <span className="opacity-80">Standardize variables (z-score)</span>
                        <InfoTip topic="standardize_clustering" />
                    </label>
                )}
                {clusterMethod !== "NONE" && (
                    <button onClick={handleCluster} disabled={isClustering} className={`w-full text-sm font-bold py-2 disabled:opacity-50 ${theme === 'primary' ? 'bauhaus-btn bg-[var(--p-red)] text-white' : 'bg-[var(--input)] border border-[var(--border)] hover:bg-[var(--border)] text-[var(--abaci)]'}`}>
                        {isClustering ? "Clustering..." : "Run Clustering"}
                    </button>
                )}
                {clusterMethod !== "NONE" && (
                    <p className="text-[10px] leading-snug opacity-60">
                        Missing values are filled with the column median before the distance maths.
                        <InfoTip topic="median_imputation" />
                    </p>
                )}
                {processedData.columns.includes('Cluster') && (
                    <ClusterBreakdown
                        table={processedData}
                        attr={breakdownBy}
                        onAttrChange={setBreakdownBy}
                        direction={breakdownDirection}
                        onDirectionChange={setBreakdownDirection}
                        palette={heatmapPalette}
                        onPaletteChange={setHeatmapPalette}
                    />
                )}
                  </SidebarSection>

              {/* Tabled for now at the owner's request while the rest of the
                  analysis engine is polished — the machinery stays live (the
                  assistant's run_test/plot_chart, runAnalysisPlan, tests);
                  only this assistant-free entry point is off. Flip the flag to
                  bring the section back; order ties with Cluster (4) so the
                  later DOM position places it right after Cluster. */}
              {ANALYZE_PANEL_ENABLED && (
                <SidebarSection title="Analyze" hasBorder theme={theme} guide="analyze" order={4}>
                    <AnalyzePanel profile={analysisProfile} theme={theme} onRun={runAnalysisPlan} />
                </SidebarSection>
              )}

              <SidebarSection title="Export" step={6} hasBorder theme={theme} guide="export" order={6}>
                  <div className="grid grid-cols-3 gap-2">
                    <button onClick={exportPNG} disabled={!!isExporting} title="Save PNG of the active view" className={`scatterlab-action-button flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 text-[10px] font-bold disabled:opacity-40 ${theme==='primary'?'bauhaus-btn bg-[var(--p-blue)] text-white':'bg-[var(--input)] border border-[var(--primary)] text-[var(--primary)]'}`}>
                      <Download className="h-4 w-4" /> PNG
                    </button>
                    <button ref={gifButtonRef} onClick={exportGIF} disabled={viewMode === "2D" || !!isExporting} title="Save rotating GIF (3D only)" className={`scatterlab-action-button flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 text-[10px] font-bold disabled:opacity-40 ${theme==='primary'?'bauhaus-btn bg-[var(--p-yellow)] text-[#111111]':'bg-[var(--input)] border border-[var(--primary)] text-[var(--primary)]'}`}>
                      <Download className="h-4 w-4" /> GIF
                    </button>
                    <button onClick={exportHTML} disabled={!!isExporting} title="Save interactive HTML" className={`scatterlab-action-button flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 text-[10px] font-bold disabled:opacity-40 ${theme==='primary'?'bauhaus-btn bg-[var(--p-red)] text-white':'bg-[var(--input)] border border-[var(--primary)] text-[var(--primary)]'}`}>
                      <Download className="h-4 w-4" /> HTML
                    </button>
                  </div>
                  <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                      <input type="checkbox" checked={includeExportInfo} onChange={e => setIncludeExportInfo(e.target.checked)} />
                      <span className="opacity-80">Add title & legend to exports</span>
                  </label>
                  <button onClick={exportDatasetCsv} disabled={!!isExporting} className={`scatterlab-action-button w-full flex items-center justify-center gap-2 py-2 text-sm font-bold disabled:opacity-40 ${theme==='primary'?'bauhaus-btn bg-white text-black':'bg-[var(--system-green)] border border-[var(--system-green)] text-black'}`}>
                      <Download className="w-4 h-4" /> Save Dataset CSV
                  </button>
              </SidebarSection>
            </>
          )}
        </SidebarGroup>
      </aside>

      {showTableView && activeDataset && (
          <TableViewDialog table={activeDataset.table} name={activeDataset.name} onClose={() => setShowTableView(false)} />
      )}

      {/* Dynamic Divider for Terminal Theme */}
      {theme === 'terminal' && (
        <div className="h-full px-1 flex items-center justify-center bg-transparent relative z-20 w-[6px]">
          <div className="vertical-neon-line h-full w-[2px] mx-auto" />
        </div>
      )}

      {/* Main visualizer area */}
      <main className={`flex-1 relative bg-[var(--background)] z-10 flex overflow-hidden ${assistantDock === 'bottom' ? 'flex-col' : ''}`}>
        <div className="flex-1 relative min-w-0 min-h-0 flex overflow-hidden">
          {allViews.length > 0 ? (
              <>
                  <TmuxGrid views={allViews} renderView={renderView} />
                  <ThemedNotes notes={notes} setNotes={setNotes} theme={theme} />
                  <ThemedLegend view={allViews[0]} theme={theme} muted={mutedMap} onToggle={toggleMuted} />
              </>
          ) : (
              <EmptyState
                theme={theme}
                // "Load demo" opens the walkthrough, which loads the data as its
                // own first act. The panel is dynamically imported, so on the
                // very first paint its ref may not be assigned yet — fall back
                // to a plain load rather than leaving the button dead.
                onLoadDemo={() => { if (startWalkthroughRef.current) startWalkthroughRef.current(); else void loadDemo(); }}
                onUpload={() => dsInputRef.current?.click()}
                busy={isUploading}
                dimmed={walkthroughActive}
              />
          )}
        </div>
        <AssistantPanel
          accessMode={datasets.length > 0 && datasets.every(d => d.dataMode === 'open') ? 'open'
            : datasets.some(d => d.dataMode === 'open') ? 'mixed' : 'private'}
          onAccessClick={activeDatasetId != null ? openActiveAccessInfo : undefined}
          bridgeRef={bridgeRef}
          theme={theme}
          askRef={askAssistantRef}
          convRef={convBridge}
          onConversationChange={noteConversationChange}
          dock={assistantDock}
          onDockChange={changeDock}
          onWalkthroughChange={setWalkthroughActive}
          exitWalkthroughRef={exitWalkthroughRef}
          startWalkthroughRef={startWalkthroughRef}
        />

      </main>
      {sessionNotice && (
        <div className={`scatterlab-session-toast fixed bottom-4 left-14 z-50 flex items-center gap-3 px-3 py-2 text-xs ${theme === 'primary'
          ? ''
          : 'bg-black/85 border border-[var(--system-green)]/50 text-[var(--system-green)]'}`}>
          <span>{sessionNotice === 'restored' ? 'Picked up where you left off.' : 'Your last session didn’t restore cleanly.'}</span>
          {sessionNotice === 'restored' ? (
            <button onClick={startFresh} className="font-bold uppercase tracking-wider underline underline-offset-2 cursor-pointer">Start fresh</button>
          ) : (
            <>
              <button onClick={resumeSession} className="font-bold uppercase tracking-wider underline underline-offset-2 cursor-pointer">Resume</button>
              <button onClick={discardSession} className="font-bold uppercase tracking-wider underline underline-offset-2 cursor-pointer">Discard</button>
            </>
          )}
          <button onClick={() => setSessionNotice(null)} title="Dismiss" className="opacity-60 hover:opacity-100 cursor-pointer"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      {showAddConfig && datasetFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={cancelAddConfig}>
          <div
            onClick={e => e.stopPropagation()}
            className={`w-[440px] max-w-[92vw] max-h-[85vh] overflow-y-auto p-4 flex flex-col gap-3 text-xs border ${theme === 'primary'
              ? 'bg-white border-[3px] border-[var(--border)]'
              : 'bg-[var(--background)] border-[var(--system-green)]/50 text-[var(--system-green)]'}`}
          >
            <div className="font-bold text-sm">Add dataset</div>
            <div className="flex items-center gap-2">
              <span className="font-bold truncate" title={datasetFile.name}>{datasetFile.name}</span>
              <button onClick={() => dsInputRef.current?.click()} className="ml-auto flex-shrink-0 underline-offset-2 hover:underline opacity-60 hover:opacity-100 cursor-pointer">
                choose a different file
              </button>
            </div>
            {sheetOptions.length > 1 && (
              // Only shown for a genuine multi-sheet workbook. The default is
              // the parser's own choice (first sheet with data), so a Readme-
              // then-Data file works without touching this at all.
              <label className="flex flex-col gap-1">
                <span className="opacity-70">Sheet ({sheetOptions.length} in this workbook)</span>
                <select
                  data-guide="sheet-picker"
                  value={selectedSheet}
                  onChange={e => setSelectedSheet(e.target.value)}
                  className={`w-full px-2 py-1 border cursor-pointer ${theme === 'primary' ? 'border-[3px] border-[var(--border)] bg-white' : 'bg-[var(--input)] border-[var(--border)]'}`}
                >
                  <option value="">Choose automatically</option>
                  {sheetOptions.map(s => (
                    <option key={s.name} value={s.name} disabled={s.rows === 0}>
                      {s.name}{s.rows === 0 ? ' — empty' : ` — ${s.rows.toLocaleString()} row${s.rows === 1 ? '' : 's'} × ${s.columns}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {/* Data mode: radio, not checkbox — both choices are explicit, and
                the default protects people who never read settings. */}
            <fieldset className="flex flex-col gap-1" data-guide="data-mode">
              <legend className="opacity-70 pb-0.5">Assistant access for this dataset</legend>
              {([
                { mode: 'private' as const, icon: Lock, label: 'Private research data', hint: 'Assistant sees aggregate summaries only — never individual rows or rare values.' },
                { mode: 'open' as const, icon: Globe, label: 'Public / open data', hint: 'Assistant may read raw rows. Only for data with no personal or confidential content.' },
              ]).map(({ mode, icon: ModeIcon, label, hint }) => (
                <label key={mode} title={hint} className={`flex items-start gap-1.5 px-1.5 py-1 border cursor-pointer ${uploadDataMode === mode
                  ? (theme === 'primary' ? 'border-[var(--border)] bg-[var(--p-yellow)]/60 font-bold' : 'border-[var(--primary)] text-[var(--primary)] bg-[var(--border)]')
                  : 'border-[var(--border)] opacity-70 hover:opacity-100'}`}>
                  <input type="radio" name="upload-data-mode" className="mt-0.5" checked={uploadDataMode === mode} onChange={() => { setUploadDataMode(mode); setUploadOpenConfirmed(false); }} />
                  <span className="flex flex-col">
                    <span className="flex items-center gap-1"><ModeIcon className="w-3 h-3" /> {label}{mode === 'private' ? ' (default)' : ''}</span>
                    <span className="opacity-60 font-normal">{hint}</span>
                  </span>
                </label>
              ))}
              {/* The mode locks in at upload, so the no-sensitive-data
                  confirmation happens HERE — the only moment open exists. */}
              {uploadDataMode === 'open' && (
                <label className="flex items-start gap-2 cursor-pointer pl-1.5 pt-0.5">
                  <input type="checkbox" className="mt-0.5" checked={uploadOpenConfirmed} onChange={e => setUploadOpenConfirmed(e.target.checked)} />
                  <span>I confirm this dataset contains no personal, sensitive, or confidential data.</span>
                </label>
              )}
              <span className="opacity-50 pl-1.5">The mode is locked in when the dataset is added — to change it later, remove and re-add the dataset.</span>
            </fieldset>
            <fieldset className="flex flex-col gap-1">
              <legend className="opacity-70 pb-0.5" title="Codes like 9, -99, 999 that mean 'refused' or 'not applicable' — read as measurements they distort every statistic.">
                Missing-value codes
              </legend>
              {([
                { v: 'configure' as const, label: 'Scan for sentinel/missing-value codes (default)' },
                { v: 'skip' as const, label: 'Skip — my data has none' },
              ]).map(({ v, label }) => (
                <label key={v} className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" name="recode-after" checked={recodeAfterAdd === v} onChange={() => setRecodeAfterAdd(v)} />
                  {label}
                </label>
              ))}
            </fieldset>
            <div className="flex flex-col gap-1">
              <button
                data-guide="components-toggle"
                onClick={() => { if (showComponents) setComponentsFile(null); setShowComponents(!showComponents); }}
                className="underline-offset-2 hover:underline opacity-60 hover:opacity-100 text-left cursor-pointer"
              >
                {showComponents || componentsFile ? '− Remove components file' : '+ Project through a PCA components file'}
              </button>
              {(showComponents || componentsFile) && (
                <button
                  onClick={() => compInputRef.current?.click()}
                  className={`border-2 border-dashed p-2 text-center cursor-pointer ${theme === 'primary' ? 'border-[var(--border)] bg-white' : 'border-[var(--system-green)]/45'}`}
                >
                  {componentsFile ? componentsFile.name : 'Drop or click to choose the PCA components file'}
                </button>
              )}
              <input type="file" className="hidden" accept=".csv,.xlsx,.parquet" ref={compInputRef} onChange={(e) => e.target.files && setComponentsFile(e.target.files[0])} />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={cancelAddConfig} className="scatterlab-action-button px-3 py-1.5 border border-[var(--border)] font-bold cursor-pointer">
                Cancel
              </button>
              <button
                data-guide="add-dataset"
                onClick={handleUpload}
                disabled={isUploading || (uploadDataMode === 'open' && !uploadOpenConfirmed)}
                className={`scatterlab-action-button px-3 py-1.5 font-bold disabled:opacity-40 cursor-pointer ${theme === 'primary'
                  ? 'bauhaus-btn bg-[var(--p-blue)] text-white'
                  : 'border border-[var(--system-green)]/55 bg-[var(--input)] hover:bg-[var(--system-green)]/10'}`}
              >
                {isUploading ? 'Processing…' : 'Add dataset'}
              </button>
            </div>
          </div>
        </div>
      )}
      {datasetSettings != null && (() => {
        const ds = datasets.find(d => d.id === datasetSettings);
        if (!ds) return null;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setDatasetSettings(null)}>
            <div
              onClick={e => e.stopPropagation()}
              className={`w-[400px] max-w-[92vw] p-4 flex flex-col gap-3 text-xs border ${theme === 'primary'
                ? 'bg-white border-[3px] border-[var(--border)]'
                : 'bg-[var(--background)] border-[var(--system-green)]/50 text-[var(--system-green)]'}`}
            >
              <div className="font-bold text-sm flex items-center gap-1.5"><Settings2 className="w-4 h-4" /> {ds.name}</div>
              <div className="opacity-70">{ds.table.nRows.toLocaleString()} rows × {ds.table.columns.length} columns · {ds.provenance?.length ?? 0} history step{(ds.provenance?.length ?? 0) === 1 ? '' : 's'}</div>
              <div className="flex items-center gap-2 border border-[var(--border)] px-2 py-1.5">
                {ds.dataMode === 'open' ? <Globe className="w-3.5 h-3.5 flex-shrink-0" /> : <Lock className="w-3.5 h-3.5 flex-shrink-0" />}
                <span>{ds.dataMode === 'open' ? 'Public / open — assistant may read raw rows' : 'Private — assistant sees aggregates only'}</span>
                <span className="ml-auto flex-shrink-0 opacity-50" title="A dataset's mode is locked in when it is added. To change it, remove the dataset and add it again.">
                  Set at upload
                </span>
              </div>
              <button
                onClick={() => { selectDataset(ds.id); setDatasetSettings(null); setShowRecode('configure'); }}
                title="Declare missing-value codes (9, -99, 999...) and blank them, choosing per column."
                className={`scatterlab-action-button w-full text-xs font-bold py-1.5 border ${theme === 'primary' ? 'border-[var(--border)] bg-[var(--input)] hover:bg-[var(--p-yellow)]' : 'border-[var(--system-green)]/40 bg-[var(--input)] hover:bg-[var(--system-green)]/10'} cursor-pointer`}
              >
                Missing value codes…
              </button>
              <div className="flex justify-between gap-2 pt-1">
                <button
                  onClick={() => { setDatasetSettings(null); setConfirmDelete(ds.id); }}
                  className={`scatterlab-action-button px-3 py-1.5 border font-bold cursor-pointer ${theme === 'primary' ? 'border-[var(--border)] text-[var(--p-red)]' : 'border-red-500/50 text-red-400'}`}
                >
                  Delete dataset…
                </button>
                <button onClick={() => setDatasetSettings(null)} className="scatterlab-action-button px-3 py-1.5 border border-[var(--border)] font-bold cursor-pointer">
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      {confirmDelete != null && (() => {
        const ds = datasets.find(d => d.id === confirmDelete);
        if (!ds) return null;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setConfirmDelete(null)}>
            <div
              onClick={e => e.stopPropagation()}
              className={`w-[380px] max-w-[92vw] p-4 flex flex-col gap-3 text-xs border ${theme === 'primary'
                ? 'bg-white border-[3px] border-[var(--p-red)]'
                : 'bg-[var(--background)] border-red-500/60 text-[var(--system-green)]'}`}
            >
              <div className={`font-bold text-sm ${theme === 'primary' ? 'text-[var(--p-red)]' : 'text-red-400'}`}>
                Delete “{ds.name}”?
              </div>
              <div className="opacity-80 leading-snug">
                This removes the in-app copy ({ds.table.nRows.toLocaleString()} rows), its data history{ds.table.columns.includes('Cluster') || (ds.pcaRuns?.length ?? 0) > 0 ? ', and its derived columns' : ''} from this session. Your original file is untouched.
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setConfirmDelete(null)} className="scatterlab-action-button px-3 py-1.5 border border-[var(--border)] font-bold cursor-pointer">
                  Cancel
                </button>
                <button
                  onClick={() => { removeDataset(ds.id); setConfirmDelete(null); }}
                  className={`scatterlab-action-button px-3 py-1.5 font-bold cursor-pointer ${theme === 'primary'
                    ? 'bauhaus-btn bg-[var(--p-red)] text-white'
                    : 'border border-red-500/60 text-red-400 hover:bg-red-500/10'}`}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      {uploadFailure && (() => {
        const { message, name, diags } = uploadFailure;
        const fixable = (diags ?? []).filter(d => d.kind === 'fixable');
        const kindLabel: Record<ColumnDiagnosis['kind'], string> = {
          numeric: 'numeric ✓', fixable: 'numeric, stored as text',
          'date-like': 'dates (not plottable)', text: 'text / labels', empty: 'empty',
        };
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setUploadFailure(null)}>
            <div
              onClick={e => e.stopPropagation()}
              className={`w-[460px] max-w-[92vw] max-h-[85vh] overflow-y-auto p-4 flex flex-col gap-3 text-xs border ${theme === 'primary'
                ? 'bg-white border-[3px] border-[var(--p-red)]'
                : 'bg-[var(--background)] border-red-500/60 text-[var(--system-green)]'}`}
            >
              <div className={`font-bold text-sm ${theme === 'primary' ? 'text-[var(--p-red)]' : 'text-red-400'}`}>
                ⚠ Upload failed — {name}
              </div>
              <div className="leading-snug">{message}</div>
              {diags && (
                <>
                  <div className="font-bold leading-snug">{summarizeDiagnosis(diags)}</div>
                  <div className="max-h-44 overflow-y-auto border border-[var(--border)] divide-y divide-[var(--border)]">
                    {diags.map(d => (
                      <div key={d.col} className="flex items-center gap-2 px-2 py-1">
                        {d.kind === 'fixable' ? (
                          <input
                            type="checkbox"
                            checked={fixCols.includes(d.col)}
                            onChange={e => setFixCols(prev => e.target.checked ? [...prev, d.col] : prev.filter(c => c !== d.col))}
                          />
                        ) : <span className="w-[13px] flex-shrink-0" />}
                        <span className="font-bold flex-shrink-0" title={d.col}>{d.col}</span>
                        <span
                          className="opacity-60 ml-auto text-right truncate"
                          title={`${kindLabel[d.kind]}${d.kind === 'fixable' ? ` — ${d.numericAfterFix}/${d.nonNull} values parse (${d.patterns.join(', ')})` : ''}`}
                        >
                          {kindLabel[d.kind]}
                          {d.kind === 'fixable' && ` — ${d.numericAfterFix}/${d.nonNull} parse${d.patterns.length ? ` (${d.patterns.join(', ')})` : ''}`}
                        </span>
                      </div>
                    ))}
                  </div>
                  {/* Column names, counts, and pattern labels only — never cell
                      values — so this dialog is identical in Private mode. */}
                  <div className="opacity-60 leading-snug">
                    Diagnosed locally from column shapes: no cell values are shown here and nothing leaves your browser.
                  </div>
                </>
              )}
              <div className="flex justify-end gap-2 pt-1 flex-wrap">
                <button onClick={() => setUploadFailure(null)} className="scatterlab-action-button px-3 py-1.5 border border-[var(--border)] font-bold cursor-pointer">
                  Cancel
                </button>
                <button
                  onClick={() => {
                    askAssistantRef.current?.(
                      `My upload of "${name}" failed with: "${message}".` +
                      (diags ? ` The app's local diagnosis: ${summarizeDiagnosis(diags)}` : '') +
                      ' Explain what this means for my file and how to fix it.'
                    );
                    setUploadFailure(null);
                  }}
                  className="scatterlab-action-button px-3 py-1.5 border border-[var(--border)] font-bold cursor-pointer"
                >
                  ✳ Ask the assistant
                </button>
                {fixable.length > 0 && (
                  <button
                    onClick={retryUploadWithFix}
                    disabled={fixCols.length === 0}
                    className={`scatterlab-action-button px-3 py-1.5 font-bold disabled:opacity-40 cursor-pointer ${theme === 'primary'
                      ? 'bauhaus-btn bg-[var(--p-blue)] text-white'
                      : 'border border-[var(--system-green)]/55 bg-[var(--input)] hover:bg-[var(--system-green)]/10'}`}
                  >
                    Fix {fixCols.length} column{fixCols.length === 1 ? '' : 's'} & add
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
      {accessInfo != null && (() => {
        const ds = datasets.find(d => d.id === accessInfo);
        if (!ds) return null;
        const open = ds.dataMode === 'open';
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setAccessInfo(null)}>
            <div
              onClick={e => e.stopPropagation()}
              className={`w-[380px] max-w-[90vw] p-4 flex flex-col gap-3 text-xs border ${theme === 'primary'
                ? 'bg-white border-[3px] border-[var(--border)]'
                : 'bg-[var(--background)] border-[var(--system-green)]/50 text-[var(--system-green)]'}`}
            >
              <div className="font-bold text-sm flex items-center gap-1.5">
                {open ? <Globe className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                {open ? 'Public / open data' : 'Private research data'}
              </div>
              <div className="opacity-80 leading-snug">
                {open
                  ? <>The assistant may read raw rows of <b>{ds.name}</b> and send them to the configured model API. This mode was explicitly confirmed when the dataset was added.</>
                  : <>The assistant sees only aggregate summaries of <b>{ds.name}</b> — no raw rows, no rare category values, no identifier columns.</>}
              </div>
              <div className="opacity-70 leading-snug">
                A dataset&apos;s mode is locked in when it is added. To change it, remove the dataset and add it again with the other mode.
              </div>
              <div className="flex justify-end pt-1">
                <button onClick={() => setAccessInfo(null)} className="scatterlab-action-button px-3 py-1.5 border border-[var(--border)] font-bold cursor-pointer">
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      <InfoDialog open={showInfo} onClose={() => setShowInfo(false)} theme={theme} />

      {/* Blanking declared missing-value codes. Replaces the active dataset's
          table, which every derived view reads from, and hands the dialog the
          account of what changed so the user sees the effect rather than a
          silent success. */}
      <RecodeDialog
        stage={showRecode}
        table={processedData}
        theme={theme}
        onProceed={() => setShowRecode('configure')}
        onClose={() => setShowRecode(null)}
        onApply={(plan) => {
          if (!activeDataset) return ['No dataset loaded.'];
          const result = applyRecode(activeDataset.table, plan);
          setDatasets(prev => prev.map(d => d.id === activeDataset.id ? { ...d, table: result.table } : d));
          logProvenance(activeDataset.id, `Missing-value codes blanked ${result.totalReplaced} cell${result.totalReplaced === 1 ? '' : 's'} in ${result.effects.filter(e => e.replaced).length} column(s)`);
          const lines = describeRecode(result);
          setUploadStatus([
            `Blanked ${result.totalReplaced} cell${result.totalReplaced === 1 ? '' : 's'} in ${result.effects.filter(e => e.replaced).length} column(s).`,
            ...lines,
            'Re-run PCA or clustering to use the updated values.',
          ].join('\n'));
          return lines;
        }}
      />
    </div>
  );
}
