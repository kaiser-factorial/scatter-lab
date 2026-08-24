import type OpenAIType from 'openai';

// The OpenAI client is loaded on FIRST USE, not at module load (finding F1).
//
// A static import put the client — 224 KB gzipped before tree-shaking — on the
// critical path for every visitor, including everyone who never opens the
// assistant and everyone without an API key, for whom the panel is inert. The
// codebase already does this correctly four times over: xlsx, hyparquet, gifenc
// and Plotly are all behind `await import(...)`.
//
// The handle is cached because `describeApiError` needs the error CLASSES for
// its instanceof checks, and it is called from a synchronous context.
let OpenAICtor: typeof OpenAIType | null = null;
const loadOpenAI = async (): Promise<typeof OpenAIType> => {
  if (!OpenAICtor) OpenAICtor = (await import('openai')).default;
  return OpenAICtor;
};
import { METHODS_TOPICS, searchMethods } from './methods';
import { combinedPolicy, MAX_SAMPLE_ROWS, type DataMode, type DataPolicy } from './dataPolicy';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

// The assistant runs entirely in the browser with the user's own API key,
// speaking the OpenAI-compatible protocol. Default endpoint is OpenRouter
// (one key, any model); any compatible endpoint works — including local
// runtimes like Ollama/LM Studio for a fully-offline assistant.
//
// Privacy contract: tools expose column METADATA and AGGREGATE summaries only —
// raw data rows are never placed in a request.

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';

export type ColumnProfile = {
  name: string;
  kind: 'numeric' | 'categorical';
  missing: number;
  // --- numeric ---
  min?: number;
  max?: number;
  /** Population sd (÷n), the convention used everywhere else in this app. */
  mean?: number;
  sd?: number;
  q1?: number;
  median?: number;
  q3?: number;
  // --- categorical ---
  nUnique?: number;
  /**
   * Values frequent enough to be a category rather than a person. A value
   * occurring once IS a row, so the guard is per-value, not per-column: a
   * 60-level `school` column where every level has 80 rows is a category set
   * and goes; an `email` column is 200 individuals and does not (D8).
   */
  topCategories?: { value: string; count: number }[];
  /** Distinct values withheld for being too rare to aggregate. */
  rareValuesWithheld?: number;
};

// The page implements this; the assistant drives the app through it.
export type AppBridge = {
  getState: () => {
    datasets: { name: string; nRows: number; active: boolean; dataMode: DataMode }[];
    columns: ColumnProfile[];
    axes: { x: string; y: string; z: string | null };
    colorBy: string;
    shapeBy: string;
    viewMode: '2D' | '3D';
    pinnedViews: number;
    clusterSettings: { method: string; eps: number; minSamples: number; k: number; standardize: boolean };
    clusterBreakdown: { attribute: string; direction: 'cluster' | 'group'; palette: 'Viridis' | 'Inferno' | 'Greens' };
    pcaRuns: {
      label: string; columns: string[]; variables: string[];
      standardize: boolean; savedAt: string; varianceExplained: number[];
      missing?: { strategy: 'median' | 'complete' | 'iterative'; imputedCells: number; rowsUsed: number; rowsDropped: number };
    }[];
  };
  setPlot: (opts: { x?: string; y?: string; z?: string; color_by?: string; shape_by?: string; view_mode?: '2D' | '3D' }) => string;
  runClustering: (method: 'DBSCAN' | 'KMEANS', opts: { eps?: number; min_samples?: number; k?: number; standardize?: boolean }) => string;
  getClusterBreakdown: (attribute: string) => string;
  saveClusterHeatmap: (opts: { attribute: string; direction?: 'cluster' | 'group'; palette?: 'Viridis' | 'Inferno' | 'Greens' }) => Promise<string>;
  saveRotatingGif: () => Promise<string>;
  saveActiveViewPng: () => Promise<string>;
  saveInteractiveHtml: () => Promise<string>;
  saveActiveDatasetCsv: () => string;
  pinView: () => string;
  loadDemoData: () => Promise<string>;
  // analysis (aggregates only)
  runPCA: (opts: { variables?: string[]; n_components?: number; standardize?: boolean; label?: string; missing?: 'median' | 'complete' | 'iterative' }) => string;
  correlate: (colA: string, colB: string) => string;
  compareGroups: (numericCol: string, groupCol: string) => string;
  suggestK: (maxK: number, standardize?: boolean) => string;
  suggestEps: (minSamples: number, standardize?: boolean) => string;
  // app management
  switchDataset: (name: string) => string;
  setCategoryVisibility: (categories: string[], state: 'normal' | 'muted' | 'hidden') => string;
  transferColumn: (opts: { source_dataset: string; column: string; mode?: 'order' | 'match'; key_column?: string; new_name?: string }) => string;
  removePin: (index: number) => string;
  saveWorkspaceAs: (name: string) => Promise<string>;
  // view control + on-screen guidance
  controlView: (opts: {
    rotation?: 'start' | 'stop';
    zoom?: number;
    pan?: 'left' | 'right' | 'up' | 'down';
    pan_amount?: number;
    reset_camera?: boolean;
  }) => string;
  highlightUI: (target: string) => string;
  // Where the assistant panel sits. The walkthrough moves it to the bottom
  // before it pins a view — side-by-side panes in the narrow strip left by a
  // right-docked panel are unreadable, and the dock control is worth teaching.
  setAssistantDock: (dock: 'right' | 'bottom' | 'float') => string;
  // Same pointer, held until the returned disposer runs (null = not on screen).
  // The scripted walkthrough uses this so the ring survives a long read; the
  // assistant keeps the timed version, which matches how it points while talking.
  holdHighlight: (target: string) => (() => void) | null;
  // undo support: snapshot/restore the whole view state
  snapshot: () => unknown;
  restore: (snap: unknown) => void;
  // --- open-mode only (raw row access) ---
  // Optional on the type, and each implementation re-checks the policy itself:
  // the tool registry not offering these in private mode is the first fence,
  // this is the second (a stale tool call can arrive after a mode flip).
  sampleRows?: (opts: { n?: number; columns?: string[]; sort_by?: string; direction?: 'asc' | 'desc'; seed?: number }) => string;
  getRowsWhere?: (opts: { column: string; op: 'eq' | 'lt' | 'gt' | 'contains'; value: string | number; columns?: string[]; limit?: number }) => string;
  listCategories?: (column: string) => string;
};

