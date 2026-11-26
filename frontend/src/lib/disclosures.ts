// What the app tells the user about its own methods.
//
// Single source of truth on purpose. These strings are read by the sidebar
// tooltips and by the About page. Writing them in two places is how the
// implementation and `methods.ts` came to disagree about the k-distance
// convention (finding A3) — the same drift would be worse here, because a wrong
// disclosure is more harmful than a missing one.
//
// TWO TIERS, one source. A tooltip should say *what the app did* and stop; the
// reader can bring their own knowledge, ask the assistant, or open the About
// page. So each entry splits:
//
//   text  — shown in the tooltip AND on the About page. What we did.
//   more  — shown ONLY on the About page. Why it matters, and what it costs.
//
// Both are arrays, one string per line, and both surfaces render them as
// separate bullets. The single dense paragraph they replace was the thing that
// made the tooltips overwhelming.
//
// Scope: these describe METHOD, not results. Anything specific to a particular
// run — how many cells were imputed, which columns were clustered, how many
// rows a diagnostic sampled — belongs inline next to that result, where it
// cannot be missed, not behind a tooltip the user has to go looking for.
//
// `methods.ts` remains the long-form, citation-backed reference the assistant
// retrieves from. These are the short, plain-language versions of the specific
// choices this app makes, which is a different job.
//
// Formatting: **emphasis** is the ONE device these strings may carry (rendered
// by emphasisSegments below); anything else — backticks, links — shows up
// literally.

import { TEST_RELEASE_REQUIREMENTS, TEST_RELEASE_SUMMARY } from './analysisPlan';

export type Disclosure = {
  /** Short label — the tooltip heading and the About page entry title. */
  title: string;
  /**
   * What the app does. Shown in the tooltip AND on the About page, one bullet
   * per string. Keep each line to a sentence or two of plain language.
   */
  text: string[];
  /**
   * Why it matters, what it costs, and the caveats. About page only — this is
   * the material that made tooltips too long to read at a glance.
   */
  more?: string[];
  /** Optional matching topic in methods.ts, for "read more" links. */
  methodsTopic?: string;
};

