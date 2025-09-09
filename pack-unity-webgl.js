const fs = require('fs');
const path = require('path');

const buildDir = 'Build';
const outputDir = 'dist';
const outputFile = path.join(outputDir, 'index.html');

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

// Read original HTML
let html = fs.readFileSync('index.html', 'utf8');

// Normalize ".concat()" paths
html = html.replace(/"Build\/"\.concat\("(.+?)"\)/g, '"Build/$1"');

// Helper to embed binary as base64
function embedBinary(filename) {
  try {
    const data = fs.readFileSync(filename);
    const ext = path.extname(filename).slice(1);
    const mime =
      ext === 'wasm'
        ? 'application/wasm'
        : ext === 'data' || ext === 'unityweb'
        ? 'application/octet-stream'
        : 'application/octet-stream';
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    console.warn(`⚠️ Missing binary: ${filename}`);
    return filename;
  }
}

// Read JSON config
const jsonFile = fs.readdirSync(buildDir).find(f => f.endsWith('.json'));
let jsonConfig = {};
if (jsonFile) {
  jsonConfig = JSON.parse(fs.readFileSync(path.join(buildDir, jsonFile), 'utf8'));
}

// Pre‑embed all binary files from JSON config
const embeddedFiles = {};
for (const key of Object.keys(jsonConfig)) {
  if (typeof jsonConfig[key] === 'string' && jsonConfig[key].endsWith('.unityweb')) {
    embeddedFiles[jsonConfig[key]] = embedBinary(path.join(buildDir, jsonConfig[key]));
  }
}

// Inline CSS
html = html.replace(/<link rel="stylesheet" href="(.+?)">/g, (_, href) => {
  try {
    const css = fs.readFileSync(href, 'utf8');
    return `<style>\n${css}\n</style>`;
  } catch {
    console.warn(`⚠️ Missing CSS: ${href}`);
    return _;
  }
});

// Inline JS and inject fetch override
html = html.replace(/<script src="(.+?)"><\/script>/g, (_, src) => {
  try {
    let js = fs.readFileSync(src, 'utf8');

    // Inject fetch override at top
    const override = `
      const __unityConfig = ${JSON.stringify(jsonConfig)};
      const __unityFiles = ${JSON.stringify(embeddedFiles)};
      const __origFetch = window.fetch;
      window.fetch = function(url, opts) {
        if (typeof url === 'string') {
          const fileName = url.split('/').pop();
          if (fileName.endsWith('.json')) {
            return Promise.resolve(new Response(JSON.stringify(__unityConfig), { headers: { "Content-Type": "application/json" } }));
          }
          if (__unityFiles[fileName]) {
            const base64 = __unityFiles[fileName].split(',')[1];
            const mime = __unityFiles[fileName].split(',')[0].split(':')[1].split(';')[0];
            const bin = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            return Promise.resolve(new Response(bin, { headers: { "Content-Type": mime } }));
          }
        }
        return __origFetch(url, opts);
      };
    `;

    js = override + "\n" + js;
    return `<script>\n${js}\n</script>`;
  } catch {
    console.warn(`⚠️ Missing JS: ${src}`);
    return `<script src="${src}"></script>`;
  }
});

fs.writeFileSync(outputFile, html);
console.log(`✅ Bundled HTML written to ${outputFile}`);
