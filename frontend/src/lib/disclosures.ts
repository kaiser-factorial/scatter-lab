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
// No Markdown: these strings are rendered as plain text in both surfaces, so
// asterisks and backticks would show up literally.

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
    title: 'Assistant Access: Private vs Public Mode',
    text: [
      'Each dataset carries a data mode, chosen when it is added, that sets what the assistant may see of it.',
      'In both modes the assistant gets column names, aggregate summaries, and the results of analyses it runs — and everything else (parsing, PCA, clustering, exports) computes in the browser without uploading the dataset anywhere.',
      'The difference is raw data. **Private mode** (the default) stops at aggregates: never raw rows, never category values covering fewer than 5 rows, never identifier columns. **Public mode**, which you must explicitly confirm, additionally lets the assistant read raw rows and full category lists.',
      'If any loaded dataset is private, the whole conversation runs at the private level: the row-reading tools do not exist for that conversation.',
    ],
    more: [
      'The 5-row rule is the usual small-cell threshold in statistical disclosure control: a value covering 80 rows describes a group, a value covering one row is that person.',
      'The boundary is enforced where the data leaves the app, not by asking the assistant to behave: in Private mode the row-reading tools are not offered to the model at all.',
      'Switching a dataset from open back to private clears the assistant conversation, because a transcript that already contains rows cannot be redacted after the fact.',
      'Whatever the assistant does see is sent to the model API you configured, with your key. With a local runtime (Ollama, LM Studio) as the endpoint, even that never leaves your machine.',
    ],
  },

  statistical_tests: {
    title: 'The Analyze Tools',
    text: [
      'The assistant can run five tests (Welch\'s t, Mann–Whitney U, Kruskal–Wallis, two-sample Kolmogorov–Smirnov, chi-square) and draw seven chart types (ECDF, histogram, box, violin, Q–Q, bar, line over time), all computed in the browser — just ask, e.g. "run a t test comparing X between groups A and B".',
      'Results report the exact p-value with an effect size and, for the t-test, a 95% confidence interval — the p is bolded below 0.05, and no significance stars are used anywhere.',
      'Every request passes the same deterministic checks first (column types, group sizes, category limits, the data mode), and a rejected request tells the assistant exactly what to change.',
      'In Private mode, category values covering fewer than 5 rows stay withheld here too: charts pool them as an unlabeled "(rare values)" bucket or omit them with a note.',
    ],
    more: [
      'Welch\'s t is the default over Student\'s t because it does not assume equal variances and costs essentially nothing when they are equal (Delacre, Lakens & Leys 2017).',
      'Exact p-values without stars follow the ASA statement on p-values (Wasserstein & Lazar 2016): a p measures compatibility with "no difference", while the effect size measures how much difference — report both, dichotomize neither.',
      'These are single tests on data you chose to look at. Run many comparisons and some will be "significant" by chance; treat exploratory p-values as leads to confirm, not conclusions.',
      'Histograms share bin edges across groups, bars anchor at zero and distribution charts do not, and violins use a Gaussian kernel density (Silverman\'s bandwidth) — plotting conventions applied consistently so charts stay comparable.',
    ],
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
    more: [
      'This tool guarantees reproducibility, not evidence of stable structure. To test whether the clusters are stable, vary k and re-run on subsamples rather than re-running unchanged.',
    ],
    methodsTopic: 'kmeans_interpretation',
  },

  dbscan_parameters: {
    title: 'Eps And Min-Samples',
    text: [
      'A point is a core point when at least "min samples" points lie within distance eps, counting itself. Clusters grow from connected core points; anything left over is labelled Noise.',
      'eps is in the units of the plotted axes — or in standard deviations when Standardize is on.',
    ],
    more: [
      'Too small fragments the data into Noise; too large merges everything into one cluster.',
      'Counting the point itself is the standard convention — both scikit-learn and the original Ester et al. definition do it — but tutorials often describe min samples as neighbours excluding the point, which is a common source of off-by-one disagreement between tools.',
    ],
    methodsTopic: 'dbscan_interpretation',
  },

  median_imputation: {
    title: 'How Missing Values Are Handled',
    text: [
      "Median imputation fills each gap with that variable's median.",
      'Iterative PCA reconstructs each gap from the low-rank structure of the other variables and repeats until the fill settles (the missMDA imputePCA method).',
      'Complete cases drops any row with a missing value.',
      'Clustering always median-imputes.',
    ],
    more: [
      'Median imputation is simple, but it ignores the correlation structure and shrinks variance.',
      "Iterative PCA is better when variables are correlated, but it can be biased when there are many gaps. On this app's own test it recovers punched-out iris values with about half the error of the median, though it is marginally worse on noise (uncorrelated variables).",
      'Complete cases keeps the covariance honest but reduces n and could bias the sample.',
      'All three are single imputation, so none of them carry the uncertainty of the filled values into what follows; with substantial missingness, run more than one and compare.',
      'Every run reports what it filled or dropped, and in which variables.',
    ],
    methodsTopic: 'pca_caveats',
  },

  clusters_plotted_axes: {
    title: 'Clustering Uses The Plotted Axes',
    text: [
      'Clustering runs on the two or three columns currently assigned to X, Y and Z — nothing else.',
    ],
    more: [
      'Choosing the axes is therefore choosing the features. That is a good fit for PC scores, and a weak one for two arbitrary raw columns, where the result describes only those two variables.',
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
    more: [
      'ON is the right choice when scales differ, which is most questionnaire data.',
      'The two can give very different answers. Report which you used.',
    ],
    methodsTopic: 'standardize_or_not',
  },

  standardize_clustering: {
    title: 'Standardizing Before Clustering',
    text: [
      'Z-scoring gives every variable equal weight in the distance.',
      'Suggested ON for mixed scales, for example age alongside Likert items.',
      'OFF for PC scores — their declining variance is the point of PCA.',
      'OFF by default for items sharing a response scale, where variance differences are themselves signal.',
    ],
    methodsTopic: 'standardize_clustering',
  },

  pca_loadings: {
    title: 'PCA Loadings',
    text: [
      'The numbers shown are unit-norm eigenvector weights (the quantity scikit-learn calls components_).',
    ],
    more: [
      'In psychometrics, "loading" often means the variable-component correlation instead, which is this value scaled by the square root of the eigenvalue; the familiar "above 0.3 to 0.4 is meaningful" rule of thumb refers to that other quantity.',
      'Signs are relative: a component and its mirror image are the same component.',
    ],
    methodsTopic: 'loadings_vs_scores',
  },

  variance_explained: {
    title: 'Variance Explained',
    text: [
      "Each bar in the variance breakdown is that component's share of the total variance across all the variables you selected.",
    ],
    more: [
      'Only the components you chose to keep appear here, so this breakdown cannot be used to pick how many to keep — for that, see the scree chart, which draws the full spectrum.',
    ],
    methodsTopic: 'how_many_components',
  },

  group_stats: {
    title: 'Standard Deviation And Group Statistics',
    text: [
      'Standard deviations here are sample values, dividing by n-1.',
      'Eta-squared is the share of variance accounted for by group membership.',
      'Omega-squared is the same quantity corrected for the upward bias that grows with the number of groups, and is the one to prefer when there are many.',
      'Comparing by a column with one row per group is refused: eta-squared would be exactly 1.000 by construction.',
    ],
    more: [
      'Both are descriptive effect sizes, not significance tests, and a sizable value can be driven by one small extreme group — so always read them alongside the per-group means and ns.',
    ],
    methodsTopic: 'eta_squared',
  },

  missing_value_codes: {
    title: 'Missing Value Codes',
    text: [
      "This app flags values that are shaped like traditional sentinel codes AND sit oddly in their column — far outside it, the wrong sign for it, or leaving a hole in a short scale — but it never removes them: which code means what is your knowledge, not the app's.",
      'Each flag carries how sure the detector is. Certain means the value cannot be a measurement in that column, or sits an order of magnitude outside it; likely and possible mean the shape is suggestive, and possible boxes are not ticked for you.',
      'It also checks whether the same rows carry a code across several columns, the signature of a respondent choosing "Don\'t Know" through a whole battery of items, and says how much more often than chance that happens.',
      'Two cases cannot be detected — a code that falls inside the range of real values, and a negative code in a variable that is negative anyway. Declaring the code yourself covers both.',
    ],
    more: [
      'SPSS, Qualtrics and most survey platforms write "refused" or "not applicable" as out-of-range numbers — -99, -999, 9999 — and a CSV carries no sign of that alternate meaning. Read as measurements, they land in means, correlations, the PCA and the distances used for clustering.',
      'If a flagged value is a code, replace it with a blank before analysing.',
      'The tiers are honest about a boundary the detector cannot resolve from one column alone: a short Likert item carrying a Don\'t Know code and a skewed count with a real value in its tail are the same shape. What separates them here is how many people the value accounts for — a response option gets picked, a rare real value does not — which is a heuristic, not a law.',
      'The cross-column check compares the code\'s rows against what independence would predict from the counts, per column rather than for the group, so a real 9 in one variable is not swept along by a Don\'t Know block running through twenty others. It only ever raises confidence: a survey may use a code in exactly one item, so the absence of a pattern is not evidence against one.',
      'Where a codebook exists, it beats all of this — .sav and .dta files declare their missing values outright, and a CSV export throws that away.',
    ],
    methodsTopic: 'survey_data_notes',
  },

  scree_full_spectrum: {
    title: 'Scree Full Spectrum',
    text: [
      'The scree chart draws every component, with the ones you kept solid and the rest faded.',
    ],
    more: [
      'The two rules the methods reference describes both need the full spectrum: the Cattell elbow is invisible if the chart stops at the elbow, and the Kaiser eigenvalue-above-1 count needs every eigenvalue.',
      'Kaiser is only shown for a standardized run, where each variable contributes exactly 1.',
    ],
    methodsTopic: 'how_many_components',
  },

  aspect_mode: {
    title: 'Cube Or True Scale',
    text: [
      'Cube (the default) draws the 3-D box with equal-length axes, so each axis is stretched by whatever factor its own data span needs. One unit along X is not the same length as one unit along Y, and the tick spacing is not comparable between axes.',
      'True scale makes each axis length proportional to its own span, so a unit is the same length everywhere.',
    ],
    more: [
      'Cube is the default because it always fits the canvas and orbits evenly. A box proportional to the data can be long and thin, which swings its apparent size as it rotates and can run off the edge.',
      'Neither changes the data, the clustering or any number reported — only the shape of the box the points are drawn in. Distances judged by eye are only comparable across axes on True scale.',
      'Pins remember the setting they were taken under, and exports match whatever is on screen.',
    ],
    methodsTopic: 'pca_interpretation',
  },

  diagnostics_sampled: {
    title: 'Diagnostics Are Sampled',
    text: [
      'Silhouette-by-k and the k-distance curve are O(n squared), so on large tables they are computed on a capped sample of rows (1,200 and 2,000 respectively) while the clustering itself runs on everything.',
      'The sample is random but seeded, so repeated runs agree. Random rather than evenly spaced, because a fixed step lands on one stratum of any file ordered by wave, block or condition.',
    ],
    more: [
      'Treat them as a starting point for choosing parameters rather than an exact answer.',
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
  { heading: 'PCA', keys: ['standardize_pca', 'pca_loadings', 'variance_explained', 'scree_full_spectrum'] },
  {
    heading: 'Clustering',
    keys: ['clusters_plotted_axes', 'kmeans_deterministic', 'dbscan_parameters', 'standardize_clustering', 'diagnostics_sampled'],
  },
  { heading: 'Statistics', keys: ['group_stats', 'statistical_tests'] },
  { heading: 'The Plot Itself', keys: ['aspect_mode'] },
];