// UI anchors the assistant can point at (data-guide attributes in the sidebar)
export const GUIDE_TARGETS = [
  'workspace', 'upload-dropzone', 'add-dataset', 'components-toggle',
  'datasets-list', 'data-mode', 'variables', 'pca', 'view', 'cluster', 'export',
  // Not in the sidebar: the dock buttons in the assistant panel's own header.
  'assistant-dock',
] as const;

// Tools that change what the user sees — a turn using any of these offers Undo
export const MUTATING_TOOLS = new Set([
  'set_plot', 'run_clustering', 'pin_view', 'load_demo_data',
  'switch_dataset', 'set_category_visibility', 'transfer_column', 'remove_pin',
  'run_pca',
]);

// Curated tutorial chunks — the single source of truth the assistant teaches
// from, so tour answers describe the UI as it actually is.
export const TUTORIAL: Record<string, string> = {
  overview:
    'Scatter Lab turns tabular data into interactive 2D/3D scatter plots. All computation runs in the browser and the dataset is never uploaded to a server (you, the assistant, are the one exception — see the privacy topic). Typical flow: add a dataset → assign variables to axes and color in the Variables panel → run PCA or cluster when useful → compare views → export. The built-in Iris demo opens in a species-colored 3D flower view; during a guided tour, demonstrate the marker-shape control by adding Species as the shape encoding after it loads (the initial view intentionally leaves shape unused).',
  load_data:
    'Add data via the dropzone in the sidebar ("1. Data") — drag a CSV, XLSX, or Parquet file in, or click to browse. Choosing a file opens an "Add dataset" dialog where everything about the add is configured in one place: the sheet (for multi-sheet workbooks), the data mode — "Private research data" (the default; the assistant sees aggregate summaries only) or "Public / open data" (the assistant may also read raw rows) — whether to scan for sentinel/missing-value codes after adding (the checker opens right away if so), and an optional PCA components file to project through. Each dataset in the list has a lock/globe badge (click to change the data mode) and a gear (settings: mode, missing-value codes, delete — deleting always asks first). Datasets with PC score columns plot immediately. Optionally, "+ Project through a PCA components file" reveals a second dropzone: supply a loadings file and the app median-imputes, standardizes, and computes PC1–PC3 itself. Several datasets can be loaded at once; click one in the list to make it active.',
  variables:
    'The Variables panel ("2. Variables") is both data profile and plot control. Every column shows its type, range or category count, missing values, and a mini-histogram. The small buttons on each row do the plotting: X, Y, Z put a numeric column on that axis; C colors the points by that column; S encodes it as the marker shape (circle, square, diamond, then open variants — offered only for columns with at most 6 distinct values, and pressed again to switch off). Color and shape are independent, so two variables can be read at once, with a shape key under the legend. If a components file was used, "Top PC contributors" shows which variables load on each PC.',
  plotting:
    'The View section ("5. View") switches 2D/3D, toggles axis grids, renames axis labels for exports, and starts an auto-rotation of the 3D camera. Drag the plot to rotate manually, scroll to zoom. The legend panel on the right can mute (click once) or hide (click twice) individual categories.',
  pca:
    'The PCA section ("3. PCA") runs a principal component analysis right in the browser: tick which numeric variables to include, choose how many components to keep, and press Run. Standardize (on by default) makes it a correlation-based PCA — the right choice when variables are on different scales. "Missing values" chooses between Median impute (default; keeps every row, shrinks variance), Iterative PCA (reconstructs each gap from the low-rank structure of the other variables — roughly half the error of the median on correlated data), and Complete cases (drops any row with a gap, so those rows get no score); the panel shows how many rows survive, flags any variable over 50% missing, and every run reports what it filled or dropped. A run on a variable subset can be given a label (auto-suggested from the item names): its columns become PC1_<label>…, or COMP_<label> when keeping just the top component — the composite-score workflow for building one named score per item group and plotting them against each other. Re-running a label replaces that run\'s columns (confirmed by a dialog); differently-labeled runs coexist. An unlabeled run adds plain PC1…PCk. The scree bars show variance explained, and "Top PC contributors" lists each component\'s strongest loadings. Alternatively, a precomputed components file can be supplied at upload time.',
  clustering:
    'In "4. Cluster", pick DBSCAN (density-based; eps = neighborhood radius, min samples = density threshold; points in no cluster become gray "Noise") or K-Means (choose k). Clustering runs on the currently plotted axes and adds a Cluster column, which also becomes the point coloring. The "Standardize variables (z-score)" checkbox gives every variable equal weight in the distance — its default follows the data: on for mixed scales, off for PC scores and shared-scale items (where it is a deliberate methodological choice). Below the button, "Cluster info by" cross-tabulates clusters against any categorical variable — "% of cluster" shows composition, "% of group" normalizes away base rates. Choose Viridis, Inferno, or Greens and use "Save heatmap" to download a PNG with its 0–100% colour scale legend.',
  compare_pin:
    '"Pin View" (section 5, View) freezes the current plot as a snapshot; the canvas tiles into a grid (up to 4 panes) so different axis choices, colorings, or cluster runs can be compared side by side. The live view keeps updating; pins do not.',
  transfer:
    'With two or more datasets loaded, "Transfer column from another dataset" (bottom of the Data section) copies a column — typically Cluster labels — into the active dataset, aligned by row order (with an automatic identity check) or by a shared key column. This lets you e.g. color one projection space by clusters found in another.',
  export:
    'Section 6 exports the active view: PNG (2x resolution), a rotating GIF of the 3D view, or a self-contained interactive HTML file that works offline — nice for sending a spinnable 3D plot to a collaborator. It can also save the active, derived dataset as a CSV (including PCA scores and Cluster when present). "Add title & legend to exports" controls the dressing. The assistant can save all of these, but should ask before initiating any download.',
  // The nine-beat prose script this used to hold is now code, in
  // lib/walkthrough.ts, where the ordering is a data structure instead of a
  // request. Keeping both would be two copies of one tour drifting apart —
  // the mistake behind finding A3. Point at the scripted one instead.
  iris_demo:
    'There is a scripted, click-through walkthrough of the Iris demo built into the assistant panel — the user opens it from the panel menu ("Guided walkthrough"), and it runs deterministically without a model: load the demo, tour the Variables panel, run a PCA on the four measurements, K-Means the PC scores, pin a 2D comparison, and finish at the export options. If the user asks for a demo, tour, or walkthrough, tell them that button exists and what it covers, and offer it first — it is more reliable than narrating one, and it costs them no tokens. If they would rather you do it live, or they want a tour of THEIR data rather than Iris, run it yourself from the other tutorial topics: load_demo_data, then work down the sidebar (variables, pca, clustering, compare_pin, export), highlighting each section, pausing after each beat with a concrete "Ready to continue to [next step]?" rather than an open-ended question, and never initiating any download merely because it is part of a tour.',
  workspaces:
    'The Workspace section saves the entire session — datasets, pins, notes, settings — locally in the browser (IndexedDB). "Export as file" downloads a workspace as a shareable file; "Import file" loads one. Nothing syncs to any server.',
  privacy:
    'All parsing, projection, and clustering run in the browser, and the dataset itself is never uploaded to a server. Do not tell the user that nothing leaves their machine — that is not true while you are connected. You are the one opt-in exception: what you see is sent to the configured model API, using the user\'s own key. How much you see is the dataset\'s data mode, chosen per dataset at upload (badge in the datasets list to change it): in Private mode (the default) that is column names and aggregate summaries only — never raw rows, never category values covering fewer than 5 rows, never identifier columns. In Public/open mode — which the user must explicitly confirm — you can additionally sample raw rows and list full category breakdowns. If ANY loaded dataset is private, the whole conversation runs in Private mode. Switching a dataset from open back to private clears the assistant conversation, because a transcript that already contains rows cannot be redacted after the fact.',
};

