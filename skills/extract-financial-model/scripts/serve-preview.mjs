#!/usr/bin/env node

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const PREVIEW_FORMAT = "financial-model-viewer-preview@0.1";
const MARKER_FILENAME = ".financial-model-viewer-preview.json";
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function usage() {
  console.log(`Usage:
  node skills/extract-financial-model/scripts/serve-preview.mjs <viewer-directory> [--port 4174]

The server binds to 127.0.0.1 only. Stop it with Ctrl-C.`);
}

function readMarker(viewerDirectory) {
  const markerPath = join(viewerDirectory, MARKER_FILENAME);
  if (!existsSync(markerPath)) {
    throw new Error(`Not a generated financial-model preview: missing ${markerPath}`);
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  if (marker.format !== PREVIEW_FORMAT) {
    throw new Error(`Unsupported preview marker in ${markerPath}`);
  }
  if (!existsSync(join(viewerDirectory, "index.html"))) {
    throw new Error(`Preview has no index.html: ${viewerDirectory}`);
  }
  return marker;
}

function parseRequestPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl ?? "/", "http://127.0.0.1").pathname);
  return pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
}

function isInside(root, target) {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

export async function startPreviewServer(viewerDirectory, port = 0) {
  const root = resolve(viewerDirectory);
  const marker = readMarker(root);
  const server = createServer((request, response) => {
    try {
      const requestPath = normalize(parseRequestPath(request.url));
      const target = resolve(root, requestPath);
      if (!isInside(root, target) || !existsSync(target) || !statSync(target).isFile()) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
        return;
      }

      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": CONTENT_TYPES.get(extname(target).toLowerCase()) ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      createReadStream(target).pipe(response);
    } catch (cause) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
  });

  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview server did not expose a TCP port");

  return {
    marker,
    server,
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolveClose, reject) =>
      server.close((error) => error ? reject(error) : resolveClose()),
    ),
  };
}

function parseCli(arguments_) {
  if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
    usage();
    process.exit(arguments_.length === 0 ? 1 : 0);
  }
  const viewerDirectory = resolve(process.cwd(), arguments_[0]);
  let port = 4174;
  for (let index = 1; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--port" && arguments_[index + 1]) {
      port = Number(arguments_[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arguments_[index]}`);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return { viewerDirectory, port };
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  try {
    const { viewerDirectory, port } = parseCli(process.argv.slice(2));
    const preview = await startPreviewServer(viewerDirectory, port);
    console.log(`SERVING ${preview.url}`);
    console.log(`dataset=${preview.marker.datasetName} hash=${preview.marker.databaseSha256}`);
    console.log("The preview is local-only. Press Ctrl-C to stop.");

    const stop = async () => {
      await preview.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise(() => {});
  } catch (cause) {
    console.error(`ERROR ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  }
}

export { MARKER_FILENAME, PREVIEW_FORMAT };
