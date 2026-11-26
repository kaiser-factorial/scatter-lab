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
// (Iris PCA and clustering, then survey EFA and export), so the timeline the panel
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
export type StepAction = [summary: string, execute: (bridge: AppBridge) => string | Promise<string>];

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

// The Iris welcome starts with three of the original flower measurements.
const FLOWER_VIEW = { x: 'PetalLengthCm', y: 'PetalWidthCm', z: 'SepalLengthCm' };

export const DEMO_ENTRY: WalkthroughStep = {
  id: 'load-iris', title: 'Demo', say: '',
  run: [['Iris demo loaded', bridge => bridge.loadDemoData('iris')]],
  choices: [{ label: 'Begin demo walkthrough', next: 'welcome' }],
};

export const WALKTHROUGH: WalkthroughStep[] = [
  {
    id: 'welcome',
    title: 'Welcome',
    run: [['Settings applied', bridge => bridge.setPlot({ ...FLOWER_VIEW, color_by: 'Species', shape_by: 'none', view_mode: '3D' })]],
    say:
      'Welcome to **Scatter Lab**! We’ve loaded the **Iris dataset**. Each dot is a flower; its colour shows its species.\n\n' +
      'We’ll explore the flower measurements with PCA, then try factor analysis on a survey.',
    choices: [{ label: 'Start with the Data section', next: 'data' }],
  },
  {
    id: 'data',
    title: 'Data',
    highlight: 'upload-dropzone',
    say: 'Drop a **CSV, XLSX, or Parquet** file here, or click to browse.\n\nFor this demo, we’ve loaded the **Iris dataset** for you.',
    choices: [{ label: 'Look at the variables', next: 'variables' }],
  },
  {
    id: 'variables',
    title: 'Variables',
    highlight: 'variables',
    say: 'Choose a variable for each part of your plot.\n\n- **X, Y, Z** — axis variables\n- **C** — marker color\n- **S** — marker shape',
    choices: [{ label: 'Run a PCA on the measurements', next: 'pca' }],
  },
  {
    id: 'pca',
    title: 'PCA',
    highlight: 'pca',
    say: 'The axes show **PC1–PC3** from four standardized flower measurements. The scree bars show how much variance each component explains.',
    run: [['PCA result', b => b.runPCA({ variables: IRIS_VARIABLES, n_components: 3, standardize: true })]],
    choices: [{ label: 'Cluster the PC scores', next: 'cluster' }],
  },
  {
    id: 'cluster',
    title: 'Clustering',
    highlight: 'cluster-breakdown',
    say: '**Color** shows cluster and **shape** shows species. In the sidebar, look under **Cluster Info by → Species**. **% of cluster** shows each species’ share of that cluster.',
    run: [
      ['Clustering result', b => b.runClustering('KMEANS', { k: 3, standardize: false })],
      ['Shape settings', b => b.setPlot({ shape_by: 'Species' })],
      ['Species breakdown', b => b.getClusterBreakdown('Species', { showInSidebar: true })],
    ],
    choices: [{ label: 'Load the synthetic survey', next: 'survey' }],
  },
  {
    id: 'survey', title: 'Synthetic survey', highlight: 'datasets-list',
    run: [['Survey loaded', b => b.loadDemoData('survey', 'development')]],
    say: 'Now we’ll explore EFA with a dataset of synthetic survey responses.\n\nBoth datasets are loaded. The survey includes **Likert responses and demographic information** for 1,500 synthetic respondents.',
    choices: [{ label: 'See the survey split', next: 'split' }],
  },
  {
    id: 'split', title: 'Development / holdout', highlight: 'survey-split',
    say: 'At import, **Create development / holdout sets** splits the survey. We’ll fit the EFA on Development. Holdout stays locked.',
    choices: [{ label: 'Review EFA settings', next: 'efa-setup' }],
  },
  {
    id: 'efa-setup', title: 'EFA settings', highlight: 'efa-settings',
    run: [['Settings selected', b => b.configureDemoSurvey()]],
    say: 'In **PCA / EFA**, choose **EFA** for the eight Likert items.\n\n- **Polychoric correlations** for ordered responses\n- **MINRES extraction** to estimate two factors\n- **Promax rotation** so the factors can correlate',
    choices: [{ label: 'Fit two factors with demo settings', next: 'efa' }],
  },
  {
    id: 'efa', title: 'Factor loadings', run: [['Factor fit', b => b.fitDemoSurvey()]],
    say: 'In the saved result, compare F1 and F2 for **Plan** (“I make a plan before starting a task.”).',
    choices: [{ label: 'Plot respondent scores', next: 'scores' }],
  },
  {
    id: 'scores', title: 'Factor scores', highlight: 'factor-score-rows', run: [['Respondent scores', b => b.scoreDemoSurvey()], ['Score plot settings', b => b.plotDemoScores()]],
    say: 'Each dot is **one Development respondent**. The axes show their estimated F1 and F2 scores. **Color** shows gender.',
    choices: [{ label: 'See the export options', next: 'export' }],
  },
  {
    id: 'export',
    title: 'Export',
    highlight: 'export',
    say: '- **Image** — save the plot\n- **Data** — save the rows\n- **Analysis record** — share the steps and settings',
    choices: [{ label: 'Finish the walkthrough', next: 'done' }],
  },
  {
    id: 'done',
    title: 'Done',
    say: 'Both datasets are ready to explore. Switch between them in **Data**.',
    choices: [
      { label: 'Set up the assistant', next: null, then: 'assistant' },
      { label: 'Explore on my own', next: null, then: 'exit' },
    ],
  },
];

export const WALKTHROUGH_STEPS = WALKTHROUGH.length;

// A running preview can still hold a removed step during a hot update.
const legacySteps: Readonly<Partial<Record<string, string>>> = { 'data-added': 'variables', compare: 'cluster' };
const currentStepId = (id: string) => legacySteps[id] ?? id;

export const walkthroughStep = (id: string): WalkthroughStep | undefined =>
  id === DEMO_ENTRY.id ? DEMO_ENTRY : WALKTHROUGH.find(s => s.id === currentStepId(id));

export const walkthroughIndex = (id: string): number =>
  WALKTHROUGH.findIndex(s => s.id === currentStepId(id));

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
