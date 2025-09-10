const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const buildDir = 'Build';
const outputDir = 'dist';
const outputFile = path.join(outputDir, 'index.html');

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

// 1) Read original HTML
let html = fs.readFileSync('index.html', 'utf8');

// Normalize Unity's ".concat()" paths in HTML
html = html.replace(/"Build\/"\.concat\("([^"]+)"\)/g, '"Build/$1"');

// 2) Gather Unity JSON config
const jsonFile = fs.readdirSync(buildDir).find(f => f.endsWith('.json'));
if (!jsonFile) throw new Error('No Unity build JSON found in Build/.');
const jsonConfig = JSON.parse(fs.readFileSync(path.join(buildDir, jsonFile), 'utf8'));

// 3) Helper: decompress .unityweb if needed
function readUnityAssetRaw(filePath) {
  let data = fs.readFileSync(filePath);
  if (filePath.endsWith('.unityweb')) {
    try { data = zlib.brotliDecompressSync(data); return data; } catch {}
    try { data = zlib.gunzipSync(data); return data; } catch {}
  }
  return data;
}

// 4) MIME type detection
function mimeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.js') return 'application/javascript';
  if (ext === '.data' || ext === '.mem') return 'application/octet-stream';
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

// 5) Pre-embed all assets from JSON config
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
  if (!name) continue;
  const diskPath = path.join(buildDir, name);
  if (!fs.existsSync(diskPath)) {
    console.warn(`⚠️ Missing asset: ${diskPath}`);
    continue;
  }
  const raw = readUnityAssetRaw(diskPath);
  embeddedFiles[name] = { mime: mimeFor(name), base64: raw.toString('base64') };
}

// 6) Build injection script
function buildInjectionScript() {
  return `
    <script>
      (function() {
        const __unityConfig = ${JSON.stringify(jsonConfig)};
        const __unityFiles = ${JSON.stringify(embeddedFiles)};
        function __b64ToU8(b64){const bin=atob(b64),len=bin.length,u8=new Uint8Array(len);for(let i=0;i<len;i++)u8[i]=bin.charCodeAt(i);return u8;}
        function __respBytes(bytes,mime){return new Response(bytes,{headers:{'Content-Type':mime}});}
        function __respJSON(obj){return new Response(JSON.stringify(obj),{headers:{'Content-Type':'application/json'}});}
        const __origFetch = window.fetch.bind(window);
        function __fileName(url){return String(url).split('/').pop();}
        window.fetch = function(url,opts){
          const s=String(url);
          if(s.endsWith('.json')) return Promise.resolve(__respJSON(__unityConfig));
          const f=__fileName(url);
          if(__unityFiles[f]){const {mime,base64}=__unityFiles[f];return Promise.resolve(__respBytes(__b64ToU8(base64),mime));}
          if(s.includes('/Build/')){const maybe=s.split('/').pop();if(__unityFiles[maybe]){const {mime,base64}=__unityFiles[maybe];return Promise.resolve(__respBytes(__b64ToU8(base64),mime));}}
          return __origFetch(url,opts);
        };
        const __origIS = WebAssembly.instantiateStreaming;
        WebAssembly.instantiateStreaming = async function(src,imp){
          try{const res=await (src instanceof Response?src:fetch(src));const buf=await res.arrayBuffer();return WebAssembly.instantiate(buf,imp);}
          catch(e){if(typeof __origIS==='function'){try{return __origIS(src,imp);}catch{}}throw e;}
        };
      })();
    </script>
  `;
}

// 7) Inline CSS
html = html.replace(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']\s*\/?>(?:\s*<\/link>)?/gi, (m, href) => {
  try { return `<style>\n${fs.readFileSync(href, 'utf8')}\n</style>`; }
  catch { console.warn(`⚠️ Could not inline CSS: ${href}`); return m; }
});

// 8) Insert injection script before first <script>
const injection = buildInjectionScript();
if (/<script[^>]*>/.test(html)) {
  html = html.replace(/<script[^>]*>/i, match => `${injection}\n${match}`);
} else {
  html = html.replace(/<\/head>/i, `${injection}\n</head>`);
  if (!/<\/head>/i.test(html)) html = html.replace(/<\/body>/i, `${injection}\n</body>`);
}

// 9) Inline all JS files, normalizing .concat() paths
html = html.replace(/<script\s+src=["']([^"']+)["']\s*><\/script>/gi, (m, src) => {
  try {
    let js = fs.readFileSync(src, 'utf8');
    js = js.replace(/"Build\/"\.concat\("([^"]+)"\)/g, '"Build/$1"');
    return `<script>\n${js}\n</script>`;
  } catch {
    console.warn(`⚠️ Could not inline JS: ${src}`);
    return m;
  }
});

// 10) Write output
fs.writeFileSync(outputFile, html, 'utf8');
console.log(`✅ Bundled HTML written to ${outputFile}`);
