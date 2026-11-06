# Source and distribution status

This package contains Scatter Lab's TypeScript numerical implementation,
extracted into a shared library within the same repository. It remains private
and `UNLICENSED`; this migration does not select a new open-source license or
authorize public distribution.

Its runtime dependency is `ml-matrix` 6.12.1, distributed separately through npm
under its own license. Dependency notices remain in the installed dependency.
No R executable, R package, reference dataset, test fixture, SAW executable,
Cryptol model, browser worker or optional companion is shipped in this tarball.

Reference implementations and method provenance, including the existing
missMDA-oriented iterative PCA contract, are documented in the repository's
validation files. Publication needs a deliberate project license/provenance
review; retaining private package metadata prevents accidental npm publication.
