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
  if (filePath.endsWith('.unityweb')) {
    try { data = zlib.brotliDecompressSync(data); return data; } catch {}
    try { data = zlib.gunzipSync(data); return data; } catch {}
  }
  return data;
}

// 4) Determine MIME type
function mimeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.js') return 'application/javascript';
  if (ext === '.data') return 'application/octet-stream';
  if (ext === '.mem') return 'application/octet-stream';
  if (ext === '.unityweb') {
    if (/wasm/i.test(filename)) return 'application/wasm';
    if (/framework|js/i.test(filename)) return 'application/javascript';
    return 'application/octet-stream';
  }
  if (ext === '.json') return 'application/json';
  if (ext === '.css') return 'text/css';
  if (ext === '.html' || ext === '.htm') return 'text/html';
  return 'application/octet-stream';
}

// 5) Pre-embed all assets referenced by the JSON config
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
  const raw = readUnityAssetRaw(diskPath);
  const base64 = raw.toString('base64');
  const mime = mimeFor(name);
  embeddedFiles[name] = { mime, base64 };
}

// 6) Build injection script
function buildInjectionScript() {
  const cfgStr = JSON.stringify(jsonConfig);
  const filesStr = JSON.stringify(embeddedFiles);
  return `
    <script>
      (function() {
        const __unityConfig = ${cfgStr};
        const __unityFiles = ${filesStr};

        function __b64ToU8(base64) {
          const bin = atob(base64);
          const len = bin.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
          return bytes;
        }

        function __makeResponseFromBytes(bytes, mime) {
          return new Response(bytes, { headers: { 'Content-Type': mime } });
        }
        function __makeResponseFromJSON(obj) {
          return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
        }

        const __origFetch = window.fetch.bind(window);

        function __toBuildFileName(url) {
          const asString = String(url);
          return asString.split('/').pop() || asString;
        }

        window.fetch = function(url, options) {
          const s = String(url);
          if (s.endsWith('.json')) {
            return Promise.resolve(__makeResponseFromJSON(__unityConfig));
          }
          const fileName = __toBuildFileName(url);
          if (__unityFiles[fileName]) {
            const { mime, base64 } = __unityFiles[fileName];
            const bytes = __b64ToU8(base64);
            return Promise.resolve(__makeResponseFromBytes(bytes, mime));
          }
          if (s.includes('/Build/')) {
            const maybe = s.split('/').pop();
            if (__unityFiles[maybe]) {
              const { mime, base64 } = __unityFiles[maybe];
              const bytes = __b64ToU8(base64);
              return Promise.resolve(__makeResponseFromBytes(bytes, mime));
            }
          }
          return __origFetch(url, options);
        };

        const __origInstantiateStreaming = WebAssembly.instantiateStreaming;
        WebAssembly.instantiateStreaming = async function(source, importObject) {
          try {
            const res = await (source instanceof Response ? source : fetch(source));
            const buf = await res.arrayBuffer();
            return WebAssembly.instantiate(buf, importObject);
          } catch (e) {
            if (typeof __origInstantiateStreaming === 'function') {
              try { return __origInstantiateStreaming(source, importObject); } catch {}
            }
            throw e;
          }
        };
      })();
    </script>
  `;
}

// 7) Inline CSS
html = html.replace(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']\s*\/?>(?:\s*<\/link>)?/gi, (m, href) => {
  try {
    const css = fs.readFileSync(href, 'utf8');
    return `<style>\n${css}\n</style>`;
  } catch {
    console.warn(`⚠️ Could not inline CSS: ${href}`);
    return m;
  }
});

// 8) Insert injection script before first <script>
const injection = buildInjectionScript();
if (/<script[^>]*>/.test(html)) {
  html = html.replace(/<script[^>]*>/i, match => `${injection}\n${match}`);
} else {
  html = html.replace(/<\/head>/i, `${injection}\n</head>`);
  if (!/<\/head>/i.test(html)) {
    html = html.replace(/<\/body>/i, `${injection}\n</body>`);
  }
}

// 9) Inline all <script src="..."></script>
html = html.replace(/<script\s+src=["']([^"']+)["']\s*><\/script>/gi, (m, src) => {
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
