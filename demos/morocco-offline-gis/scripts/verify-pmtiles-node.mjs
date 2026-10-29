// Authoritative cross-check: read a PMTiles archive with the same npm
// `pmtiles` package the frontend uses, and verify tiles resolve.
// Usage: node scripts/verify-pmtiles-node.mjs <archive> z x y [z x y ...]
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { PMTiles } from "pmtiles";

const archive = process.argv[2];
const triples = [];
for (let i = 3; i + 2 < process.argv.length + 1; i += 3) {
  triples.push([Number(process.argv[i]), Number(process.argv[i + 1]), Number(process.argv[i + 2])]);
}
if (!archive || triples.length === 0) {
  console.error("usage: node verify-pmtiles-node.mjs <archive> z x y [z x y ...]");
  process.exit(2);
}

const buf = readFileSync(archive);

// serve the file over localhost so the stock FetchSource range-reads it
const server = createServer((req, res) => {
  const range = req.headers.range;
  let start = 0;
  let end = buf.length - 1;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      start = Number(m[1]);
      if (m[2]) end = Number(m[2]);
    }
  }
  const slice = buf.subarray(start, end + 1);
  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${buf.length}`,
    "Accept-Ranges": "bytes",
    "Content-Length": String(slice.length),
    Connection: "close",
  });
  res.end(slice);
});
server.keepAliveTimeout = 500;
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const p = new PMTiles(`http://127.0.0.1:${port}/archive.pmtiles`);
let failures = 0;
try {
  const hdr = await p.getHeader();
  console.log(
    `header: v${hdr.specVersion} type=${hdr.tileType} z${hdr.minZoom}-${hdr.maxZoom} ` +
      `entries=${hdr.numTileEntries} compression=${hdr.tileCompression} internal=${hdr.internalCompression}`,
  );
  for (const [z, x, y] of triples) {
    try {
      const r = await p.getZxy(z, x, y);
      if (!r || !r.data || r.data.length === 0) {
        console.log(`MISS ${z}/${x}/${y}`);
        failures++;
        continue;
      }
      console.log(`OK   ${z}/${x}/${y} -> ${r.data.byteLength ?? r.data.length} bytes`);
    } catch (e) {
      console.log(`ERR  ${z}/${x}/${y}: ${e?.message ?? e}`);
      failures++;
    }
  }
} catch (e) {
  console.error("READ FAILED:", e?.stack ?? e);
  failures++;
}
server.closeAllConnections?.();
await new Promise((r) => server.close(r));
process.exitCode = failures ? 1 : 0;
