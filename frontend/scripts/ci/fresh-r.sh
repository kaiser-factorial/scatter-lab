#!/usr/bin/env bash
set -euo pipefail
frontend="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$frontend"
artifacts="${CI_ARTIFACT_DIR:-$frontend/.ci-artifacts}"
mkdir -p "$artifacts"
artifacts="$(cd "$artifacts" && pwd)"
if [[ -e "$artifacts/fresh-r" ]]; then
  mv "$artifacts/fresh-r" "$artifacts/fresh-r.previous-$(date -u +%Y%m%dT%H%M%SZ)-$$"
fi
fixtures="$artifacts/fresh-r/fixtures"
source_snapshot="$artifacts/fresh-r/source"
mkdir -p "$fixtures/efa-congruence" "$fixtures/efa-extensions" "$fixtures/efa-weighted" "$fixtures/public-statistics" "$source_snapshot/congruence/vendor" "$source_snapshot/ci" "$source_snapshot/public-statistics"
exec > >(tee "$artifacts/fresh-r/run.log") 2>&1
node scripts/ci/reference-integrity.mjs
cp scripts/efa-reference/congruence/generate.R scripts/efa-reference/congruence/generate-ordinal.R scripts/efa-reference/congruence/verify-completion-replay.R "$source_snapshot/congruence/"
cp scripts/efa-reference/congruence/vendor/* "$source_snapshot/congruence/vendor/"
cp scripts/efa-reference/generate-weighted.R "$source_snapshot/congruence/pair-moments-source.R"
cp scripts/efa-reference/generate-conditional.R scripts/efa-reference/generate-stability.R scripts/efa-reference/generate-weighted.R "$source_snapshot/"
cp scripts/ci/verify-r-runtime.R "$source_snapshot/ci/"
cp scripts/statistics-reference/generate.R "$source_snapshot/public-statistics/"
cp ../packages/statistics/test/fixtures/public.input.json "$fixtures/public-statistics/"
if [[ "${CI_R_SKIP_BUILD:-0}" != 1 ]]; then
  docker build -t scatter-lab-efa-reference:4.5.1 scripts/efa-reference
  docker build -f scripts/efa-reference/Dockerfile.extensions -t scatter-lab-efa-extensions:4.5.1 scripts/efa-reference
  docker build -f scripts/efa-reference/Dockerfile.weighted -t scatter-lab-efa-weighted:4.5.1 scripts/efa-reference
fi
image="scatter-lab-efa-weighted:4.5.1"
image_id="$(docker inspect "$image" --format '{{.Id}}')"
docker inspect "$image" > "$artifacts/fresh-r/image.json"
run_r() {
  docker run --rm --network none --entrypoint Rscript \
    -e OPENBLAS_NUM_THREADS=1 -e OMP_NUM_THREADS=1 -e "REFERENCE_IMAGE_ID=$image_id" \
    -v "$source_snapshot:/source:ro" -v "$fixtures:/out" -v "$artifacts:/artifacts" "$image" "$@"
}
run_r /source/ci/verify-r-runtime.R /out/runtime.json
run_r /source/congruence/generate.R /out/efa-congruence /source/congruence
run_r /source/congruence/generate-ordinal.R /out/efa-congruence /source/congruence
run_r /source/generate-conditional.R /out/efa-extensions
run_r /source/generate-stability.R /out/efa-extensions
run_r /source/generate-weighted.R /out/efa-weighted
run_r /source/public-statistics/generate.R /out/public-statistics/public.input.json /out/public-statistics/public.reference.json
node scripts/ci/stamp-fresh-references.mjs "$fixtures"
CONGRUENCE_FIXTURE_ROOT="$fixtures" STATISTICS_REFERENCE_ROOT="$fixtures/public-statistics" CI_ARTIFACT_DIR="$artifacts/fresh-r" node scripts/ci/numerical.mjs
CONGRUENCE_FIXTURE_ROOT="$fixtures" COMPLETION_REPLAY_DIR="$artifacts/fresh-r/replay" CONGRUENCE_ENTRY=scripts/efa-reference/congruence/prepare-completion-replay.ts CONGRUENCE_OUTPUT="$artifacts/fresh-r/replay/native.json" node scripts/efa-reference/congruence/run.mjs
run_r /artifacts/fresh-r/replay/replay-completion.R /artifacts/fresh-r/replay/operation.json /artifacts/fresh-r/replay/r-completed.csv
run_r /source/congruence/verify-completion-replay.R /artifacts/fresh-r/replay
