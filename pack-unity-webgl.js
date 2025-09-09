const fs = require('fs');
const path = require('path');

const buildDir = 'Build';
const outputDir = 'dist';
const outputFile = path.join(outputDir, 'index.html');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

// Read original index.html
let html = fs.readFileSync('index.html', 'utf8');

// --- 1️⃣ Normalize Unity's `.concat()` paths into plain strings ---
html = html.replace(/"Build\/"\.concat\("(.+?)"\)/g, '"Build/$1"');

// --- 2️⃣ Inline JavaScript files ---
html = html.replace(/<script src="(.+?)"><\/script>/g, (_, src) => {
  try {
    const filePath = path.join(src);
    const content = fs.readFileSync(filePath, 'utf8');
    return `<script>\n${content}\n</script>`;
  } catch (err) {
    console.warn(`⚠️ Could not inline JS file: ${src}`);
    return `<script src="${src}"></script>`;
  }
});

// --- 3️⃣ Inline CSS files ---
html = html.replace(/<link rel="stylesheet" href="(.+?)">/g, (_, href) => {
  try {
    const filePath = path.join(href);
    const content = fs.readFileSync(filePath, 'utf8');
    return `<style>\n${content}\n</style>`;
  } catch (err) {
    console.warn(`⚠️ Could not inline CSS file: ${href}`);
    return `<link rel="stylesheet" href="${href}">`;
  }
});

// --- 4️⃣ Inline binary assets (.wasm, .data) as base64 ---
const embedBinary = (filename) => {
  try {
    const filePath = path.join(filename);
    const ext = path.extname(filename).slice(1);
    const mime =
      ext === 'wasm'
        ? 'application/wasm'
        : ext === 'data'
        ? 'application/octet-stream'
        : 'application/octet-stream';
    const data = fs.readFileSync(filePath);
    const base64 = data.toString('base64');
    return `data:${mime};base64,${base64}`;
  } catch (err) {
    console.warn(`⚠️ Could not embed binary file: ${filename}`);
    return filename; // leave original path if missing
  }
};

// --- 5️⃣ Replace asset URLs with base64 data URIs ---
html = html.replace(/"(Build\/.+?\.(wasm|data))"/g, (_, file) => {
  return `"${embedBinary(file)}"`;
});

// --- 6️⃣ Write bundled HTML ---
fs.writeFileSync(outputFile, html);
console.log(`✅ Bundled HTML written to ${outputFile}`);
