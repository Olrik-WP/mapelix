import { defineConfig } from "vite";

/**
 * Builds `src/lib/embed.ts` as one ES module, three.js included, for hosts that
 * load the viewer with a dynamic `import()` from their own origin. The output
 * runs under a strict `script-src 'self'` policy: it has no inline code and no eval.
 */
export default defineConfig({
  build: {
    outDir: "dist-embed",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    minify: true,
    copyPublicDir: false,
    lib: {
      entry: "src/lib/embed.ts",
      formats: ["es"],
      fileName: () => "mapelix-viewer-3d.js",
    },
    rolldownOptions: {
      output: { codeSplitting: false },
    },
  },
});