export const DISCLOSURES = {
  data_modes: {
    title: 'Assistant data access',
    text: [
      'The configured model endpoint receives your chat, dataset and column names, and permitted analysis summaries. Dataset tools withhold individual rows, identifier values and groups smaller than five.',
      'Numeric extremes must occur in at least five rows to be reported. Analyses are blocked if a filter leaves or excludes fewer than five rows. Comparing overlapping filters can still reveal information.',
      'File parsing and CPU statistics run locally in the browser. Browser CPU and WebGPU are the available compute paths; WebGPU uses the local GPU through the browser.',
      'A genuinely local model endpoint keeps model requests local. Feedback, sign-in, external links and remote images are separate network paths; choosing a local model does not disable them.',
    ],
    more: [
      'Text you type into chat or an optional feedback reason is not automatically redacted. Feedback ratings send metadata to the configured Supabase service; sending a reason can also include the displayed exchange when its checkbox is checked.',
      'The website host delivers code and assets without needing your dataset for local analysis. Workspaces use browser storage; downloaded data/workspace files can contain raw data.',
    ],
  },

  statistical_tests: {
    title: 'The Analyze Tools',
    text: [
      TEST_RELEASE_SUMMARY,
      'Results identify the p-value approximation, effect size and, for Welch’s t, a 95% confidence interval on the mean difference. Seven descriptive chart types remain available: ECDF, histogram, box, violin, Q–Q, bar and line over time.',
      'Category values covering fewer than 5 rows stay withheld here too: charts pool them as an unlabeled "(rare values)" bucket or omit them with a note.',
      'Histograms share bin edges across groups, bars anchor at zero and distribution charts do not, and violins use a Gaussian kernel density (Silverman\'s bandwidth).',
    ],
    more: [...TEST_RELEASE_REQUIREMENTS, 'These are conservative release limits, not proof that the study assumptions hold or that inference is calibrated for every accepted dataset.'],
    methodsTopic: 'statistical_tests',
  },

  kmeans_deterministic: {
    title: 'K-Means Clustering',
    text: [
      '**This app** runs K-Means from 10 fixed k-means++ starting points and keeps the run whose clusters have the lowest inertia.',
      'Each run refines its clusters until no point changes assignment, with a 300-round safety cap.',
      'It does not search for the global optimum.',
      'The same data and the same k therefore always give byte-identical clusters in **this app**.',
    ],
    methodsTopic: 'kmeans_interpretation',
  },

  dbscan_parameters: {
    title: 'Eps And Min-Samples',
    text: [
      'A point is a core point when at least **min samples** points lie within distance **eps**, counting itself.',
      'eps is in the units of the plotted axes — or in standard deviations when Standardize is on.',
    ],
    methodsTopic: 'dbscan_interpretation',
  },

  median_imputation: {
    title: 'How Missing Values Are Handled',
    text: [
      "**Median imputation** fills each gap with that variable's median.",
      '**Iterative PCA** reconstructs each gap from the low-rank structure of the other variables and repeats until the fill settles (the missMDA imputePCA method).',
      '**Complete cases** drops any row with a missing value.',
      '**Clustering always median-imputes.**',
      'Every run reports what it filled or dropped, and in which variables.',
    ],
    methodsTopic: 'missing_data_tradeoffs',
  },

  clusters_plotted_axes: {
    title: 'Clustering Uses The Plotted Axes',
    text: [
      'Clustering runs on the two or three columns currently assigned to X, Y and Z — nothing else.',
      'Choosing the axes is therefore choosing the features.',
    ],
    // Was pointing at 'standardize_clustering', which is a different subject.
    // This disclosure is about which features the clustering sees, and how much
    // weight to put on the result — which is what cluster_validity covers.
    methodsTopic: 'cluster_validity',
  },

  standardize_pca: {
    title: 'Standardizing Before PCA',
    text: [
      'ON: each variable is z-scored first, making this a correlation-based PCA where every variable carries equal weight.',
      'OFF: covariance-based, where high-variance variables dominate the components.',
    ],
    methodsTopic: 'standardize_or_not',
  },

  standardize_clustering: {
    title: 'Standardizing Before Clustering',
    text: [
      'Z-scoring gives every variable equal weight in the distance.',
      'Suggested ON for mixed scales, OFF for PC scores.',
    ],
    methodsTopic: 'standardize_clustering',
  },

  pca_loadings: {
    title: 'PCA Loadings',
    text: [
      'The numbers shown are unit-norm eigenvector weights (the quantity scikit-learn calls components_).',
    ],
    methodsTopic: 'loadings_vs_scores',
  },


  group_stats: {
    title: 'Standard Deviation And Group Statistics',
    text: [
      'Standard deviations here are sample values, dividing by n-1.',
      'Eta-squared is the share of variance accounted for by group membership. Comparing by a column with one row per group is refused: eta-squared would be exactly 1.000 by construction.',
      'Omega-squared is the same quantity corrected for the upward bias that grows with the number of groups, and is the one to prefer when there are many.',
    ],
    methodsTopic: 'eta_squared',
  },

  missing_value_codes: {
    title: 'Missing Value Codes',
    text: [
      'This app flags values that are shaped like traditional sentinel codes AND sit oddly in their column by being far outside it, the wrong sign for it, or leaving a hole in a short scale.',
      'Each flag carries how sure the detector is. Certain means the value cannot be a measurement in that column, or sits an order of magnitude outside it; likely and possible mean the shape is suggestive.',
      'It also checks whether the same rows carry a code across several columns and says how much more often than chance that happens.',
      '**Two cases cannot be detected:** a code that falls inside the range of real values, and a negative code in a variable that is negative anyway. Declaring the code yourself covers both.',
    ],
    methodsTopic: 'sentinel_detection',
  },

  scree_full_spectrum: {
    title: 'Scree Full Spectrum',
    text: [
      'The scree chart draws every component, with the ones you kept solid and the rest faded.',
    ],
    more: [
      'Kaiser is only shown for a standardized run, where each variable contributes exactly 1.',
    ],
    methodsTopic: 'how_many_components',
  },

  aspect_mode: {
    title: 'Cube Or True Scale',
    text: [
      'True scale is the default. Each axis is proportional to its data range, so one unit has the same length along every axis.',
      'Cube draws all three axes at equal length. When their data ranges differ, a unit occupies a different length on each axis.',
    ],
    more: [
      'Neither changes the data, the clustering or any number reported — only the shape of the box the points are drawn in. Distances judged by eye are only comparable across axes on True scale.',
      'Pins remember the setting they were taken under, and exports match whatever is on screen.',
    ],
    methodsTopic: 'pca_interpretation',
  },

  diagnostics_sampled: {
    title: 'Diagnostics Are Sampled',
    text: [
      'Silhouette-by-k and the k-distance curve are O(n squared), so on large tables they are computed on a capped sample of rows (1,200 and 2,000 respectively) while the clustering itself runs on everything.',
      'The sample is random but seeded, so repeated runs agree.',
    ],
    methodsTopic: 'silhouette',
  },
} as const satisfies Record<string, Disclosure>;

export type DisclosureKey = keyof typeof DISCLOSURES;

/**
 * The one formatting device disclosure lines carry: **emphasis**. Split into
 * segments for the render sites (InfoDialog, InfoTip) so the strings stay
 * plain data here — no React, no markdown pipeline for two asterisks.
 */
export const emphasisSegments = (line: string): { text: string; bold: boolean }[] =>
  line.split('**').map((text, i) => ({ text, bold: i % 2 === 1 })).filter(s => s.text !== '');

/** The same line with the emphasis markers stripped, for plain-text `title`s. */
export const plainLine = (line: string): string => line.replaceAll('**', '');

export const disclosure = (key: DisclosureKey): Disclosure => DISCLOSURES[key];

/** Ordered for an information page; grouped by where they apply in the app. */
export const DISCLOSURE_SECTIONS: { heading: string; keys: DisclosureKey[] }[] = [
  { heading: 'Privacy', keys: ['data_modes'] },
  { heading: 'Missing Data', keys: ['median_imputation', 'missing_value_codes'] },
  { heading: 'PCA', keys: ['standardize_pca', 'pca_loadings', 'scree_full_spectrum'] },
  {
    heading: 'Clustering',
    keys: ['clusters_plotted_axes', 'kmeans_deterministic', 'dbscan_parameters', 'standardize_clustering', 'diagnostics_sampled'],
  },
  { heading: 'Statistics', keys: ['group_stats', 'statistical_tests'] },
  { heading: 'The Plot Itself', keys: ['aspect_mode'] },
];
