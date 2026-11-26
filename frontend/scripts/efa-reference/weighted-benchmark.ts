const output = document.querySelector("#output")!,
  stage = document.querySelector("#stage")!;
let worker: Worker | undefined,
  heartbeats = 0,
  last = performance.now(),
  maxHeartbeatGap = 0;
setInterval(() => {
  const now = performance.now();
  maxHeartbeatGap = Math.max(maxHeartbeatGap, now - last);
  last = now;
  document.querySelector("#heartbeat")!.textContent = String(++heartbeats);
}, 100);
(document.querySelector("#cancel") as HTMLButtonElement).onclick = () => {
  const start = performance.now();
  worker?.terminate();
  worker = undefined;
  document.querySelector("#cancelTime")!.textContent = String(
    performance.now() - start,
  );
  stage.textContent = "cancelled";
};
(document.querySelector("#run") as HTMLButtonElement).onclick = () => {
  worker?.terminate();
  worker = new Worker(new URL("weighted-worker.js", import.meta.url), {
    type: "module",
  });
  output.textContent = "running";
  worker.onmessage = (event) => {
    if (event.data.progress)
      stage.textContent = JSON.stringify(event.data.progress);
    if (event.data.result)
      output.textContent = JSON.stringify({
        ...event.data.result,
        heartbeats,
        maxHeartbeatGapMs: maxHeartbeatGap,
        browser: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
      });
  };
  worker.onerror = (event) => {
    output.textContent = JSON.stringify({
      status: "failed",
      error: event.message,
    });
  };
  const params = new URLSearchParams(location.search);
  worker.postMessage({
    robust: params.get("robust") === "true",
    n: Number(params.get("n") ?? 20000),
    p: Number(params.get("p") ?? 500),
    inferenceSpace: params.get("space") ?? undefined,
  });
};
