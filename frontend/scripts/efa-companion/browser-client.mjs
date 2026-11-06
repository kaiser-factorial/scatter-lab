import { EfaService } from '../../src/lib/efa/service.ts';
window.service = new EfaService(() => new Worker('./efa.worker.js', { type: 'module' }), 4);
window.results = [];
document.querySelector('#run').onclick = async () => {
  try {
    if (window.backend === 'scala') await window.service.connectScala(window.pairing);
    for (const name of window.fixtures ?? ['normal', 'pairwise', 'complete', 'skew', 'heavy-tail']) {
      const input = await (await fetch(`./reference/${name}.input.json`)).json();
      const spec = { items: input.columns.map((column, i) => ({ column, categories: input.categories[i], reverse: input.reverse.includes(i) })), nFactors: input.nFactors, extraction: 'wlsmv', rotation: 'oblimin', missing: input.missing, label: 'Synthetic workflow qualification', seed: 73021, sample: { partition: 'all' }, compute: { backend: window.backend } };
      for (const rotation of ['oblimin', 'promax', 'varimax']) {
        spec.rotation = rotation;
        const job = window.service.fit(input, spec, Array.from({ length: input.nRows }, (_, i) => i));
        window.job = job;
        const result = await job.promise;
        window.results.push({ name, rotation, result, report: window.service.report(job.id) });
      }
    }
    window.finished = true;
  } catch (error) { window.failure = error.message; }
};
setInterval(() => { document.querySelector('#status').textContent = JSON.stringify(window.job?.progress ?? {}); }, 250);
