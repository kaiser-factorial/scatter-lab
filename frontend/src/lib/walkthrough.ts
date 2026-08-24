import type { AppBridge } from './assistant';
import { GUIDE_TARGETS } from './assistant';

// The scripted walkthrough — a guided tour that runs without a model.
//
// There used to be exactly one tour: the `iris_demo` chunk in assistant.ts, a
// long prose brief telling the model to run nine beats "one beat at a time",
// with instructions like "do not set Species as marker shape before step 5" and
// "never initiate a download merely because it is mentioned". That is a script
// enforced by asking nicely, and it cost an API key to see at all — which meant
// the first screen a visitor without one met was a form asking for an API key.
//
// Every beat of that tour was already an AppBridge method. So this is the same
// tour with the model taken out of the loop: the steps call the bridge directly,
// the wording is fixed, the ordering is a data structure, and the whole thing
// runs before any key exists. `iris_demo` now defers to it rather than keeping a
// second copy of the same facts — the drift between three copies of one fact is
// what caused finding A3, and this would have been a fourth.
//
// The spine is deliberately linear and follows the sidebar top to bottom
// (Data → Variables → PCA → Cluster → View → Export), so the timeline the panel
// draws is just this array in order and the user's position in it is one index.

export type GuideTarget = (typeof GUIDE_TARGETS)[number];

// One bridge call, returning the string it reports.
//
// A step's side effects are a LIST of these rather than one function taking a
// bridge, and that is load-bearing rather than stylistic. The bridge closes over
// about forty pieces of React state and is rebuilt on every commit, so two calls
// made against one dereferenced `bridge` object would run the second against
// state from before the first one committed — the GET APP STATE bug the tool
// loop documents at length. Splitting the step into actions lets the runner
// re-read `bridgeRef.current` and paint-yield between each, which makes the
// correct thing the only thing a step can express.
export type StepAction = (bridge: AppBridge) => string | Promise<string>;

export type WalkthroughStep = {
  id: string;
  /** Short label for the timeline. */
  title: string;
  /** What the panel says, as markdown. Facts only — no live numbers. */
  say: string;
  /** Sidebar anchor to point at; the ring holds until the step advances. */
  highlight?: GuideTarget;
  /**
   * Side effects, run in order when the step is entered. Each returns the
   * bridge's own report, rendered as a "▸" chip — so live numbers (variance
   * explained, cluster sizes) come from the app rather than being retyped into
   * `say`, where they would quietly go stale.
   */
  run?: StepAction[];
  /**
   * Buttons. `next: null` ends the walkthrough; `then` says where the user
   * lands — the assistant, or the workspace with the panel out of the way.
   */
  choices: { label: string; next: string | null; then?: 'assistant' | 'exit' }[];
};

/**
 * Whether a step's advance button floats NEXT TO the highlighted control
 * (beside the pointer arrow) instead of sitting in the panel: every step that
 * points at a sidebar section, so advancing always requires having looked at
 * the thing being taught. Derived, not per-step — a new sidebar step gets the
 * behavior for free. assistant-dock is the panel's own chrome (the button
 * would overlap the panel), and multi-choice/ending steps stay in the panel.
 */
export const stepAnchorsChoice = (step: WalkthroughStep): boolean =>
  !!step.highlight && step.highlight !== 'assistant-dock'
  && step.choices.length === 1 && step.choices[0].next !== null;

const IRIS_VARIABLES = ['SepalLengthCm', 'SepalWidthCm', 'PetalLengthCm', 'PetalWidthCm'];

// The 3D view the tour opens and returns to: the flower measurements themselves,
// as distinct from the PC score space it detours through.
const FLOWER_VIEW = { x: 'PetalLengthCm', y: 'PetalWidthCm', z: 'SepalLengthCm' };