export const TUTORIAL_TOPICS = Object.keys(TUTORIAL);

const BASE_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_app_state',
      description:
        'Read the current state of the workbench: loaded datasets, all column profiles (name, type, range, missing count, top categories), current plot axes, coloring, marker-shape encoding, view mode, pinned view count, and clustering settings. Call this before answering questions about the data or changing the plot.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_plot',
      description:
        'Change what the scatter plot shows. Any combination of: assign a numeric column to the x, y, or z axis; color points by any column; encode a low-cardinality column as the marker shape; switch between 2D and 3D. Omitted fields are left unchanged. Color and shape are independent channels, so setting both shows two variables at once — useful for asking whether one grouping lines up with another (e.g. color by cluster, shape by a demographic, and see whether the shapes separate).',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'string', description: 'Numeric column for the X axis' },
          y: { type: 'string', description: 'Numeric column for the Y axis' },
          z: { type: 'string', description: 'Numeric column for the Z axis (3D only)' },
          color_by: { type: 'string', description: 'Column to color points by' },
          shape_by: {
            type: 'string',
            description:
              'Column to encode as marker symbol (filled circle, square, diamond, then their open variants). At most 6 distinct values, and only really readable up to about 4 — prefer color for anything richer. Pass "none" to turn the shape encoding off.',
          },
          view_mode: { type: 'string', enum: ['2D', '3D'] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_clustering',
      description:
        'Run clustering on the currently plotted axes and color the points by the result. DBSCAN takes eps and min_samples; KMEANS takes k. Returns the cluster sizes. `standardize` z-scores each variable first so all get equal weight in the distance — recommended when the axes mix scales (e.g. Age with survey items); leave it off for PC scores (their variance ordering is the point of PCA) and usually off for items sharing a response scale (variance differences are signal there — a deliberate choice; see the methods reference). Omitted = the current UI toggle, whose default follows these same rules. With standardize, eps is in SD units. If unsure which applies, consult get_methods_reference topic standardize_clustering.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['DBSCAN', 'KMEANS'] },
          eps: { type: 'number', description: 'DBSCAN neighborhood radius (default 0.5; in SD units when standardize is on)' },
          min_samples: { type: 'integer', description: 'DBSCAN min points per core (default 5)' },
          k: { type: 'integer', description: 'KMEANS cluster count (default 3)' },
          standardize: { type: 'boolean', description: 'Z-score variables before clustering (see tool description for when)' },
        },
        required: ['method'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_cluster_breakdown',
      description:
        'After clustering, get the composition of each cluster by a categorical attribute (percentages and counts). Useful for interpreting what the clusters mean.',
      parameters: {
        type: 'object',
        properties: {
          attribute: { type: 'string', description: 'Categorical column to break clusters down by' },
        },
        required: ['attribute'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_cluster_heatmap',
      description:
        'Configure and download a PNG heatmap of cluster composition by a categorical attribute. Choose whether each row is a cluster or an attribute group, and choose the Viridis, Inferno, or Greens 0–100% colour scale. The image includes a percentage legend and the raw count in every cell.',
      parameters: {
        type: 'object',
        properties: {
          attribute: { type: 'string', description: 'Categorical column to cross-tabulate with Cluster' },
          direction: { type: 'string', enum: ['cluster', 'group'], description: '"cluster" = percent within each cluster; "group" = percent within each attribute group' },
          palette: { type: 'string', enum: ['Viridis', 'Inferno', 'Greens'], description: 'PNG colour scale; omitted keeps the current selection' },
        },
        required: ['attribute'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_rotating_gif',
      description:
        'Download a rotating GIF of the active 3D scatter plot. The GIF makes a complete turn around the current plot and includes the current color and marker-shape encodings. It is only available in 3D, and should be called only when the user explicitly asks to save it or accepts an offer.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_active_view_png',
      description:
        'Download a 2× PNG of the current active 2D or 3D scatter view, including its current color and marker-shape encodings. Call only when the user explicitly asks to save it or accepts an offer.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_interactive_html',
      description:
        'Download a self-contained interactive HTML version of the current active 2D or 3D scatter view. The resulting file works offline; 3D exports include rotation controls. Call only when the user explicitly asks to save it or accepts an offer.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_active_dataset_csv',
      description:
        'Download the active dataset as CSV, including currently derived columns such as PCA scores and Cluster labels. Call only when the user explicitly asks to save it or accepts an offer.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pin_view',
      description:
        'Pin the current plot as a snapshot so the user can compare it side-by-side with new views (max 3 pins).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tutorial',
      description:
        `Fetch curated tutorial sections describing how Scatter Lab works. Use this whenever the user asks for a tour, asks how the app or a feature works, or seems lost — then teach from the returned text (do not invent UI details). Available topics: ${TUTORIAL_TOPICS.join(', ')}. Omit topics to get all sections.`,
      parameters: {
        type: 'object',
        properties: {
          topics: {
            type: 'array',
            items: { type: 'string', enum: TUTORIAL_TOPICS },
            description: 'Which sections to fetch; omit for all',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_demo_data',
      description:
        'Load the built-in Iris demo: 150 flowers with four numeric measurements and three species classes. It opens in a 3D petal/sepal view, colored by species, leaving marker shape free for the tour to demonstrate. Useful during a tour or when the user has no data loaded and wants to see the app in action.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_pca',
      description:
        'Run a principal component analysis on numeric variables of the active dataset, entirely in the browser. Adds score columns, reports variance explained and top loadings, and plots the result. Defaults: all numeric non-component, non-identifier variables, 3 components, standardized (correlation PCA). Runs on a variable SUBSET should carry a `label`: columns become PC1_<label>… (or COMP_<label> when n_components=1 — the composite-score workflow: one PCA per item group, keep each top component as a named score, then plot the composites against each other). Re-running an existing label REPLACES that run\'s columns — mention that when it happens; different labels coexist. Derive the label from the variable names (e.g. openness items → "openness"); if no natural name is apparent, ask the user rather than inventing something opaque. Past runs with their variables and labels are listed in get_app_state under pcaRuns.',
      parameters: {
        type: 'object',
        properties: {
          variables: { type: 'array', items: { type: 'string' }, description: 'Numeric columns to include (default: all numeric non-component columns)' },
          n_components: { type: 'integer', description: '1-10, default 3. 1 = keep only the top component as a COMP_<label> composite score' },
          standardize: { type: 'boolean', description: 'Default true (correlation-based PCA)' },
          missing: {
            type: 'string',
            enum: ['median', 'complete', 'iterative'],
            description: 'How to handle rows with missing values. "median" (default) fills each gap with that variable\'s median — simple, but ignores the correlation structure. "complete" drops any row with a gap in the selected variables, keeping the covariance honest but reducing n and potentially biasing the sample. "iterative" is regularized iterative PCA (the missMDA imputePCA method): it reconstructs each gap from the low-rank structure of the other variables and iterates to convergence, which recovers missing values far more accurately when variables are correlated, and is marginally worse than median when they are not. All three are single imputation, so none of them propagate uncertainty. With substantial missingness, running more than one and comparing is the recommended check — see get_methods_reference topic pca_caveats.',
          },
          label: {
            type: 'string',
            description: 'Short semantic name for a subset run (e.g. "openness"). Letters/digits/underscore. Omit only for a full-variable-set PCA (bare PC1..PCk).',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'correlate',
      description:
        'Correlation between two numeric columns: Pearson r, Spearman rho, and n (pairwise-complete). Use for "is X related to Y" questions.',
      parameters: {
        type: 'object',
        properties: {
          col_a: { type: 'string' },
          col_b: { type: 'string' },
        },
        required: ['col_a', 'col_b'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_groups',
      description:
        'Compare a numeric column across the levels of a categorical column: per-group n/mean/sd, overall stats, and both eta-squared and omega-squared (the bias-corrected version — prefer it when there are many groups). Standard deviations are population values. These are descriptive effect sizes, not significance tests. Use for "does X differ by Y" questions. Refuses identifier-like columns, where there is roughly one row per group and eta-squared would be 1.000 by construction.',
      parameters: {
        type: 'object',
        properties: {
          numeric_col: { type: 'string' },
          group_col: { type: 'string', description: 'Categorical column defining the groups' },
        },
        required: ['numeric_col', 'group_col'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_k',
      description:
        'K-Means diagnostics on the currently plotted axes: mean silhouette score for each k from 2 upward (higher = better-separated clusters). Use before run_clustering to recommend k.',
      parameters: {
        type: 'object',
        properties: {
          max_k: { type: 'integer', description: 'Highest k to evaluate (default 8, max 12)' },
          standardize: { type: 'boolean', description: 'Compute the diagnostic on z-scored axes. Defaults to the current UI toggle. Pass the SAME value you intend to give run_clustering — a recommendation computed on raw scales does not apply to a run performed on z-scores (D2).' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_eps',
      description:
        'DBSCAN diagnostics on the currently plotted axes: percentiles of the k-distance curve. Because min_samples counts the point itself, the curve is the distance to each point\'s (min_samples - 1)-th nearest neighbour — i.e. the eps at which that point becomes a core point. A good eps usually sits near the curve\'s knee, around the 90th-95th percentile. Requires min_samples >= 2. Computed on up to 2000 sampled rows, so treat it as a starting point rather than an exact answer. Use before run_clustering with DBSCAN.',
      parameters: {
        type: 'object',
        properties: {
          min_samples: { type: 'integer', description: 'min_samples the user intends to use (default: current setting)' },
          standardize: { type: 'boolean', description: 'Compute the curve on z-scored axes. Defaults to the current UI toggle. Pass the SAME value you intend to give run_clustering: with standardize on, eps is in standard deviations, and a curve read in raw units names an eps that means something else (D2).' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_dataset',
      description: 'Make a different loaded dataset the active one (the one being plotted).',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Dataset name as shown in the sidebar list' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_category_visibility',
      description:
        'Mute (fade), hide, or restore categories of the current color-by column in the plot and legend.',
      parameters: {
        type: 'object',
        properties: {
          categories: { type: 'array', items: { type: 'string' }, description: 'Category values to change' },
          state: { type: 'string', enum: ['normal', 'muted', 'hidden'] },
        },
        required: ['categories', 'state'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'transfer_column',
      description:
        'Copy a column (typically Cluster labels) from another loaded dataset into the active one, aligned by row order or by a shared key column. Reports how many rows matched — warn the user if alignment looks wrong.',
      parameters: {
        type: 'object',
        properties: {
          source_dataset: { type: 'string' },
          column: { type: 'string' },
          mode: { type: 'string', enum: ['order', 'match'], description: 'order = align by row position (default); match = join on key_column' },
          key_column: { type: 'string', description: 'Shared key column, required for mode=match' },
          new_name: { type: 'string', description: 'Name for the new column (default: column·source)' },
        },
        required: ['source_dataset', 'column'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_pin',
      description: 'Remove a pinned view by its position (1 = oldest pin).',
      parameters: {
        type: 'object',
        properties: { index: { type: 'integer', description: '1-based pin position' } },
        required: ['index'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_workspace',
      description:
        'Save the whole session (datasets, pins, settings, notes) as a named workspace in the browser. This persists outside the view state and is NOT covered by undo.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_methods_reference',
      description:
        `Retrieve curated methods-reference chunks (with named citations) on interpreting PCA, clustering, and the app's statistics. ALWAYS call this before answering interpretation or methods questions — e.g. "help me interpret these components", "is this clustering meaningful", "how many components should I keep", "what does eta-squared mean" — and ground your answer in the returned text, naming its cited sources. Topics: ${METHODS_TOPICS.join(', ')}. Provide topics, a free-text query, or both.`,
      parameters: {
        type: 'object',
        properties: {
          topics: { type: 'array', items: { type: 'string', enum: METHODS_TOPICS as string[] } },
          query: { type: 'string', description: 'Free-text search over the reference library' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'control_view',
      description:
        'Move the viewport of the current plot. Works in both modes, but some options are mode-specific: zoom and reset_camera apply to either; rotation (auto-spin) is 3D-only; pan is 2D-only. In 3D, zoom moves the camera in or out and reset_camera returns it to the default angle. In 2D, zoom shrinks or widens the visible x/y window around its centre, pan slides that window one step in a direction, and reset_camera refits the view to all points. To inspect a region in 2D, zoom in and then pan toward it over successive calls; the result reports the visible window each time. Combining reset_camera with zoom/pan in one 2D call applies only the reset.',
      parameters: {
        type: 'object',
        properties: {
          rotation: { type: 'string', enum: ['start', 'stop'], description: '3D only: auto-rotation of the camera' },
          zoom: { type: 'number', description: 'Factor > 1 zooms in, < 1 zooms out. e.g. 1.5 = 50% closer, 0.7 = further away' },
          pan: {
            type: 'string',
            enum: ['left', 'right', 'up', 'down'],
            description: '2D only: slide the visible window toward this side of the data',
          },
          pan_amount: {
            type: 'number',
            description: 'Pan step as a fraction of the visible span (default 0.5 = half a screen). Clamped to 0.05–2.',
          },
          reset_camera: { type: 'boolean', description: '3D: default camera angle. 2D: refit to all points.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'highlight_ui',
      description:
        `Point at a part of the interface with an ephemeral animated highlight (auto-scrolls the sidebar to it, fades after a few seconds). Use while teaching or answering "where/how do I…" questions so the user sees exactly where to look — e.g. highlight upload-dropzone when explaining how to add data. Targets: ${GUIDE_TARGETS.join(', ')}.`,
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: GUIDE_TARGETS as unknown as string[] },
        },
        required: ['target'],
        additionalProperties: false,
      },
    },
  },
];

// Tools that exist ONLY when every loaded dataset is in open mode. Not
// registered at all in private mode — a tool the model cannot name is a
// stronger boundary than a tool that refuses.
const OPEN_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'sample_rows',
      description:
        `Read raw rows from the active dataset (open-data mode). Returns up to ${MAX_SAMPLE_ROWS} rows as JSON. Without sort_by, a seeded random sample (same seed → same rows); with sort_by, the top rows by that column — use direction 'desc' for the largest values (e.g. inspecting outliers). The row cap is a token budget, not a privacy rule; prefer aggregate tools first and pull rows to verify anomalies or answer questions aggregates cannot.`,
      parameters: {
        type: 'object',
        properties: {
          n: { type: 'number', description: `How many rows (default 10, max ${MAX_SAMPLE_ROWS}).` },
          columns: { type: 'array', items: { type: 'string' }, description: 'Columns to include (default: all, capped at 20).' },
          sort_by: { type: 'string', description: 'Sort by this column instead of sampling randomly.' },
          direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default asc).' },
          seed: { type: 'number', description: 'Sampling seed (default 1). Change to draw a different sample.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_rows_where',
      description:
        `Read rows matching a filter from the active dataset (open-data mode). op 'eq' compares as string or number, 'lt'/'gt' compare numerically, 'contains' is a case-insensitive substring match. Returns up to ${MAX_SAMPLE_ROWS} matching rows as JSON plus the total match count.`,
      parameters: {
        type: 'object',
        properties: {
          column: { type: 'string', description: 'Column the filter applies to.' },
          op: { type: 'string', enum: ['eq', 'lt', 'gt', 'contains'] },
          value: { type: ['string', 'number'], description: 'Value to compare against.' },
          columns: { type: 'array', items: { type: 'string' }, description: 'Columns to include in the result (default: all, capped at 20).' },
          limit: { type: 'number', description: `Max rows returned (default 10, max ${MAX_SAMPLE_ROWS}).` },
        },
        required: ['column', 'op', 'value'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_categories',
      description:
        'Full value/count breakdown of one column of the active dataset (open-data mode), including values covering only a single row. Sorted by count, capped at 200 distinct values per call.',
      parameters: {
        type: 'object',
        properties: {
          column: { type: 'string', description: 'Column to enumerate.' },
        },
        required: ['column'],
        additionalProperties: false,
      },
    },
  },
];

export const toolsFor = (policy: DataPolicy): ChatCompletionTool[] =>
  policy.rowAccess ? [...BASE_TOOLS, ...OPEN_TOOLS] : BASE_TOOLS;

// The conversation-level policy: open only when every loaded dataset is open.
export const sessionPolicyOf = (state: ReturnType<AppBridge['getState']>): DataPolicy =>
  combinedPolicy(state.datasets.map(d => d.dataMode));

const fmtNum = (v: number | undefined) =>
  v === undefined ? '?' : Math.abs(v) >= 100 ? v.toFixed(0) : String(Math.round(v * 100) / 100);

export const buildSystemPrompt = (bridge: AppBridge): string => {
  const s = bridge.getState();
  const policy = sessionPolicyOf(s);
  const anyOpen = s.datasets.some(d => d.dataMode === 'open');
  // Three access postures, one paragraph each — the paragraph MUST match the
  // tool list toolsFor() built from the same policy, so both derive from it.
  const accessParagraph = policy.rowAccess
    ? `Every loaded dataset was explicitly declared public/open by the user. In addition to aggregate statistics you may inspect raw data: sample_rows (seeded random sample or top-N by a column), get_rows_where (filtered rows), and list_categories (full value counts, including single-row values). Each call returns at most ${MAX_SAMPLE_ROWS} rows — a token budget, not a privacy rule. Still prefer aggregates first: pull rows to verify anomalies, inspect outliers or specific cases, or answer questions the summaries cannot.`
    : `You see column metadata and aggregate statistics only; you never see raw data rows. Numeric columns come as min/max/mean/sd/quartiles — use those to notice skew, ceiling effects and likely outliers rather than asking for the data. Categorical columns list only values covering at least 5 rows; rareValuesWithheld counts the distinct values held back for being rarer than that, and identifier-like columns list none at all. That is a privacy guarantee, not a gap to work around: never ask the user to paste rows, and if asked about an individual row or participant, explain that you only have access to summaries.${anyOpen ? ' (Some loaded datasets are marked open, but at least one is private, so the whole conversation runs at the private level — row tools are unavailable until every loaded dataset is open.)' : ''}`;
  const cols = s.columns
    .map(c =>
      c.kind === 'numeric'
        ? `- ${c.name}: numeric, ${fmtNum(c.min)}–${fmtNum(c.max)}${c.missing ? `, ${c.missing} missing` : ''}`
        : `- ${c.name}: categorical (${c.nUnique} values: ${(c.topCategories ?? [])
            .slice(0, 6)
            .map(t => `${t.value} n=${t.count}`)
            .join(', ')})${c.missing ? `, ${c.missing} missing` : ''}`
    )
    .join('\n');

  return `You are the built-in assistant of Scatter Lab, a browser-based workbench where researchers explore tabular data as interactive 2D/3D scatter plots, project data through PCA components, run DBSCAN/K-Means clustering, and compare pinned views. The user is typically a survey researcher.

You can drive the app with your tools: change plot axes, coloring and marker shape, switch 2D/3D or the active dataset, run clustering, read cluster compositions, configure and save a cluster-composition heatmap, save PNG, interactive HTML, rotating GIF, or active-dataset CSV exports, mute/hide legend categories, transfer columns between datasets, pin/remove views, and save workspaces. You also have aggregate analysis tools: run_pca (in-browser principal component analysis — use it when the user wants to reduce dimensions or "see the structure" of a set of scale items; it reports how much data was imputed or dropped, which you should mention when it is not negligible), correlate (Pearson/Spearman), compare_groups (means by category + eta-squared), and clustering diagnostics (suggest_k silhouette scores, suggest_eps k-distance percentiles) — prefer running these over guessing parameters or relationships. Use tools to act, then summarize what you did in one or two sentences. When the user asks a question about their data, answer from the column profiles and aggregate tool results — never invent numbers you have not seen in this conversation.

${accessParagraph}

Facts about THIS app that you cannot guess and are likely to get wrong from priors — state them when they come up, without needing to look them up:
- K-Means here is DETERMINISTIC. It is seeded k-means++ from fixed seeds, best of 10 initialisations, up to 300 iterations, so the same data and the same k always give identical clusters. The usual answer ("no, k-means is randomly initialised") is wrong for this app. Say so, and add that reproducibility is not evidence of stable structure — to test that, vary k and re-run on subsamples.
- Missing values in CLUSTERING are always median-imputed. In PCA the user chooses: median, regularized iterative PCA (missMDA imputePCA), or complete-case. Every run reports how many cells it filled or how many rows it dropped, and in which variables.
- Clustering runs on the two or three columns currently on the X, Y and Z axes — nothing else. Choosing the axes IS choosing the features. Good for PC scores, weak for two arbitrary raw columns.
- compare_groups reports SAMPLE standard deviations (n-1), the reporting convention; the PCA and projection use population (÷n) internally to match scikit-learn. eta-squared is reported alongside omega-squared, which corrects its upward bias — prefer omega-squared when there are many groups.
- suggest_eps reads the k-distance curve at the (min_samples - 1)-th neighbour, because dbscan counts the point itself toward min_samples. eps is in the units of the plotted axes, or in standard deviations when standardize is on.

Statistical guidance is welcome: help interpret PC loadings, choose sensible eps/min_samples or k, and reason about what cluster compositions suggest — while being clear about the limits of exploratory clustering (results depend on parameters; clusters are descriptive, not proof of latent groups).

When the user asks you to interpret results or asks a methods question (components to keep, whether clusters are meaningful, effect sizes, correlations), call get_methods_reference first and ground your answer in the returned text, mentioning the sources it names. Keep the interpretation tied to their actual numbers.

When explaining where something is in the interface or how to do something manually, call highlight_ui to point an ephemeral highlight at the relevant control while you explain — especially during tours (pair each tour step with its highlight).

Tours: when the user asks for a tour, asks how the app works, or seems new, call get_tutorial and teach from it — never invent UI details. For a demo of the built-in Iris data, request the iris_demo topic first: a scripted click-through walkthrough already exists in the panel menu, and pointing them at it is better than narrating your own. Only run a tour yourself if they decline it, or if they want their own data toured. When you do, pause after each beat with a concrete “Ready to continue to [next step]?” question, never an unstructured “what next?” that loses the tour. For a general tour, pick the sections that match their situation (no data yet → start with load_data). Do not initiate any download just because it is part of a tour: offer it, then wait for a clear user yes.

Keep responses short and concrete. This is a side panel, not a report.

Current session:
${s.datasets.length === 0 ? 'No dataset loaded yet — suggest loading one (there is a demo dataset button on the empty canvas).' : `Data access: ${policy.rowAccess ? 'OPEN — row tools available' : 'PRIVATE — aggregates only'}.
Datasets: ${s.datasets.map(d => `${d.name} (${d.nRows} rows, ${d.dataMode}${d.active ? ', active' : ''})`).join('; ')}
Plot: ${s.viewMode}, x=${s.axes.x}, y=${s.axes.y}${s.axes.z ? `, z=${s.axes.z}` : ''}, colored by ${s.colorBy}${s.shapeBy ? `, marker shape by ${s.shapeBy}` : ''}. Pinned views: ${s.pinnedViews}/3.
Columns of the active dataset:
${cols}`}`;
};

export type StreamHandlers = {
  onText: (delta: string) => void;
  onToolUse: (name: string, argsSummary?: string) => void;
};

// Compact "k=v" rendering of tool arguments for the chat's tool chips
export const summarizeArgs = (argsJson: string): string => {
  try {
    const o = JSON.parse(argsJson || '{}');
    const s = Object.entries(o)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : String(v)}`)
      .join(' ');
    return s.length > 70 ? s.slice(0, 67) + '…' : s;
  } catch {
    return '';
  }
};

const makeClient = async (apiKey: string, baseURL: string) => {
  const OpenAI = await loadOpenAI();
  return new OpenAI({
    apiKey,
    baseURL,
    dangerouslyAllowBrowser: true,
    maxRetries: 1,
    defaultHeaders: {
      'HTTP-Referer': 'https://scatter-lab.vercel.app',
      'X-Title': 'Scatter Lab',
    },
  });
};

// One user turn: stream the response, execute any tool calls, loop until the
// model stops asking for tools. Returns the updated history.
// Yield until React has committed and painted.
//
// Anything making two bridge calls in a row needs this: the second call
// otherwise reads state from before the first one's commit. A fixed timeout
// proved too short on slow machines. Exported because the scripted walkthrough
// runs multi-call steps and must not grow its own copy of the rule.
export const paintYield = (): Promise<void> =>
  new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === 'undefined') return void setTimeout(resolve, 50);
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 20)));
  });

export const runAssistantTurn = async (
  apiKey: string,
  baseURL: string,
  model: string,
  history: ChatCompletionMessageParam[],
  userText: string,
  // The REF, not the bridge object: React reassigns .current with fresh
  // closures on every commit, so each tool call sees post-commit state.
  // (Passing the object froze the whole turn at send-time state.)
  bridgeRef: { current: AppBridge },
  handlers: StreamHandlers,
): Promise<ChatCompletionMessageParam[]> => {
  const client = await makeClient(apiKey, baseURL);
  const messages: ChatCompletionMessageParam[] = [...history, { role: 'user', content: userText }];

  const executeTool = async (name: string, argsJson: string): Promise<string> => {
    const bridge = bridgeRef.current; // fresh closures as of the latest commit
    let input: any = {};
    try {
      input = argsJson ? JSON.parse(argsJson) : {};
    } catch {
      return 'Tool error: arguments were not valid JSON.';
    }
    try {
      switch (name) {
        case 'get_app_state':
          return JSON.stringify(bridge.getState());
        case 'set_plot':
          return bridge.setPlot(input ?? {});
        case 'run_clustering':
          return bridge.runClustering(input.method, input);
        case 'get_cluster_breakdown':
          return bridge.getClusterBreakdown(input.attribute);
        case 'save_cluster_heatmap':
          return await bridge.saveClusterHeatmap(input);
        case 'save_rotating_gif':
          return await bridge.saveRotatingGif();
        case 'save_active_view_png':
          return await bridge.saveActiveViewPng();
        case 'save_interactive_html':
          return await bridge.saveInteractiveHtml();
        case 'save_active_dataset_csv':
          return bridge.saveActiveDatasetCsv();
        case 'pin_view':
          return bridge.pinView();
        case 'get_tutorial': {
          const topics: string[] = Array.isArray(input?.topics) && input.topics.length ? input.topics : TUTORIAL_TOPICS;
          return topics
            .filter(t => TUTORIAL[t])
            .map(t => `## ${t}\n${TUTORIAL[t]}`)
            .join('\n\n') || `Unknown topics. Available: ${TUTORIAL_TOPICS.join(', ')}.`;
        }
        case 'load_demo_data':
          return await bridge.loadDemoData();
        case 'run_pca':
          return bridge.runPCA(input ?? {});
        case 'correlate':
          return bridge.correlate(input.col_a, input.col_b);
        case 'compare_groups':
          return bridge.compareGroups(input.numeric_col, input.group_col);
        case 'suggest_k':
          return bridge.suggestK(Math.min(input?.max_k ?? 8, 12), input?.standardize);
        case 'suggest_eps':
          return bridge.suggestEps(input?.min_samples, input?.standardize);
        case 'switch_dataset':
          return bridge.switchDataset(input.name);
        case 'set_category_visibility':
          return bridge.setCategoryVisibility(input.categories ?? [], input.state);
        case 'transfer_column':
          return bridge.transferColumn(input);
        case 'remove_pin':
          return bridge.removePin(input.index);
        case 'save_workspace':
          return await bridge.saveWorkspaceAs(input.name);
        case 'get_methods_reference': {
          const chunks = searchMethods({ topics: input?.topics, query: input?.query });
          if (!chunks.length) return `Nothing matched. Available topics: ${METHODS_TOPICS.join(', ')}.`;
          return chunks.map(c => `## ${c.title}\n${c.text}`).join('\n\n');
        }
        case 'sample_rows':
          return bridge.sampleRows?.(input ?? {}) ?? 'Row access is not available: the session is in Private data mode.';
        case 'get_rows_where':
          return bridge.getRowsWhere?.(input) ?? 'Row access is not available: the session is in Private data mode.';
        case 'list_categories':
          return bridge.listCategories?.(input.column) ?? 'Row access is not available: the session is in Private data mode.';
        case 'control_view':
          return bridge.controlView(input ?? {});
        case 'highlight_ui':
          return bridge.highlightUI(input.target);
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err: any) {
      return `Tool error: ${err?.message ?? err}`;
    }
  };

  const MAX_LOOPS = 16;
  for (let i = 0; i < MAX_LOOPS; i++) {
    const stream = client.chat.completions.stream({
      model,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: buildSystemPrompt(bridgeRef.current) },
        ...messages,
      ],
      // Recomputed each iteration: a tool call this loop already ran (e.g.
      // switch_dataset) can change which datasets — and so which mode — the
      // next iteration is talking about.
      tools: toolsFor(sessionPolicyOf(bridgeRef.current.getState())),
    });

    stream.on('content', delta => handlers.onText(delta));
    const completion = await stream.finalChatCompletion();
    const choice = completion.choices[0];
    if (!choice) throw new Error('Empty response from the model.');
    const msg = choice.message;

    // Keep the assistant turn (content and/or tool_calls) in history
    messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    } as ChatCompletionMessageParam);

    if (!msg.tool_calls?.length) return messages;

    for (const call of msg.tool_calls) {
      if (call.type !== 'function') continue;
      handlers.onToolUse(call.function.name, summarizeArgs(call.function.arguments));
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: await executeTool(call.function.name, call.function.arguments),
      });
      await paintYield();
    }
  }
  handlers.onText('\n[Paused after many tool calls — say "continue" to keep going.]');
  return messages;
};

export type ModelInfo = { id: string; created: number };

// Fetch the model catalog from the endpoint (OpenRouter serves this publicly).
// Returns [] on failure — the panel falls back to a free-text model field.
export const fetchModels = async (baseURL: string, apiKey: string): Promise<ModelInfo[]> => {
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list: any[] = data?.data ?? [];
    // OpenRouter reports supported_parameters per model; only models that
    // support tool calling can drive the app. Endpoints without capability
    // info (e.g. local runtimes) are left unfiltered.
    const hasCaps = list.some(m => Array.isArray(m?.supported_parameters));
    return list
      .filter(m => !hasCaps || (Array.isArray(m?.supported_parameters) && m.supported_parameters.includes('tools')))
      .filter(m => typeof m?.id === 'string')
      .map(m => ({ id: m.id as string, created: typeof m?.created === 'number' ? m.created : 0 }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
};

// Curated suggestions: the newest tool-capable model from each major family
// actually present in the live catalog — so we never suggest a stale ID.
const SUGGESTED_FAMILIES = [
  'anthropic/claude', 'openai/gpt', 'google/gemini',
  'x-ai/grok', 'deepseek/deepseek', 'qwen/qwen',
];
export const suggestModels = (models: ModelInfo[]): string[] => {
  const out: string[] = [];
  for (const fam of SUGGESTED_FAMILIES) {
    const candidates = models
      .filter(m => m.id.startsWith(fam) && !m.id.includes(':free') && !/preview|exp/.test(m.id))
      .sort((a, b) => b.created - a.created);
    // Prefer the newest full-strength model; speed tiers only as fallback
    const best = candidates.find(m => !/fast|flash|mini|lite|nano|tiny|air/.test(m.id)) ?? candidates[0];
    if (best) out.push(best.id);
  }
  return out;
};

// Friendly error strings for the panel
export const describeApiError = (err: unknown): string => {
  // Reads err.status rather than `instanceof OpenAI.AuthenticationError`, so
  // this stays synchronous and does not force the SDK to be loaded just to
  // describe a failure (F1). The status codes are the same contract the error
  // classes wrap, and they survive a client that never loaded at all.
  const e = err as { status?: number; message?: string; name?: string };
  switch (e?.status) {
    case 401:
    case 403: return 'API key rejected — check it in settings.';
    case 404: return 'Model not found — check the model ID in settings.';
    case 429: return 'Rate limited — wait a moment and try again.';
  }
  // APIConnectionError carries no status: the request never reached a server.
  if (e?.name === 'APIConnectionError' || e?.name === 'APIConnectionTimeoutError') {
    return 'Could not reach the API — check your connection.';
  }
  if (typeof e?.status === 'number') return `API error: ${e.message ?? e.status}`;
  return `Error: ${e?.message ?? err}`;
};
