import { defineConfig } from "vite-plus";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
  fmt: {
    ignorePatterns: ["dist/**", "src/generated/wasm/**"],
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
