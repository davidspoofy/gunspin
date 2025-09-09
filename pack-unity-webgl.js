const fs = require('fs');
const path = require('path');

const outputDir = 'dist';
const outputFile = path.join(outputDir, 'index.html');

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

let html = fs.readFileSync('index.html', 'utf8');

// Normalize Unity's ".concat()" paths
html = html.replace(/"Build\/"\.concat\("(.+?)"\)/g, '"Build/$1"');

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

// Inline JS (including loader)
html = html.replace(/<script src="(.+?)"><\/script>/g, (_, src) => {
  try {
    let js = fs.readFileSync(src, 'utf8');

    // Patch loader fetch calls to use embedded data
    js = js.replace(/fetch\((["'])(Build\/.+?\.wasm)\1\)/g, (m, q, file) => {
      return `Promise.resolve(new Response(Uint8Array.from(atob("${embedBinary(file).split(',')[1]}"), c => c.charCodeAt(0))))`;
    });

    js = js.replace(/fetch\((["'])(Build\/.+?\.data)\1\)/g, (m, q, file) => {
      return `Promise.resolve(new Response(Uint8Array.from(atob("${embedBinary(file).split(',')[1]}"), c => c.charCodeAt(0))))`;
    });

    return `<script>\n${js}\n</script>`;
  } catch {
    console.warn(`⚠️ Missing JS: ${src}`);
    return _;
  }
});

// Embed binary files
function embedBinary(filename) {
  try {
    const data = fs.readFileSync(filename);
    const ext = path.extname(filename).slice(1);
    const mime = ext === 'wasm' ? 'application/wasm' : 'application/octet-stream';
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    console.warn(`⚠️ Missing binary: ${filename}`);
    return filename;
  }
}

fs.writeFileSync(outputFile, html);
console.log(`✅ Bundled HTML written to ${outputFile}`);
