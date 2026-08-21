import path from "path";
import { defineConfig } from "vitest/config";

// route modules (app/api/**/route.ts) import via the "@/" tsconfig path alias; vite/vitest don't
// read tsconfig's "paths" automatically, so without this alias those imports fail at module-load
// time ("Cannot find package '@/lib/compile'") and route handlers can never be unit-tested at all.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
});
