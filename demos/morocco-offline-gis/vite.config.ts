import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    // dev-time CORS-free local serving of public/ (data + glyphs)
    fs: { strict: false },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    assetsInlineLimit: 0, // keep every asset a real file
  },
});
