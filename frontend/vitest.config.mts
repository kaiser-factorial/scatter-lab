import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Numeric tests stay in Node; component tests opt into happy-dom per file.
  test: { environment: "node" },
});
