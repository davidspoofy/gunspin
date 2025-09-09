const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const buildDir = 'Build';
const outputDir = 'dist';
const outputFile = path.join(outputDir, 'index.html');

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

// 1) Read original HTML
let html = fs.readFileSync('index.html', 'utf8');

// 2) Gather Unity JSON config
const jsonFile = fs.readdirSync(buildDir).find(f => f.endsWith('.json'));
if (!jsonFile) {
  throw new Error('No Unity build JSON found in Build/.');
}
const jsonConfig = JSON.parse(fs.readFileSync(path.join(buildDir, jsonFile), 'utf8'));

// 3) Helper: detect and decompress .unityweb (brotli/gzip) to raw bytes
function readUnityAssetRaw(filePath) {
  let data = fs.readFileSync(filePath);

  // Try Brotli, then gzip, else leave raw
  const tryBrotli = () => zlib.brotliDecompressSync(data);
  const tryGunzip = () => zlib.gunzipSync(data);

  const isUnityWeb = filePath.endsWith('.unityweb');
  if (isUnityWeb) {
    // Try Brotli
    try {
      data = tryBrotli();
      return data;
    } catch {}
    // Try gzip
    try {
      data = tryGunzip();
      return data;
    } catch {}
    // If neither worked, assume already raw
    return data;
  }
  return data;
}

// 4) Determine MIME type for embedded assets
function mimeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.js') return 'application/javascript';
  if (ext === '.data') return 'application/octet-stream';
  if (ext === '.mem') return 'application/octet-stream';
  if (ext === '.unityweb') {
    // After decompression, the underlying type could be wasm, js, or data.
    // We’ll detect by name hints from Unity keys, else default to octet-stream.
    if (/wasm/i.test(filename)) return 'application/wasm';
    if (/framework|js/i.test(filename)) return 'application/javascript';
    return 'application/octet-stream';
  }
  if (ext === '.json') return 'application/json';
  if (ext === '.css') return 'text/css';
  if (ext === '.html' || ext === '.htm') return 'text/html';
  return 'application/octet-stream';
}

// 5) Pre-embed all assets referenced by the JSON config (covers wasm/data/framework and asm variants)
const candidateKeys = [
  'dataUrl',
  'wasmCodeUrl',
  'wasmFrameworkUrl',
  'asmCodeUrl',
  'asmMemoryUrl',
  'asmFrameworkUrl'
];

const embeddedFiles = {};
for (const key of candidateKeys) {
  const name = jsonConfig[key];
  if (!name || typeof name !== 'string') continue;

  const diskPath = path.join(buildDir, name);
  if (!fs.existsSync(diskPath)) {
    console.warn(`⚠️ Missing asset referenced in JSON: ${diskPath}`);
    continue;
  }

  const raw = readUnityAssetRaw(diskPath); // decompressed bytes (if unityweb)
  const base64 = raw.toString('base64');
  const mime = mimeFor(name);
  embeddedFiles[name] = { mime, base64 };
}

