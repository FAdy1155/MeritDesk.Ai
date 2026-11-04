import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Permit the temporary Cloudflare Quick Tunnel hostname to load dev assets
  // and connect to HMR. This setting only applies to next dev.
  allowedDevOrigins: ["*.trycloudflare.com"],
  // Self-contained runtime output for the Docker image (see Dockerfile) —
  // bundles only the node_modules the server actually needs.
  output: "standalone",
  experimental: {
    serverActions: {
      // Import from the official site (/library/import) posts the saved page
      // or PDF to a Server Action: up to 9 MB per file
      // (src/services/library/manual-import.ts IMPORT_MAX_BYTES), under the
      // 10 MB a request body is buffered to on its way through the proxy.
      // Every other action sends a few form fields.
      bodySizeLimit: "10mb",
    },
  },
  // The import reads a PDF's text with the library's pdf.js worker thread
  // (src/services/library/extract/pdf.ts), which loads these files from disk
  // by path at run time, so the file trace does not find them on its own.
  outputFileTracingIncludes: {
    "/library/import": [
      "./src/services/library/extract/pdf-worker.mjs",
      "./node_modules/pdfjs-dist/package.json",
      "./node_modules/pdfjs-dist/legacy/build/pdf.mjs",
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/pdfjs-dist/cmaps/**/*",
      "./node_modules/pdfjs-dist/standard_fonts/**/*",
      "./node_modules/pdfjs-dist/wasm/**/*",
      "./node_modules/pdfjs-dist/iccs/**/*",
    ],
  },
};

export default nextConfig;
