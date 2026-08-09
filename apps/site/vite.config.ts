import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PL-15 deploy-compatibility shim. Cloudflare Pages' build settings live in the Cloudflare
// dashboard, not in this repo, and today build from the repo root into `dist/`. Emitting there
// keeps that external contract byte-identical now that the site lives in apps/site/. Do NOT
// "clean this up" to the default apps/site/dist without flipping the dashboard first — that is
// deferred follow-up D2 in docs/repo-structure.md.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../../dist",   // resolved relative to this config's dir (apps/site)
    emptyOutDir: true,      // required: Vite refuses to clear a dir outside its root otherwise
  },
});
