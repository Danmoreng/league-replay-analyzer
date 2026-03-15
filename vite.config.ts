import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    include: ["apps/web/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "build/**", "build-wasm/**", "tools/**"],
  },
});