// 6) Embed loader-adapter that:
//    - provides config in-memory
//    - overrides fetch for Build/* URLs (JSON + binary)
//    - provides proper Response with json/text/arrayBuffer
//    - forces WebAssembly.instantiateStreaming to fallback to ArrayBuffer path
function buildInjectionScript() {
  const cfgStr = JSON.stringify(jsonConfig);
  const filesStr = JSON.stringify(embeddedFiles);

  return `
    <script>
      (function() {
        // Embedded Unity config and files
        const __unityConfig = ${cfgStr};
        const __unityFiles = ${filesStr};

        // Helper: Base64 -> Uint8Array
        function __b64ToU8(base64) {
          const bin = atob(base64);
          const len = bin.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
          return bytes;
        }

        // Make a synthetic Response object with proper methods
        function __makeResponseFromBytes(bytes, mime = 'application/octet-stream') {
          return new Response(bytes, { headers: { 'Content-Type': mime } });
        }
        function __makeResponseFromJSON(obj) {
          const jsonText = JSON.stringify(obj);
          return new Response(jsonText, { headers: { 'Content-Type': 'application/json' } });
        }

        // Keep a reference to the original fetch
        const __origFetch = window.fetch.bind(window);

        // Normalize any URL to a Build-relative filename
        function __toBuildFileName(url) {
          try {
            // If absolute/relative URL, parse and take last segment
            const asString = String(url);
            const last = asString.split('/').pop() || asString;
            return last;
          } catch {
            return String(url);
          }
        }

        // Override fetch to serve embedded JSON and binaries
        window.fetch = function(url, options) {
          // If loader requests JSON config
          const s = String(url);
          if (s.endsWith('.json')) {
            return Promise.resolve(__makeResponseFromJSON(__unityConfig));
          }

          const fileName = __toBuildFileName(url);

          // Serve embedded binaries if requested
          if (__unityFiles[fileName]) {
            const { mime, base64 } = __unityFiles[fileName];
            const bytes = __b64ToU8(base64);
            return Promise.resolve(__makeResponseFromBytes(bytes, mime));
          }

          // If Unity builds with buildUrl prefixes, catch those too
          if (s.includes('/Build/')) {
            const maybe = s.split('/').pop();
            if (__unityFiles[maybe]) {
              const { mime, base64 } = __unityFiles[maybe];
              const bytes = __b64ToU8(base64);
              return Promise.resolve(__makeResponseFromBytes(bytes, mime));
            }
          }

          // Fallback to real network for everything else
          return __origFetch(url, options);
        };

        // Force instantiateStreaming to fallback to ArrayBuffer path
        const __origInstantiateStreaming = WebAssembly.instantiateStreaming;
        WebAssembly.instantiateStreaming = async function(source, importObject) {
          try {
            // Use our (possibly overridden) fetch, then arrayBuffer
            const res = await (source instanceof Response ? source : fetch(source));
            const buf = await res.arrayBuffer();
            return WebAssembly.instantiate(buf, importObject);
          } catch (e) {
            // Final fallback: try original if present
            if (typeof __origInstantiateStreaming === 'function') {
              try { return __origInstantiateStreaming(source, importObject); } catch {}
            }
            // Last resort: throw
            throw e;
          }
        };
      })();
    </script>
  `;
}

// 7) Inline CSS files (best effort)
html = html.replace(/<link\\s+rel=["']stylesheet["']\\s+href=["']([^"']+)["']\\s*\\/?>(?:\\s*<\/link>)?/gi, (m, href) => {
  try {
    const css = fs.readFileSync(href, 'utf8');
    return `<style>\n${css}\n</style>`;
  } catch {
    console.warn(`⚠️ Could not inline CSS: ${href}`);
    return m;
  }
});

// 8) Insert our injection script just before the first <script ...> tag,
//    so it takes effect before Unity loader runs.
const injection = buildInjectionScript();
if (/<script[^>]*>/.test(html)) {
  html = html.replace(/<script[^>]*>/i, match => `${injection}\n${match}`);
} else {
  // If no script tags found (unlikely for Unity builds), append at end of body/head
  html = html.replace(/<\/head>/i, `${injection}\n</head>`);
  if (!/<\/head>/i.test(html)) {
    html = html.replace(/<\/body>/i, `${injection}\n</body>`);
  }
}

// 9) Inline all <script src="..."></script> to avoid external fetches
html = html.replace(/<script\\s+src=["']([^"']+)["']\\s*><\\/script>/gi, (m, src) => {
  try {
    const js = fs.readFileSync(src, 'utf8');
    return `<script>\n${js}\n</script>`;
  } catch {
    console.warn(`⚠️ Could not inline JS: ${src}`);
    return m;
  }
});

// 10) Write output
fs.writeFileSync(outputFile, html, 'utf8');
console.log(`✅ Bundled HTML written to ${outputFile}`);
