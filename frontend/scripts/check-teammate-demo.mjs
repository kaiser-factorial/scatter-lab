import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const url = new URL(process.argv[2] ?? 'http://localhost:3000');
if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Expected an HTTP preview URL');
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const dock = process.argv.includes('--float') ? 'float' : process.argv.includes('--bottom') ? 'bottom' : 'right';
  await page.addInitScript(({ dock, theme }) => {
    localStorage.setItem('scatterlab.assistant.dock', dock);
    localStorage.setItem('theme', theme);
  }, { dock, theme: process.argv.includes('--terminal') ? 'terminal' : 'primary' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url.href);
  const button = name => page.getByRole('button', { name: new RegExp(`${name}$`, 'i') });
  const divider = page.getByRole('separator', { name: 'Control panel width' });
  await expect(divider).toBeVisible({ timeout: 60000 });
  await divider.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '336');
  const bounds = await divider.boundingBox();
  await page.mouse.move(bounds.x + 3, 120);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 43, 120);
  await page.mouse.up();
  await expect(divider).toHaveAttribute('aria-valuenow', '376');
  await button('Collapse the menu').click();
  await button('Expand the menu').click();
  await expect(divider).toHaveAttribute('aria-valuenow', '376');

  let irisImports = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/demo/iris.csv') irisImports++; });
  await page.getByRole('button', { name: /^(> )?load demo$/i }).click();
  await expect(page.locator('[data-guide="datasets-list"]')).toContainText(/iris/i);
  const openingScene = () => page.locator('#active-plot').evaluate(g => {
    const scene = g._fullLayout?.scene;
    return scene && { aspect: scene.aspectmode, eye: scene.camera.eye };
  });
  const startView = { aspect: 'data', eye: { x: 0.94, y: -3.26, z: 1.01 } };
  await expect.poll(openingScene).toEqual(startView);
  const home = page.locator('#active-plot').getByRole('button', {name: 'Reset camera to default', exact: true});
  await page.locator('#active-plot').hover();
  await home.click();
  await expect.poll(openingScene).toEqual(startView);
  const begin = button('Begin demo walkthrough');
  const loaded = page.locator('details').filter({ has: page.locator('summary', { hasText: /^Iris demo loaded$/ }) });
  const notes = page.getByRole('button', { name: 'Expand Notes', exact: true });
  const overlay = page.locator('.notes-overlay');
  const grip = page.getByRole('slider', { name: 'Move Notes' });
  const pane = page.locator('[data-panes="1"] > div > div').first();
  await expect(begin).toBeVisible();
  await expect(notes).toBeVisible();
  const checkPlotInsets = async () => {
    // Read all three rectangles in one frame as the bottom dock settles.
    const [frameBox, plotBox, overlayBox] = await page.locator('.plot-grid-frame').evaluate(frame => [
      frame, frame.querySelector('[data-panes="1"] > div > div'), document.querySelector('.notes-overlay'),
    ].map(element => element.getBoundingClientRect().toJSON()));
    assert.deepEqual(overlayBox, frameBox, 'Notes overlays the plot frame without reserving a column');
    assert.ok(plotBox.x - frameBox.x >= 12 && plotBox.y - frameBox.y >= 12, 'left/top padding');
    assert.ok(frameBox.x + frameBox.width - plotBox.x - plotBox.width >= 12, 'right padding');
    assert.ok(frameBox.y + frameBox.height - plotBox.y - plotBox.height >= 12, 'bottom padding');
  };
  await checkPlotInsets();
  const start = await notes.boundingBox();
  const closedPlot = await pane.boundingBox();
  await expect(notes).toHaveCSS('cursor', 'pointer');
  await expect(grip).toHaveCSS('opacity', '0');
  await notes.hover();
  await expect(grip).toHaveCSS('opacity', '1');
  await expect(grip).toHaveCSS('cursor', 'ns-resize');
  const handle = await grip.boundingBox();
  const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 96, { steps: 8 });
  await page.mouse.up();
  await expect(notes).toHaveAttribute('aria-expanded', 'false');
  const after = await notes.boundingBox();
  assert.ok(Math.abs(after.y - start.y - 96) < 2 && after.x === start.x, 'Notes drags only vertically');
  await notes.click();
  const text = page.getByRole('textbox', { name: 'Notes', exact: true });
  await text.fill('Petal length and width');
  const collapseNotes = page.getByRole('button', { name: 'Collapse Notes', exact: true });
  await grip.press('End');
  const lower = await collapseNotes.boundingBox(), boundsRail = await overlay.boundingBox();
  assert.ok(Math.abs(lower.y + lower.height - boundsRail.y - boundsRail.height) < 2, 'tab stays within the divider');
  await checkPlotInsets();
  assert.deepEqual(await pane.boundingBox(), closedPlot, 'opening Notes keeps the plot at the same size');
  await grip.press('ArrowUp');
  assert.ok(Math.abs(lower.y - (await collapseNotes.boundingBox()).y - 24) < 2);
  await collapseNotes.press('Enter');
  await notes.press('Space');
  await expect(text).toHaveValue('Petal length and width');
  await grip.press('Home');
  await collapseNotes.click();
  console.log('Verified Notes overlay sizing, separate grip, keyboard movement and retained text.');
  const irisFile = await readFile(new URL('../public/demo/iris.csv', import.meta.url), 'utf8');
  const [header, ...lines] = irisFile.trim().split(/\r?\n/);
  const headers = header.split(',');
  async function checkIrisAxes(height, depth) {
    const graph = page.locator('#active-plot');
    await expect.poll(() => graph.evaluate(g => g._fullLayout?.scene?.zaxis.title.text)).toBe(height);
    await expect.poll(() => graph.evaluate(g => g._fullLayout?.scene?.yaxis.title.text)).toBe(depth);
    const traces = await graph.evaluate(g => g.data.filter(t => t.type === 'scatter3d' && t.hoverinfo !== 'skip')
      .map(t => ({ name: t.name, height: Array.from(t.z), depth: Array.from(t.y), hover: t.hovertemplate })));
    assert.equal(traces.reduce((n, trace) => n + trace.height.length, 0), 150);
    for (const trace of traces) {
      const rows = lines.map(line => line.split(',')).filter(row => row[headers.indexOf('Species')] === trace.name);
      assert.deepEqual(trace.height, rows.map(row => Number(row[headers.indexOf(height)])));
      assert.deepEqual(trace.depth, rows.map(row => Number(row[headers.indexOf(depth)])));
      assert.ok(trace.hover.includes(height + ': %{z:.2f}') && trace.hover.includes(depth + ': %{y:.2f}'));
    }
    const floor = await graph.evaluate(g => g.data.find(t => t.type === 'mesh3d').z);
    assert.ok(floor.every(z => z === floor[0]) && floor[0] < Math.min(...traces.flatMap(t => t.height)));
  }
  await checkIrisAxes('PetalWidthCm', 'SepalLengthCm');
  await expect(begin).toBeVisible();
  await expect(begin).toHaveCSS('background-color', 'rgb(255, 214, 0)');
  await expect(loaded).not.toHaveAttribute('open', '');
  await expect(page.getByText('Welcome to', { exact: false }).filter({ visible: true })).toHaveCount(0);
  await expect(button('Start with the Data section')).toHaveCount(0);
  await loaded.locator('summary').press('Enter');
  await expect(loaded.locator('p')).toBeVisible();
  await loaded.locator('summary').press('Space');
  await expect(loaded.locator('p')).toBeHidden();
  await begin.press('Enter');
  await expect(page.getByText('Settings applied', { exact: true })).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: 'Settings applied' }).locator('..')).not.toHaveAttribute('open', '');
  await expect(page.getByText(/We’ve loaded the/)).toBeVisible();
  const minimize = page.getByTitle('Minimize — your conversation is kept', { exact: true });
  const reopen = page.getByTitle('Open the walkthrough panel', { exact: true });
  await expect(minimize).toBeVisible();
  const plotFrame = page.locator('.plot-grid-frame');
  const welcomeFrame = await plotFrame.boundingBox();
  assert.equal(irisImports, 1);
  const backTo = title => page.getByRole('button', { name: 'Previous step: ' + title, exact: true });
  const completedWork = () => page.evaluate(() => {
    const snapshot = window.__scatterlabBridge?.current.snapshot();
    return snapshot && {
      pins: snapshot.pinnedViews.map(pin => pin.id),
      datasets: snapshot.datasets.map(d => ({ id: d.id, columns: d.table.columns, records: d.provenance?.length,
        pca: d.pcaRuns?.map(run => run.savedAt), efa: d.efa?.runs.map(run => run.id) })),
    };
  });
  await expect(page.getByRole('button', { name: /^Previous step:/ })).toHaveCount(0);
  for (const label of ['Start with the Data section', 'Look at the variables', 'Run a PCA on the measurements', 'Cluster the PC scores']) {
    if (label === 'Cluster the PC scores') {
      const controls = page.locator('[data-scatter-section="cluster"]');
      const trigger = controls.locator('.px-accordion-trigger, header button').first();
      if (await trigger.getAttribute('aria-expanded') === 'false') await trigger.click();
      const methods = controls.getByRole('group', { name: 'Clustering method' });
      const kmeans = methods.getByRole('radio', { name: 'K-means', exact: true });
      await expect(kmeans).toBeChecked();
      await expect(methods.getByRole('radio')).toHaveCount(2);
      const k = controls.getByRole('group', { name: 'K (clusters)' });
      await k.getByRole('button', { name: 'Decrease K (clusters)' }).click();
      await expect(k.getByRole('status')).toHaveText('2');
      await expect(k.getByRole('button', { name: 'Decrease K (clusters)' })).toBeDisabled();
      await k.getByRole('button', { name: 'Increase K (clusters)' }).press('Enter');
      await expect(k.getByRole('status')).toHaveText('3');
      await methods.getByRole('radio', { name: 'DBSCAN', exact: true }).check();
      await expect(controls.getByRole('slider', { name: 'Epsilon' })).toBeVisible();
      await expect(controls.getByRole('spinbutton', { name: 'eps value' })).toBeVisible();
      const samples = controls.getByRole('group', { name: 'Min samples' });
      await samples.getByRole('button', { name: 'Increase Min samples' }).press('Space');
      await expect(samples.getByRole('status')).toHaveText('6');
      await samples.getByRole('button', { name: 'Decrease Min samples' }).click();
      await expect(samples.getByRole('status')).toHaveText('5');
      await expect(controls.locator('[data-guide="cluster-breakdown"]')).toHaveCount(0);
      // Start with the section collapsed to catch a pointer that only rings its header.
      const expanded = page.locator('[data-scatter-section="cluster"] button[aria-expanded="true"]').first();
      if (await expanded.count()) await expanded.click();
    }
    await button(label).click({ timeout: 30000 });
    const irisArrow = page.locator('[data-guide="datasets-list"] button').filter({ hasText: /^iris$/i }).locator('.demo-iris-pointer');
    if (label === 'Start with the Data section') {
      const tip = page.getByRole('dialog', { name: 'Data', exact: true });
      await expect(tip.locator('p').nth(1)).toHaveText('For this demo, we’ve loaded the Iris dataset for you.');
      await expect(irisArrow).toBeVisible();
      await expect(reopen).toBeVisible();
      await expect(minimize).toHaveCount(0);
      const expandedFrame = await plotFrame.boundingBox();
      if (dock === 'right') assert.ok(expandedFrame.width > welcomeFrame.width + 150);
      if (dock === 'bottom') assert.ok(expandedFrame.height > welcomeFrame.height + 150);
      if (dock === 'float') assert.deepEqual(expandedFrame, welcomeFrame);
      const originalTip = await tip.elementHandle();
      await reopen.click();
      await expect(minimize).toBeVisible();
      await expect(tip).toBeVisible();
      await minimize.click();
      await expect(reopen).toBeVisible();
      assert.ok(await originalTip.evaluate(el => el.isConnected), 'the same bubble survives opening and closing the panel');
      await expect(tip.getByRole('button', { name: /Next:/ })).toBeFocused();
    }
    if (label === 'Cluster the PC scores') {
      const tip = page.getByRole('dialog', { name: 'Clustering', exact: true });
      const breakdown = page.locator('aside [data-guide="cluster-breakdown"]');
      await expect(tip).toHaveAttribute('data-walkthrough-target', 'cluster-breakdown');
      await expect(tip).toContainText('Cluster Info by → Species');
      await expect(breakdown.getByRole('combobox', { name: 'Cluster Info by' })).toHaveValue('Species');
      await expect(breakdown.getByRole('button', { name: '% of cluster' })).toHaveAttribute('aria-pressed', 'true');
      const clusters = breakdown.getByRole('group');
      await expect(clusters).toHaveCount(3);
      await expect(clusters.first()).toBeInViewport();
      let flowers = 0;
      for (const cluster of await clusters.all()) {
        const rows = (await cluster.innerText()).split('\n');
        const size = Number(rows.shift().match(/n=(\d+)/)[1]);
        let counted = 0;
        for (const match of rows.join(' ').matchAll(/(\d+)%\s*\((\d+)\)/g)) {
          const percent = Number(match[1]);
          const count = Number(match[2]);
          assert.equal(percent, Math.round(100 * count / size));
          counted += count;
        }
        assert.equal(counted, size);
        flowers += size;
      }
      assert.equal(flowers, 150);
      console.log('Verified the sidebar species counts and within-cluster percentages across all 150 flowers.');
    }
    if (label === 'Run a PCA on the measurements') {
      await expect(page.getByLabel('Missing values', { exact: true })).toBeDisabled();
      const about = page.getByRole('dialog', { name: 'About Scatter Lab and its methods' });
      const analyze = page.getByRole('button', { name: 'Analyze selected items', exact: true });
      const tooltip = page.getByRole('button', { name: 'About method guidance', exact: true });
      await tooltip.click();
      await expect(page.getByRole('tooltip')).toHaveText('About method guidanceProfiles the selected items in the current fitting sample. Measurement levels are suggestions until confirmed.');
      await tooltip.press('Escape');
      await analyze.click();
      const guidance = page.getByRole('region', { name: 'Item and method guidance' });
      await expect(guidance).toContainText('4 items · 150 fitting rows');
      await expect(guidance).not.toContainText(/numeric appearance|PCA of the numeric item values|separate EFA extraction|Tukey/);
      const assessment = guidance.getByRole('button', { name: 'How this was assessed' });
      await assessment.press('Enter');
      await expect(about.getByRole('heading', { name: 'How selected items are assessed' })).toBeVisible();
      await expect(about).toContainText('at least 20 observed numeric values');
      await about.getByRole('button', { name: 'Close', exact: true }).press('Escape');
      await expect(assessment).toBeFocused();
      await expect(guidance).toContainText('4 items · 150 fitting rows');
      await page.getByRole('button', { name: 'About Scatter Lab', exact: true }).click();
      await about.getByRole('button', { name: 'Item assessment' }).click();
      await expect(about.getByRole('heading', { name: 'How selected items are assessed' })).toBeVisible();
      await about.getByRole('button', { name: 'Close', exact: true }).click();
      console.log('Verified the Iris item profile, compact tooltip, both paths into About, and keyboard return to the results.');
    }
    if (label === 'Look at the variables') {
      await expect(irisArrow).toBeHidden();
      const variablesTip = page.getByRole('dialog', { name: 'Variables', exact: true });
      await expect(variablesTip.locator('li')).toHaveText(['X, Y, Z — axis variables', 'C — marker color', 'S — marker shape']);
      await backTo('Data').press('Enter');
      await expect(irisArrow).toBeVisible();
      await backTo('Welcome').click();
      await expect(minimize).toBeVisible();
      await expect(page.getByRole('button', { name: /^Previous step:/ })).toHaveCount(0);
      await button('Next: Data').click();
      await expect(reopen).toBeVisible();
      await button('Next: Variables').click();
      await expect(variablesTip).toBeVisible();
      await page.getByTitle('Plot SepalWidthCm on the Y axis', { exact: true }).click();
      await page.getByTitle('Plot PetalWidthCm on the Z axis', { exact: true }).click();
      await checkIrisAxes('SepalWidthCm', 'PetalWidthCm');
      await page.getByTitle('Plot PetalWidthCm on the Y axis', { exact: true }).click();
      await page.getByTitle('Plot SepalLengthCm on the Z axis', { exact: true }).click();
      await checkIrisAxes('PetalWidthCm', 'SepalLengthCm');
      const color = page.getByTitle('Color by Species', { exact: true });
      const shape = page.locator('button[title*="Species as marker shape"]');
      await expect(color).toHaveAttribute('aria-pressed', 'true');
      await expect(shape).toHaveAttribute('aria-pressed', 'false');
      const fill = await color.evaluate(button => getComputedStyle(button).backgroundColor);
      await shape.click();
      await expect(shape).toHaveAttribute('aria-pressed', 'true');
      await expect(shape).toHaveCSS('background-color', fill);
      await expect(color).toHaveAttribute('aria-pressed', 'true');
      await shape.press('Space');
      await expect(shape).toHaveAttribute('aria-pressed', 'false');
      await expect(shape).not.toHaveCSS('background-color', fill);
    }
  }
  const afterClustering = await completedWork();
  await expect(button('Load the synthetic survey')).toBeVisible();
  await expect(page.locator('[data-panes="1"]')).toBeVisible();
  await backTo('PCA').click();
  await backTo('Variables').click();
  await checkIrisAxes('PetalWidthCm', 'SepalLengthCm');
  await button('Next: PCA').click();
  await button('Next: Clustering').click();
  assert.deepEqual(await completedWork(), afterClustering, 'revisiting the Iris steps preserves the fit and clustering');
  const irisScores = await page.evaluate(() => {
    const snapshot = window.__scatterlabBridge?.current?.snapshot();
    const data = snapshot?.datasets.find(dataset => dataset.id === snapshot.activeId)?.table.data;
    return data && ['PC1', 'PC2', 'PC3'].map(name => data[name]);
  });
  if (irisScores) {
    const text = await readFile(new URL('../public/demo/iris.csv', import.meta.url), 'utf8');
    const rows = text.trimEnd().split('\n').slice(1).map(line => line.split(',').slice(1, 5).map(Number));
    const centers = rows[0].map((_, item) => rows.reduce((sum, row) => sum + row[item], 0) / rows.length);
    const scales = centers.map((mean, item) => Math.sqrt(rows.reduce((sum, row) => sum + (row[item] - mean) ** 2, 0) / rows.length));
    const numpySvd = [[0.5210659146701196, -0.2693474425059434, 0.5804130957962945, 0.5648565357793613], [-0.37741761556456704, -0.923295659540715, -0.024491609085586494, -0.06694198696805867], [0.719566352700817, -0.24438177951439893, -0.14212636933390388, -0.6342727371109228]];
    for (const [pc, vector] of numpySvd.entries()) {
      const expected = rows.map(row => vector.reduce((sum, weight, item) => sum + weight * (row[item] - centers[item]) / scales[item], 0));
      const actual = irisScores[pc];
      assert.equal(actual.length, expected.length);
      const sign = Math.sign(actual[0] * expected[0]);
      assert.ok(Math.max(...actual.map((value, row) => Math.abs(sign * value - expected[row]))) < 1e-7, `Iris PC${pc + 1} agrees with NumPy SVD`);
    }
    console.log('Compared all 150 Iris projections on PC1–PC3 with NumPy SVD (absolute tolerance 1e-7).');
  }
  const surveyTransition = page.getByRole('dialog', {name: 'Clustering', exact: true}).getByRole('button', {name: /synthetic survey/i});
  const primaryTheme = !process.argv.includes('--terminal');
  const sectionGreen = primaryTheme ? 'rgb(26, 122, 26)' : 'rgb(16, 255, 80)';
  await expect(surveyTransition).toHaveCSS('background-color', sectionGreen);
  const results = page.getByRole('dialog', { name: /EFA · DemoSurvey/ });
  const reference = JSON.parse(await readFile(new URL('../src/lib/__tests__/fixtures/efa/demo-development.reference.json', import.meta.url)));
  for (const label of ['Load the synthetic survey', 'See the survey split', 'Review EFA settings', 'Fit two factors with demo settings', 'Plot respondent scores', 'See the export options', 'Finish the walkthrough', 'Explore on my own']) {
    try { await (label === 'Plot respondent scores' ? results.getByRole('button', {name: label, exact: true}) : button(label)).click({ timeout: 30000 }); }
    catch (error) { throw new Error(`Tour stopped before ${label}. ${errors.join('; ')}\n${(await page.locator('body').innerText()).slice(-2200)}`, { cause: error }); }
    if (label === 'Load the synthetic survey') {
      if (primaryTheme) await expect(button('See the survey split')).toHaveCSS('background-color', 'rgb(255, 214, 0)');
      await expect(page.locator('[data-panes="1"]')).toBeVisible();
      await expect(backTo('Clustering')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Plot legend', includeHidden: true })).toBeHidden();
      const shape = page.locator('button[title*="Gender as marker shape"]');
      await shape.click();
      await expect(page.getByRole('region', {name: 'Plot legend'})).toBeVisible();
      await expect(page.getByRole('region', {name: 'Plot legend'})).toContainText('Gender');
      await shape.click();
      await expect(page.locator('[aria-label="Plot legend"]')).toBeHidden();
      const datasets = page.locator('[data-guide="datasets-list"]');
      await expect(datasets).toContainText(/iris/i);
      await expect(datasets.getByRole('button', { name: 'Synthetic survey · Development', exact: true })).toHaveAttribute('aria-current', 'true');
      await expect(page.getByText(/Both datasets are loaded/).first()).toBeVisible();
      await expect(page.locator('[data-guide="decomposition-setup"]')).toContainText('8/11 items');
      await expect(page.getByRole('checkbox', { name: 'Select ResponseID', exact: true })).not.toBeChecked();
      await expect(page.getByRole('checkbox', { name: 'Select Age', exact: true })).not.toBeChecked();
      await expect(page.getByRole('checkbox', { name: 'Select Gender', exact: true })).not.toBeChecked();
      const header = page.locator('[data-scatter-section="pca"]').locator('.px-accordion-trigger, header button').first();
      if (await header.getAttribute('aria-expanded') === 'true') await header.click();
    }
    if (label === 'See the survey split') {
      const split = page.getByRole('dialog', {name: 'Development / holdout'});
      await expect(split).toBeVisible();
      await expect(split).toContainText('We’ll fit the EFA on Development.');
      await expect(split).toContainText('Holdout stays locked.');
    }
    if (label === 'Review EFA settings') {
      const settings = page.locator('[data-guide="efa-settings"]');
      const tip = page.getByRole('dialog', { name: 'EFA settings', exact: true });
      await expect(tip).toHaveAttribute('data-walkthrough-target', 'efa-settings');
      await expect(tip).toContainText('Promax rotation');
      await expect(reopen).toBeVisible();
      await expect(page.getByRole('group', { name: 'Analysis method' }).getByRole('button', { name: 'EFA', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(settings.getByRole('spinbutton', { name: 'Factor count' })).toHaveValue('2');
      await expect(settings.getByLabel('EFA correlations')).toHaveValue('polychoric');
      await expect(settings.getByRole('radio', { name: 'MINRES', exact: true })).toBeChecked();
      await expect(settings.getByRole('radio', { name: 'Promax', exact: true })).toBeChecked();
      await expect(settings).toBeInViewport({ ratio: 0.9 });
      await expect(page.getByLabel('Missing values', { exact: true })).toBeDisabled();
      await expect(page.getByLabel('Missing values', { exact: true }).locator('option:checked')).toHaveText('No missing values');
      await expect(results).toHaveCount(0);
      const work = await completedWork();
      if (work) assert.equal(work.datasets.flatMap(dataset => dataset.efa ?? []).length, 0);
    }
    if (label === 'Fit two factors with demo settings') {
      await expect(minimize).toBeVisible();
      await expect(results).toContainText('1,050 fixed fitting rows', { timeout: 30000 });
      const plan = results.getByRole('row', { name: /^Plan\s*I make a plan/ });
      await expect(plan).toContainText('I make a plan before starting a task.');
      const displayed = (await plan.getByRole('cell').allTextContents()).slice(0, 2).map(Number);
      const strongest = Math.abs(displayed[0]) > Math.abs(displayed[1]) ? 0 : 1;
      await expect(results).toContainText(`Plan has its largest absolute loading on F${strongest + 1} (${displayed[strongest].toFixed(3)})`);
      await expect(results.getByRole('navigation', {name: 'EFA result views'}).getByRole('button')).toHaveCount(3);
      await expect(results.getByRole('combobox', {name: 'Loading matrix'})).toHaveValue('pattern');
      await expect(plan.getByRole('cell')).toHaveCount(3);
      await expect(results.getByRole('columnheader', {name: /Pattern abs Δ/})).toBeVisible();
      const delta = Number(await plan.getByRole('cell').last().innerText());
      assert.ok(Math.abs(delta - Math.abs(Math.abs(displayed[0]) - Math.abs(displayed[1]))) <= 0.0015);
      await expect(results.getByLabel('Review instrument')).not.toBeChecked();
      const guide = results.getByLabel('Walkthrough guide');
      const plotAction = guide.getByRole('button', {name: 'Plot respondent scores'});
      await expect(guide).toHaveCSS('background-color', 'rgb(255, 240, 166)');
      await expect(guide).toContainText('Plotting saves the estimated scores in the dataset');
      await expect(plotAction).toBeFocused();
      await expect(plotAction).toHaveCSS('animation-name', 'wt-action-ring');
      await expect(results.locator('.wt-next-action')).toHaveCount(1);
      await expect(results.getByRole('button', {name: 'Save score columns only'})).toHaveCount(0);
      await expect(results.getByRole('button', {name: 'Close results'})).not.toHaveClass(/wt-next-action/);
      await page.emulateMedia({reducedMotion: 'reduce'});
      await expect(plotAction).toHaveCSS('animation-name', 'none');
      await expect(plotAction).toHaveCSS('outline-color', 'rgb(255, 202, 40)');
      await page.emulateMedia({reducedMotion: 'no-preference'});
      await results.getByRole('button', {name:'Correlations', exact:true}).click();
      for (const id of ['phi', 'residuals', 'correlation']) {
        await results.getByLabel('Correlation matrix').selectOption(id);
        await expect(results.getByRole('table')).toBeVisible();
      }
      await results.getByRole('button', {name:'Model checks', exact:true}).click();
      await results.getByLabel('Model check').selectOption('counts');
      await expect(results.getByText('Jointly observed respondents')).toBeVisible();
      await results.getByLabel('Model check').selectOption('stability');
      await expect(results.getByRole('button', {name:'Run resampling stability'})).toBeVisible();
      await results.getByRole('button', {name:'Loadings', exact:true}).click();
      await results.getByLabel('Review instrument').check();
      await expect(results.getByLabel('Note Plan')).toBeVisible();
      await results.getByLabel('Review instrument').uncheck();
      await expect(plan.getByRole('cell')).toHaveCount(3);
      const size = page.viewportSize();
      await page.setViewportSize({width:390,height:844});
      const closeResults = results.getByRole('button', {name: 'Close results'});
      await expect(closeResults).toBeInViewport({ratio:1});
      await expect(plotAction).toBeInViewport({ratio:1});
      await expect(results.getByRole('button', {name:'Correlations',exact:true})).toBeInViewport({ratio:1});
      const width = await results.evaluate(el => ({inside:el.clientWidth,content:el.scrollWidth}));
      assert.ok(width.content <= width.inside + 1, 'Results must fit the narrow viewport');
      await page.setViewportSize(size);
      console.log('Verified grouped EFA views, a read-only opening, instrument review and a visible walkthrough exit.');
    }
    if (label === 'Finish the walkthrough') await expect(minimize).toBeVisible();
    if (label === 'Plot respondent scores') {
      await expect(page.getByRole('region', { name: 'Plot legend' })).toContainText('Nonbinary');
      const caption = page.getByLabel('Score plot details').first();
      await expect(caption).toContainText(/1,?050 scored \/ 0 omitted/i, { timeout: 30000 });
      await expect(page.getByTitle('Color by Gender', { exact: true })).toHaveAttribute('aria-pressed', 'true');
      const scoreGraph = page.locator('#active-plot');
      await expect.poll(() => scoreGraph.evaluate(graph => graph.data.filter(t => t.mode === 'markers').map(t => t.name).sort())).toEqual(['Man', 'Nonbinary', 'Woman']);
      const expectedGenderFills = { Man: 'rgb(0, 69, 173)', Woman: 'rgb(235, 26, 38)', Nonbinary: 'rgb(255, 214, 0)' };
      const genderLegend = page.getByRole('region', {name: 'Plot legend'});
      for (const [name, fill] of Object.entries(expectedGenderFills)) {
        await expect(genderLegend.getByTitle('Mute ' + name).locator('div').first()).toHaveCSS('background-color', fill);
      }
      await expect.poll(() => scoreGraph.evaluate(graph => Object.fromEntries(
        Array.from(graph.querySelectorAll('.scatterlayer .trace')).map(trace => [
          trace.__data__[0].trace.name, getComputedStyle(trace.querySelector('path.point')).fill,
        ]),
      ))).toEqual(expectedGenderFills);
      await expect(reopen).toBeVisible();
      await expect(results).toHaveCount(0);
      const scoreTip = page.getByRole('dialog', { name: 'Factor scores', exact: true });
      await expect(scoreTip).toHaveAttribute('data-walkthrough-target', 'factor-score-rows');
      await expect(scoreTip.getByRole('button', {name: /See the export options/})).toHaveCSS('animation-name', 'wt-action-ring');
      const pair = page.locator('[data-guide="factor-score-rows"]');
      const plottedNames = await pair.locator(':scope > div > div:first-child > [title]').evaluateAll(nodes => nodes.map(n => n.title));
      assert.match(plottedNames[0], /^FA1_/);
      assert.match(plottedNames[1], /^FA2_/);
      assert.equal(plottedNames.length, 2);
      await expect(pair.getByTitle(`Plot ${plottedNames[0]} on the X axis`)).toHaveAttribute('aria-pressed', 'true');
      await expect(pair.getByTitle(`Plot ${plottedNames[1]} on the Y axis`)).toHaveAttribute('aria-pressed', 'true');
      await expect(pair).toBeInViewport({ratio:0.99});
      const ring = page.locator('[data-walkthrough-ring="factor-score-rows"]');
      await expect.poll(async () => {
        const target = await pair.boundingBox(), box = await ring.boundingBox();
        return target && box && Math.abs(target.y - 1 - box.y) < 2 && Math.abs(target.height + 2 - box.height) < 2;
      }).toBe(true);
      await page.getByTitle('Color by Age', {exact: true}).click();
      await expect.poll(() => scoreGraph.evaluate(graph => graph._fullData[0].name)).toBe('Age');
      const legend = page.getByRole('region', {name: 'Plot legend'});
      const gradient = await legend.locator('[style*="linear-gradient"]').evaluate(el => getComputedStyle(el).backgroundImage);
      await expect(legend).toContainText('18.00');
      await expect(legend).toContainText('80.00');
      const ageColors = await scoreGraph.evaluate(graph => {
        const ages = graph._fullData[0].marker.color;
        const points = Array.from(graph.querySelectorAll('.scatterlayer .points path.point'));
        const fills = new Map(points.map((point, i) => [ages[point.__data__.i ?? i], getComputedStyle(point).fill]));
        return { total: points.length, ages: fills.size, fills: new Set(fills.values()).size, samples: [18, 49, 80].map(age => fills.get(age)) };
      });
      assert.deepEqual(ageColors, {total: 1050, ages: 63, fills: 63, samples: ['rgb(68, 1, 84)', 'rgb(38, 144, 137)', 'rgb(253, 231, 37)']});
      for (const endpoint of [ageColors.samples[0], ageColors.samples[2]]) assert.ok(gradient.includes(endpoint));
      await page.getByTitle('Color by Gender', {exact: true}).click();
      await expect.poll(() => scoreGraph.evaluate(graph => graph.data[0].name)).not.toBe('Age');
      const afterScores = await completedWork();
      await backTo('Factor loadings').click();
      await expect(minimize).toBeVisible();
      await expect(results).toBeVisible();
      await results.getByRole('button', {name: 'Close results'}).focus();
      await page.keyboard.press('Escape');
      await expect(results).toHaveCount(0);
      await expect(page.getByRole('button', {name: 'Exit demo', exact: true})).toBeVisible();
      await backTo('EFA settings').click();
      await expect(page.getByRole('dialog', { name: 'EFA settings', exact: true })).toBeVisible();
      await expect(results).toHaveCount(0);
      await backTo('Development / holdout').click();
      await backTo('Synthetic survey').click();
      await expect(reopen).toBeVisible();
      await backTo('Clustering').click();
      await expect(page.getByRole('dialog', { name: 'Clustering', exact: true })).toBeVisible();
      await expect(page.locator('[data-guide="datasets-list"] button[aria-current="true"]')).toHaveText(/^iris$/i);
      await expect.poll(() => page.locator('#active-plot').evaluate(g => g._fullLayout?.scene?.zaxis.title.text)).toMatch(/^PC2\b/);
      await expect(surveyTransition).toHaveCSS('background-color', sectionGreen);
      await button('Next: Synthetic survey').click();
      await button('Next: Development / holdout').click();
      await button('Next: EFA settings').click();
      const variables = page.locator('[data-scatter-section="variables"]').locator('.px-accordion-trigger, header button').first();
      if (await variables.getAttribute('aria-expanded') === 'true') await variables.click();
      await button('Next: Factor loadings').click();
      await results.getByRole('button', {name: 'Plot respondent scores'}).click();
      await expect(caption).toBeVisible();
      await expect(pair).toBeInViewport({ratio:0.99});
      await expect(ring).toBeVisible();
      assert.deepEqual(await completedWork(), afterScores, 'revisiting survey steps preserves both datasets, fit and score columns');
    }
  }
  if (await page.evaluate(() => Boolean(window.__scatterlabBridge?.current))) {
    const actual = await page.evaluate(() => {
      const bridge = window.__scatterlabBridge.current;
      const snapshot = bridge.snapshot();
      const survey = snapshot.datasets.find(dataset => dataset.id === snapshot.activeId);
      const run = survey.efa.runs.at(-1);
      const state = bridge.getState();
      const holdout = snapshot.datasets.find(dataset => dataset.samplePartition?.role === 'holdout');
      const full = snapshot.datasets.find(dataset => dataset.samplePartition?.role === 'full');
      return { role: survey.samplePartition.role, fullLocked: full.samplePartition.locked, holdoutLocked: holdout.samplePartition.locked,
        heldOut: holdout.table.data.ResponseID, heldOutRuns: holdout.efa.runs.length, fitted: run.result.fittingRows,
        scores: run.scoreColumns.map(name => survey.table.data[name]), pattern: run.result.rotation.pattern,
        columns: run.scoreColumns, responseIds: survey.table.data.ResponseID, genders: survey.table.data.Gender,
        traces: document.querySelector('#active-plot').data.filter(t => t.mode === 'markers').map(t => ({
          name: t.name, color: t.marker.color, x: Array.from(t.x), y: Array.from(t.y),
        })), axes: state.axes, viewMode: state.viewMode, dock: localStorage.getItem('scatterlab.assistant.dock') };
    });
    assert.equal(actual.viewMode, '2D');
    assert.deepEqual([actual.axes.x, actual.axes.y], actual.columns.slice(0, 2));
    assert.equal(actual.dock, dock);
    assert.equal(actual.role, 'development');
    assert.ok(actual.fullLocked && actual.holdoutLocked);
    assert.equal(actual.heldOutRuns, 0);
    assert.equal(actual.heldOut.length, 450);
    assert.deepEqual(actual.fitted, Array.from({length: reference.nRows}, (_, i) => i));
    assert.equal(new Set([...actual.responseIds, ...actual.heldOut]).size, 1500);
    assert.equal(createHash('sha256').update(JSON.stringify(actual.responseIds.map(id => id - 1))).digest('hex'), reference.membershipSha256);
    assert.equal(new Set(actual.traces.map(t => t.color)).size, 3);
    assert.deepEqual(actual.traces.map(t => t.name).sort(), ['Man', 'Nonbinary', 'Woman']);
    for (const trace of actual.traces) {
      const rows = actual.genders.flatMap((gender, row) => gender === trace.name ? [row] : []);
      assert.deepEqual(trace.x, rows.map(row => actual.scores[0][row]));
      assert.deepEqual(trace.y, rows.map(row => actual.scores[1][row]));
    }
    const csvRows = (await readFile(new URL('../public/demo/synthetic-survey.csv', import.meta.url), 'utf8')).trim().split(/\r?\n/).map(line => line.split(','));
    const headers = csvRows.shift();
    const valuesFor = name => actual.responseIds.map(id => Number(csvRows[id - 1][headers.indexOf(name)]));
    const input = { columns: reference.items, data: Object.fromEntries(reference.items.map(name => [name, valuesFor(name)])), nRows: reference.nRows };
    const promax = reference;
    const mappings = [[0, 1], [1, 0]].flatMap(order => [-1, 1].flatMap(first => [-1, 1].map(second => ({ order, signs: [first, second] }))));
    const maxError = ({ order, signs }) => Math.max(...promax.pattern.flatMap((row, index) => row.map((value, factor) => Math.abs(value - actual.pattern[index][order[factor]] * signs[factor]))));
    const alignment = mappings.sort((left, right) => maxError(left) - maxError(right))[0];
    assert.ok(maxError(alignment) < 1e-3, 'R-aligned loadings');
    const moments = input.columns.map(column => {
      const values = input.data[column];
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return { mean, sd: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) };
    });
    let error = 0;
    for (const [factor, column] of alignment.order.entries()) {
      assert.equal(actual.scores[column].length, input.nRows);
      for (let row = 0; row < reference.nRows; row++) {
        assert.ok(Number.isFinite(actual.scores[column][row]));
        const expected = input.columns.reduce((sum, name, item) => sum + (input.data[name][row] - moments[item].mean) / moments[item].sd * promax.weights[item][factor], 0);
        error = Math.max(error, Math.abs(actual.scores[column][row] * alignment.signs[factor] - expected));
      }
    }
    assert.ok(error < 1e-3, `R-aligned raw score coordinates: ${error}`);
    console.log(`Compared ${input.nRows} pairs of plotted score coordinates against the saved R weights (max absolute error ${error}).`);
  } else console.log('No diagnostic bridge: reference-coordinate comparison not run for this URL.');
  assert.equal(await page.evaluate(() => localStorage.getItem('scatterlab.assistant.dock')), dock);
  const openSaved = page.getByRole('button', {name: /Open EFA results/});
  if (!(await openSaved.isVisible())) {
    await page.locator('[data-scatter-section="pca"]').locator('.px-accordion-trigger, header button').first().click();
  }
  await openSaved.click();
  await expect(results.getByRole('row', {name: /^Plan\s*I make a plan/})).toContainText('I make a plan before starting a task.');
  await expect(results.getByLabel('Walkthrough guide')).toHaveCount(0);
  await expect(results.locator('.wt-next-action')).toHaveCount(0);
  await expect(results.getByRole('button', {name: 'Score columns saved'})).toBeDisabled();
  await results.getByRole('button', {name: 'Close results'}).click();
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  await page.getByRole('button', { name: /analysis record/i }).click();
  const dialog = page.getByRole('dialog', { name: /analysis record/i });
  await expect(dialog).toContainText('masked summary');
  const privacy = dialog.locator('details').filter({ has: page.getByText('Privacy and checksum details', { exact: true }) });
  await expect(privacy).not.toHaveAttribute('open', '');
  await privacy.locator('summary').click();
  await expect(privacy.getByText(/omit raw rows and chat/)).toBeVisible();
  await expect(privacy.getByText(/trusted copy of SHA256SUMS.txt separately/)).toBeVisible();
  await privacy.locator('summary').click();
  const download = async filename => {
    const pending = page.waitForEvent('download');
    await dialog.getByRole('button', { name: `Download ${filename}`, exact: true }).click();
    const file = await pending;
    assert.equal(file.suggestedFilename(), filename);
    return readFile(await file.path());
  };
  const records = bytes => bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  const masked = records(await download('analysis.jsonl'));
  assert.ok(masked.every(line => line.disclosure === 'masked-summary' && !line.metadata));
  await dialog.getByLabel(/Include exact settings/i).check();
  await expect(dialog.getByRole('button', { name: 'Download analysis.jsonl' })).toBeDisabled();
  await dialog.getByLabel(/I reviewed these files/i).check();
  const exact = await download('analysis.jsonl');
  const markdown = await download('analysis.md');
  const manifest = (await download('SHA256SUMS.txt')).toString();
  for (const [filename, bytes] of [['analysis.jsonl', exact], ['analysis.md', markdown]]) {
    assert.ok(manifest.split('\n').includes(`${digest(bytes)}  ${filename}`));
    assert.ok(!manifest.includes(digest(Buffer.concat([bytes, Buffer.from('!')]))));
  }
  const events = records(exact);
  assert.deepEqual(events.map(line => line.kind), masked.map(line => line.kind));
  for (const kind of ['import', 'efa-fit', 'efa-scores', 'view']) assert.ok(events.some(line => line.kind === kind), kind);
  const csv = await readFile(new URL('../public/demo/synthetic-survey.csv', import.meta.url));
  assert.ok(events.some(line => line.kind === 'import' && line.fields.inputSha256 === digest(csv)));
  assert.equal(events.at(-1).fields.plotted, reference.nRows);
  assert.equal(digest(csv), reference.inputSha256);
  assert.equal(events.at(-1).fields.plottedSha256, reference.membershipSha256);
  assert.equal(events.find(line => line.kind === 'membership' && line.fields.fitted)?.fields.fittingSha256, reference.membershipSha256);
  const split = events.find(line => line.kind === 'split').fields;
  assert.deepEqual([split.seed, split.fraction, split.development, split.holdout], [2026, .7, 1050, 450]);
  assert.equal(events.at(-1).metadata.color, 'Gender');
  assert.equal(events.find(line => line.kind === 'import').fields.columns, 11);
  assert.deepEqual(events.find(line => line.kind === 'efa-fit').metadata.items.map(item => item.column),
    ['Plan', 'Explore', 'Organize', 'Imagine', 'Schedule', 'Invent', 'Prepare', 'Experiment']);
  console.log('Verified downloaded masked and reviewed records, original survey digest, plotted population, Markdown/JSONL checksums and tamper detection.');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  // Exercise manual pinning after the tour has finished in a single pane.
  await expect(page.locator('[data-panes="1"]')).toBeVisible();
  const datasets = page.locator('[data-guide="datasets-list"]');
  await datasets.getByRole('button', { name: /^iris$/i }).click();
  const viewTab = page.locator('[data-guide="view"]');
  const liveSettings = page.getByRole('region', { name: 'Live view settings' });
  await button('Collapse the menu').click();
  await viewTab.click();
  await liveSettings.getByRole('button', { name: '2D', exact: true }).click();
  await liveSettings.getByRole('button', { name: 'Pin view', exact: true }).click();
  await viewTab.press('Escape');
  await button('Expand the menu').click();
  const grid = page.locator('.plot-grid-frame > [data-panes="2"]');
  await expect(grid).toBeVisible();
  const activePane = grid.locator(':scope > div').first();
  const frozenPane = grid.locator(':scope > div').nth(1);
  const pinnedPlot = frozenPane.locator('.js-plotly-plot');
  const livePlot = activePane.locator('#active-plot');
  const checkDrawerPosition = async () => {
    await expect(async () => {
      const pane = await activePane.boundingBox();
      const tab = await viewTab.boundingBox();
      const settings = await liveSettings.boundingBox();
      assert.ok(Math.abs(tab.y - pane.y) < 6, 'View is attached to the top of the live pane');
      assert.ok(settings.y >= tab.y + tab.height - 1 && settings.y + settings.height <= pane.y + pane.height + 1,
        `controls should open down inside the pane: ${JSON.stringify({ pane, tab, settings })}`);
      assert.ok(settings.x >= pane.x && settings.x + settings.width <= pane.x + pane.width, 'drawer stays within the live pane horizontally');
    }).toPass({ timeout: 2500 });
  };
  await expect(activePane.locator('[data-guide="view"]')).toHaveCount(1);
  await expect(frozenPane.locator('[data-guide="view"]')).toHaveCount(0);
  await expect(page.locator('aside [data-guide="view"]')).toHaveCount(0);
  const plotGeometry = () => activePane.evaluate(pane => {
    const plot = pane.querySelector('#active-plot').getBoundingClientRect();
    const box = pane.getBoundingClientRect();
    return [plot.x - box.x, plot.y - box.y, plot.width, plot.height];
  });
  const beforeDrawer = await plotGeometry();
  await viewTab.click();
  await checkDrawerPosition();
  assert.deepEqual(await plotGeometry(), beforeDrawer, 'expansion preserves the plot size and its position within the pane');
  const frozen = await pinnedPlot.evaluate(g => ({type: g.data[0].type, x: [...g.data[0].x], title: g._fullLayout.xaxis.title.text}));
  await liveSettings.getByRole('button', { name: '2D', exact: true }).click();
  await expect.poll(() => livePlot.evaluate(g => g.data[0].type)).toBe('scatter');
  await liveSettings.getByRole('button', { name: '3D', exact: true }).click();
  await expect.poll(() => livePlot.evaluate(g => g.data[0].type)).toBe('scatter3d');
  assert.deepEqual(await pinnedPlot.evaluate(g => ({type: g.data[0].type, x: [...g.data[0].x], title: g._fullLayout.xaxis.title.text})), frozen);
  const help = liveSettings.getByRole('group', {name: 'Axis scale'}).getByRole('button', {expanded: false});
  await help.click();
  await page.getByRole('tooltip').click();
  await expect(viewTab).toHaveAttribute('aria-expanded', 'true');
  await livePlot.click({position: {x: 18, y: 80}});
  await expect(viewTab).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await viewTab.click();
  await page.getByRole('button', {name: 'Collapse the menu'}).click();
  await expect(liveSettings).toBeHidden();
  await expect(page.getByRole('button', {name: 'Expand the menu'})).toBeVisible();
  await button('Expand the menu').click();
  await viewTab.click();
  await liveSettings.locator('summary', { hasText: 'Axis labels' }).click();
  await expect(liveSettings.getByLabel('Y axis label')).toBeVisible();
  await liveSettings.getByLabel('Y axis label').press('Escape');
  await expect(viewTab).toBeFocused();
  await expect(liveSettings).toBeHidden();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
  await viewTab.press('Space');
  await checkDrawerPosition();
  await viewTab.press('Escape');
  console.log('Verified the live View tab, downward expansion, 2D/3D switching, stable pinned plot and stacked layout.');
  await page.setViewportSize({ width: 1440, height: 960 });
  const before = await datasets.innerText();
  await page.getByTitle('Open the assistant', { exact: true }).click();
  await page.getByTitle('Back to the menu', { exact: true }).click();
  await page.getByRole('button', { name: /Guided walkthrough/i }).click();
  const warning = page.getByRole('dialog', { name: 'Start the guided walkthrough' });
  await expect(warning).toContainText('Your 4 datasets stay loaded');
  await warning.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await datasets.innerText(), before);
  const retryPage = await browser.newPage({ reducedMotion: 'reduce' });
  await retryPage.route('**/demo/iris.csv', route => route.fulfill({ status: 503, body: '' }), { times: 1 });
  await retryPage.goto(url.href);
  await retryPage.getByRole('button', { name: /^(> )?load demo$/i }).click();
  await expect(retryPage.getByRole('alert').filter({ hasText: 'That step didn’t complete' })).toBeVisible();
  const retryBegin = retryPage.getByRole('button', { name: 'Begin demo walkthrough', exact: true });
  await expect(retryBegin).toHaveCount(0);
  await retryPage.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(retryBegin).toBeVisible();
  await expect(retryBegin).toHaveCSS('animation-name', 'none');
  // A failed action from a bubble must reopen the panel with a way out.
  await retryPage.route('**/demo/synthetic-survey.csv', route => route.fulfill({ status: 503, body: '' }));
  await retryBegin.click();
  for (const next of ['Start with the Data section', 'Look at the variables', 'Run a PCA on the measurements', 'Cluster the PC scores', 'Load the synthetic survey']) {
    await retryPage.getByRole('button', { name: 'Next: ' + next, exact: true }).click();
  }
  await expect(retryPage.getByText(/That step didn’t complete: Demo data failed to load/)).toBeVisible();
  await expect(retryPage.locator('[data-walkthrough-target]')).toHaveCount(0);
  await retryPage.getByRole('button', { name: 'Exit demo', exact: true }).last().click();
  await expect(retryPage.getByTitle('Open the assistant', { exact: true })).toBeVisible();
  await retryPage.close();
  assert.deepEqual(errors, []);
  console.log('Passed: keyboard/drag resizing, drawer restore, immediate Iris import, PCA/clustering, responsive pins, survey EFA, respondent score plot, tour completion.');
} finally {
  await browser.close();
}
