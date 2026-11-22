/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
