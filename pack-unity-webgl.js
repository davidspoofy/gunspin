const fs = require('fs');
const path = require('path');

const buildDir = 'Build';
const templateDir = 'TemplateData';
const outputDir = 'dist';
const outputFile = path.join(outputDir, 'index.html');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

// Read original index.html
let html = fs.readFileSync('index.html', 'utf8');

// Inline JavaScript files
html = html.replace(/<script src="(.+?)"><\/script>/g, (_, src) => {
  const filePath = path.join(src);
  const content = fs.readFileSync(filePath, 'utf8');
  return `<script>\n${content}\n</script>`;
});

// Inline CSS files
html = html.replace(/<link rel="stylesheet" href="(.+?)">/g, (_, href) => {
  const filePath = path.join(href);
  const content = fs.readFileSync(filePath, 'utf8');
  return `<style>\n${content}\n</style>`;
});

// Inline binary assets (e.g., .wasm, .data) as base64
const embedBinary = (filename) => {
  const filePath = path.join(filename);
  const ext = path.extname(filename).slice(1);
  const mime = ext === 'wasm' ? 'application/wasm' : 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  const base64 = data.toString('base64');
  return `data:${mime};base64,${base64}`;
};

// Replace asset URLs with base64 data URIs
html = html.replace(/"(Build\/.+?\.(wasm|data))"/g, (_, file) => `"${embedBinary(file)}"`);

// Write bundled HTML
fs.writeFileSync(outputFile, html);
console.log(`✅ Bundled HTML written to ${outputFile}`);