export const WALKTHROUGH: WalkthroughStep[] = [
  {
    id: 'welcome',
    title: 'Welcome',
    say:
      'This is a guided walkthrough of Scatter Lab, using the built-in **Iris** demo — 150 flowers, ' +
      'four measurements, three species. It takes about five minutes.\n\n' +
      'I drive the workbench as we go: adding the data, assigning axes, running a PCA, clustering ' +
      'it, and pointing at each control as I describe it.',
    choices: [{ label: 'Start with the Data section', next: 'data' }],
  },
  {
    id: 'data',
    title: 'Data',
    highlight: 'upload-dropzone',
    // The demo loads on the NEXT step — teach the door, then walk through it.
    // Loading here would put data on screen before the user has seen where
    // data comes from. (The advance button floats beside the dropzone, like
    // every sidebar-pointing step — see stepAnchorsChoice.)
    say:
      'Here is where you add your own data — drop a **CSV, XLSX, or Parquet** file on the ' +
      'highlighted box, or click it to browse. A dialog then configures the add: the data mode, ' +
      'missing-value scanning, and an optional components file.',
    choices: [{ label: 'Add the Iris demo', next: 'data-added' }],
  },
  {
    id: 'data-added',
    title: 'Dataset added',
    highlight: 'datasets-list',
    // Idempotent, so arriving with Iris already loaded is fine. Private mode
    // on purpose: the tour should show the default most real data gets, not
    // the open mode the demo uses elsewhere.
    run: [b => b.loadDemoData('private')],
    say:
      'The Iris dataset is in — it now sits in this list, with its Private data mode badge, a gear ' +
      'for its settings, and an ✕ to remove it. Several datasets can be open at once; clicking one ' +
      'makes it the active one.\n\n' +
      'Private mode is the default: everything computes in your browser and the AI assistant sees ' +
      'only column names, aggregate summaries and analysis results — never raw rows. The mode is ' +
      'chosen in the add dialog and locked in for the dataset\'s lifetime.',
    choices: [{ label: 'Look at the variables', next: 'variables' }],
  },
  {
    id: 'variables',
    title: 'Variables',
    highlight: 'variables',
    say:
      'The **Variables** panel is both the data profile and the plot control.\n\n' +
      'Each row shows a column\'s **type**, **range or category count**, **missing values**, and a ' +
      '**mini histogram**. The small buttons do the plotting:\n\n' +
      '- **X**, **Y**, **Z** — put a numeric column on that axis\n' +
      '- **C** — colour the points by it\n' +
      '- **S** — encode it as the marker shape',
    choices: [{ label: 'Run a PCA on the measurements', next: 'pca' }],
  },
  {
    id: 'pca',
    title: 'PCA',
    highlight: 'pca',
    say:
      'To run a PCA: tick the variables, choose how many components to keep, and press Run PCA. ' +
      'One has just been run on the four flower measurements with `Id` excluded.\n\n' +
      '*Standardize* is on, which makes this a correlation-based PCA. The scree bars show how much ' +
      'variance each component explains, and *Top PC contributors* lists which measurements load on ' +
      'each one.\n\n' +
      'The new `PC1`–`PC3` columns are now on the axes: a look into four variables plotted in three ' +
      'dimensions.',
    run: [b => b.runPCA({ variables: IRIS_VARIABLES, n_components: 3, standardize: true })],
    choices: [{ label: 'Cluster the PC scores', next: 'cluster' }],
  },
  {
    id: 'cluster',
    title: 'Clustering',
    highlight: 'cluster',
    say:
      'K-means clustering (k=3) has just run on those 3 PC values. **Clustering always runs on the ' +
      'plotted axes**.\n\n' +
      'Colour is now the cluster, and `Species` has moved onto the **shape** channel, so you are ' +
      'reading two variables at once: do the found clusters line up with the known species? ' +
      '*Cluster info by* below the button cross-tabulates the two, as *% of cluster* or *% of group*, ' +
      'and saves as a heatmap PNG.',
    run: [
      b => b.runClustering('KMEANS', { k: 3, standardize: false }),
      b => b.setPlot({ shape_by: 'Species' }),
      b => b.getClusterBreakdown('Species'),
    ],
    choices: [{ label: 'Compare two views side by side', next: 'compare' }],
  },
  {
    id: 'compare',
    title: 'Compare',
    // Anchored on the View section like every other sidebar step. The panel
    // still docks to the bottom first (two plots side by side need the width;
    // pinning beside a right-docked panel produces two unreadable slivers),
    // but the move is no longer narrated.
    highlight: 'view',
    say:
      'The **View** section switches 2D/3D, toggles the axis grids, renames axis labels for exports, ' +
      'and starts the auto-rotation you can see now. Drag the plot to rotate it yourself, scroll to zoom.\n\n' +
      '**Pin View** freezes the current plot as a snapshot and tiles the canvas — up to four panes — so ' +
      'different axes, colourings or cluster runs sit next to each other. The flat ' +
      '`PC1 × PC2` view has been pinned, and the live plot is back on the flower measurements, still ' +
      'coloured by cluster and shaped by species.',
    run: [
      // Dock first: pinning into the narrow strip beside a right-docked panel
      // produces two unreadable slivers.
      b => b.setAssistantDock('bottom'),
      b => b.setPlot({ x: 'PC1', y: 'PC2', view_mode: '2D' }),
      b => b.pinView(),
      b => b.setPlot({ ...FLOWER_VIEW, view_mode: '3D' }),
      b => b.controlView({ rotation: 'start' }),
    ],
    choices: [{ label: 'See the export options', next: 'export' }],
  },
  {
    id: 'export',
    title: 'Export',
    highlight: 'export',
    say:
      'The **Export** section saves the active view as a 2× **PNG**, a rotating **GIF** of the 3D ' +
      'plot, or a self-contained interactive **HTML** file that spins offline in any browser. It can ' +
      'also write the derived dataset back out as CSV, with PCA scores and cluster labels included.',
    choices: [{ label: 'Finish the walkthrough', next: 'done' }],
  },
  {
    id: 'done',
    title: 'Done',
    say:
      'That is the tour: **load → inspect → decompose → cluster → compare → export**, which is also ' +
      'the sidebar from top to bottom.\n\n' +
      'The workspace is yours now — the Iris data, the PCA run and the clusters are all still loaded, ' +
      'so nothing here is a dead end. Everything you just watched is also available to the AI ' +
      'assistant, which can drive the same controls from a description of what you want.',
    run: [b => b.controlView({ rotation: 'stop' })],
    choices: [
      { label: 'Set up the assistant', next: null, then: 'assistant' },
      { label: 'Explore on my own', next: null, then: 'exit' },
    ],
  },
];

