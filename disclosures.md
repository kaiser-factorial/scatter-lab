
# DISCLOSURES
## 'K-Means is reproducible, not optimized',

### This app seeds K-Means with k-means++ from fixed seeds and keeps the lowest-inertia of 10 fixed starts (up to 300 iterations each). It does not search for the global optimum. The same data and the same k therefore always give byte-identical clusters in this app. 
### Another tool, or another set of starts, may well land somewhere else. This tool guarantees reproducibility, not evidence of stable structure. To test whether the clusters are stable, vary k and re-run on subsamples rather than re-running unchanged.
###### 'kmeans_interpretation',

## eps and min-samples
### A point is a core point when at least "min samples" points lie within distance eps, counting itself. Clusters grow from connected core points; anything left over is labelled Noise. eps is in the units of the plotted axes — or in standard deviations when Standardize is on. 
#### Too small fragments the data into Noise; too large merges everything into one cluster.',

###### 'dbscan_interpretation',
##### this feels more like methodology... why is it in disclosures? nothing here is nonstandard. oh, unless you mean the "counting itself"? is this nonstandard? because if so, i would prefer to just adjust it to the standard rather than keep it in disclosures.


## 'How missing values are handled',

### 'Three options:
1. Median imputation: fills each gap with that variable\'s median. 
2. Iterative PCA: reconstructs each gap from the low-rank structure of the other variables and repeats until the fill settles (the missMDA imputePCA method).
3. Complete cases: drops any row with a missing value.
### NOTE: Clustering always median-imputes.
#### Median impute is simple, but it ignores the correlation structure and shrinks variance.
#### Iterative PCA is better when variables are correlated, but it can be biased when there are many gaps. On this app\'s own test, it recovers punched-out iris values with about half the error of the median, though it is marginally worse when tested on noise (uncorrelated variables).
#### Complete cases keeps the covariance honest but reduces n and could potentially bias the sample. 
#### All three are single imputation, so none of them carry the uncertainty of the filled values into what follows; with substantial missingness, run more than one and compare. Every run reports what it filled or dropped and in which variables. 

###### 'pca_caveats',


## 'Clustering uses the plotted axes',

### 'Clustering runs on the two or three columns currently assigned to X, Y and Z — nothing else. 
#### Choosing the axes is therefore choosing the features. That is a good fit for PC scores, and a weak one for two arbitrary raw columns, where the result describes only those two variables.
###### 'standardize_clustering',

## 'Standardizing before PCA',

### 'ON: each variable is z-scored first, making this a correlation-based PCA where every variable carries equal weight. 
#### This is the right choice when scales differ, which is most questionnaire data. 
### OFF: covariance-based, where high-variance variables dominate the components. 
#### The two can give very different answers. Report which you used.
###### 'standardize_or_not',

## 'Standardizing before clustering',

### 'Z-scoring gives every variable equal weight in the distance. 
### Suggested ON for mixed scales (eg age alongside likert items),
### OFF for PC scores — their declining variance is the point of PCA, and
### OFF by default for items sharing a response scale, where variance differences are themselves signal. 
###### 'standardize_clustering',

## 'PCA Loadings',

### 'The numbers shown are unit-norm eigenvector weights (scikit-learn's "components_"). 
#### Note that in psychometrics, "loading" often means the variable-component correlation instead, which is this value scaled by the square root of the eigenvalue; the familiar "above 0.3–0.4 is meaningful" rule of thumb refers to that other quantity. 
#### Signs are relative: a component and its mirror image are the same component.
###### 'loadings_vs_scores',


## 'Variance Explained',

### 'Each bar is that component\'s share of the total variance across all the variables **you selected**. 
#### Only the components you chose to keep are shown, so this chart cannot be used to pick how many to keep — for that you want the full spectrum.
###### 'how_many_components',
##### This contradicts our scree plot disclosure later -- which is true?

## 'Standard Deviation & Group Statistics',

### 'Standard deviations here are sample values, dividing by n-1.
### Eta-squared is the share of variance accounted for by group membership; 
### omega-squared is the same quantity corrected for the upward bias that grows with the number of groups, and is the one to prefer when there are many. 
#### Both are descriptive effect sizes, not significance tests, and a sizable value can be driven by one small extreme group — so always read them alongside the per-group means and ns. 
### Comparing by a column with one row per group is refused: eta-squared would be exactly 1.000 by construction.',
###### 'eta_squared',

## 'Missing Value Codes',
#### 'SPSS, Qualtrics and most survey platforms write "refused" or "not applicable" as out-of-range numbers — -99, -999, 9999 — and a CSV carries no sign of alternate semantic meaning. Read as measurements they land in means, correlations, the PCA and the distances used for clustering. 
### This app flags values that are shaped like traditional sentinel codes AND sit far outside the rest of their column, but it **never removes them**: which code means what is your knowledge, not the app\'s. 
#### If a flagged value is a code, replace it with a blank before analysing. 
### Two cases cannot be detected — a code that falls inside the range of real values, and a negative code in a variable that is negative anyway.
###### 'survey_data_notes',
##### perhaps we should add an option where, if your dataset is flagged as potentially having sentinels, we can replace them with NaNs? (This could happen upon import) -- also, my Qualtrics survey used "9" (or 99) for "Don't Know"/"Unsure"... perhaps we should wire these vals up too *with a check for being out of range*... remind me to send you the matlab script i was using which had a similar sort of check. 

## 'Scree Full Spectrum',
### 'All components are drawn, with the ones you kept solid and the rest faded.
#### The two rules the methods reference describes both need the full spectrum: 
#### the Cattell elbow is invisible if the chart stops at the elbow, and the Kaiser eigenvalue-above-1 count needs every eigenvalue. 
#### Kaiser is only shown for a standardized run, where each variable contributes exactly 1.',
###### 'how_many_components',

## 'Diagnostics are Sampled',
### 'Silhouette-by-k and the k-distance curve are O(n squared), so on large tables they are computed on a capped sample of rows (1,200 and 2,000 respectively) while the clustering itself runs on everything. 
### The sample is random but seeded, so repeated runs agree — an evenly-spaced sample would land on one stratum of any file ordered by wave, block or condition. 
#### Treat them as a starting point for choosing parameters rather than an exact answer.',
### 'silhouette'
##### I thought we fixed the stratum situation?

