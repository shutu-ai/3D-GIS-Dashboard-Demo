import { defineConfig } from "vite";
import { type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

/**
 * Dev-only middleware: intercepts /data/* and /assets/glyphs/* and serves
 * placeholder data from .data/mock/ so development works before Lane A's
 * real data lands in public/data/. Production builds never use this plugin
 * (build output only includes public/).
 */
function mockDataPlugin(): Plugin {
  return {
    name: "mock-data-dev",
    apply: "serve",
    configureServer(server) {
      const mockRoot = path.resolve(__dirname, ".data/mock");

      server.middlewares.use((req, res, next) => {
        const url = (req.url || "").split("?")[0];
        let rel: string | null = null;
        if (url.startsWith("/data/")) rel = url.slice("/data/".length);
        else if (url.startsWith("/assets/glyphs/"))
          rel = "glyphs/" + url.slice("/assets/glyphs/".length);
        if (!rel) return next();

        const filePath = path.join(mockRoot, rel);
        if (!filePath.startsWith(mockRoot) || !fs.existsSync(filePath)) {
          // 404 -> downstream code degrades gracefully ("data not present")
          res.statusCode = 404;
          res.end();
          return;
        }
        const stat = fs.statSync(filePath);
        res.setHeader("Content-Length", stat.size);
        res.setHeader(
          "Content-Type",
          filePath.endsWith(".pbf") || filePath.endsWith(".pmtiles")
            ? "application/octet-stream"
            : filePath.endsWith(".geojson")
              ? "application/geo+json"
              : "application/json",
        );
        // Support Range for pmtiles (needed by pmtiles lib even for tiny files)
        const range = req.headers.range;
        if (range && /bytes=(\d+)-(\d*)/.exec(range)) {
          const m = /bytes=(\d+)-(\d*)/.exec(range)!;
          const start = parseInt(m[1], 10);
          const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          res.setHeader("Accept-Ranges", "bytes");
          fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
          res.statusCode = 200;
          fs.createReadStream(filePath).pipe(res);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [mockDataPlugin()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
});