export const WALKTHROUGH_STEPS = WALKTHROUGH.length;

export const walkthroughStep = (id: string): WalkthroughStep | undefined =>
  WALKTHROUGH.find(s => s.id === id);

export const walkthroughIndex = (id: string): number =>
  WALKTHROUGH.findIndex(s => s.id === id);

export const FIRST_STEP = WALKTHROUGH[0].id;

// The greeting shown when handing over to the assistant.
//
// Composed here from the app's own state rather than sent as a hidden user turn:
// a first impression should not be a coin flip, it should not cost a round trip,
// and it has to work before a key exists. The model still gets the real state
// from get_app_state on the first turn the user actually takes.
export const assistantGreeting = (state: ReturnType<AppBridge['getState']>): string => {
  const active = state.datasets.find(d => d.active);
  if (!active) {
    return (
      'Hello. I do not see a dataset loaded yet — drop a CSV, XLSX, or Parquet file into the ' +
      '**Data** section on the left, or say the word and I will load the Iris demo.\n\n' +
      'Once something is in, I can assign axes, run a PCA, cluster it, or just tell you what is in ' +
      'your columns.'
    );
  }
  const cols = state.columns.length;
  return (
    `Hello. You have **${active.name}** open — ${active.nRows.toLocaleString()} rows, ` +
    `${cols} column${cols === 1 ? '' : 's'}. What would you like to explore?\n\n` +
    'I can plot variables against each other, run a PCA, cluster it, compare groups, or point at ' +
    'the part of the interface you are asking about.'
  );
};
