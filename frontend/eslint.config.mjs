import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored Plotly bundle, copied in by the prebuild/predev hooks for the
    // self-contained HTML export. Linting 1.7MB of minified third-party code
    // reported ~4,450 problems and buried the ~135 real ones.
    "public/vendor/**",
    // Generated only for the isolated browser qualification harness.
    "public/efa-qualification/**",
  ]),
]);

export default eslintConfig;
