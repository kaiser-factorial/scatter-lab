# Historical Scala backend reference

These modules retain the former Scala transport, binary protocol and backend
contract for standalone numerical/transport benchmarks. They are not imported
by Scatter Lab's application, workers, assistant tools or statistics package.
The application supports Browser CPU and WebGPU only and rejects saved Scala
settings instead of substituting another backend.

The adapter logic was retained from the application before removal; imports now
point to this reference-only contract and the shared numerical self-check/GPU
kernel. `../large-transport.worker.mjs` uses this adapter. Other historical UI
qualification scripts and their recorded evidence target the application
revision in their receipts; they are not current UI integration tests.

The Scala sources, dependency manifest, supervisor and existing qualification
artifacts remain in the surrounding reference directory. No setup or server
process is launched by an app action, install hook, or application package script.
