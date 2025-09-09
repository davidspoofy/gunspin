const fs = require('fs');
const path = require('path');

const buildDir = 'Build';
const outputDir = 'dist';
const outputFile = path.join(outputDir, 'index.html');

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

// Read original HTML
let html = fs.readFileSync('index.html', 'utf8');

// Normalize Unity's ".concat()" paths
html = html.replace(/"Build\/"\.concat\("(.+?)"\)/g, '"Build/$1"');

// --- Helper to embed binary files as base64 ---
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

// --- Read and store JSON config ---
const jsonFile = fs.readdirSync(buildDir).find(f => f.endsWith('.json'));
let jsonConfig = {};
if (jsonFile) {
  jsonConfig = JSON.parse(fs.readFileSync(path.join(buildDir, jsonFile), 'utf8'));
}

// --- Inline CSS ---
html = html.replace(/<link rel="stylesheet" href="(.+?)">/g, (_, href) => {
  try {
    const css = fs.readFileSync(href, 'utf8');
    return `<style>\n${css}\n</style>`;
  } catch {
    console.warn(`⚠️ Missing CSS: ${href}`);
    return _;
  }
});

// --- Inline JS and patch loader ---
html = html.replace(/<script src="(.+?)"><\/script>/g, (_, src) => {
  try {
    let js = fs.readFileSync(src, 'utf8');

    // Patch JSON fetch
    js = js.replace(/fetch\((["'])(Build\/.+?\.json)\1\)/, () => {
      return `Promise.resolve(new Response('${JSON.stringify(jsonConfig)}', { headers: { "Content-Type": "application/json" } }))`;
    });

    // Patch binary fetches (.wasm, .data, .unityweb)
    js = js.replace(/fetch\((["'])(Build\/.+?\.(wasm|data|unityweb))\1\)/g, (_, q, file) => {
      return `Promise.resolve(new Response(Uint8Array.from(atob("${embedBinary(file).split(',')[1]}"), c => c.charCodeAt(0))))`;
    });

    return `<script>\n${js}\n</script>`;
  } catch {
    console.warn(`⚠️ Missing JS: ${src}`);
    return `<script src="${src}"></script>`;
  }
});

// --- Write bundled HTML ---
fs.writeFileSync(outputFile, html);
console.log(`✅ Bundled HTML written to ${outputFile}`);
