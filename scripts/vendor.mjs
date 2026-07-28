import fs from 'fs';
import path from 'path';

const pairs = [
  ['node_modules/cytoscape/dist/cytoscape.min.js', 'media/vendor/cytoscape.min.js'],
  ['node_modules/dagre/dist/dagre.min.js', 'media/vendor/dagre.min.js'],
  ['node_modules/cytoscape-dagre/cytoscape-dagre.js', 'media/vendor/cytoscape-dagre.js'],
  ['node_modules/@highlightjs/cdn-assets/highlight.min.js', 'media/vendor/highlight.min.js'],
];

fs.mkdirSync('media/vendor', { recursive: true });
for (const [src, dst] of pairs) {
  if (!fs.existsSync(src)) {
    console.error(`MISSING: ${src}`);
    process.exit(1);
  }
  fs.copyFileSync(src, dst);
  console.log(`${src} -> ${dst} (${fs.statSync(dst).size} bytes)`);
}

// Patch cytoscape's multi-select-key predicate: by default it treats
// shift, ctrl AND cmd as "add to selection", which makes ctrl/cmd+click
// on a node (or ctrl/cmd+drag on the canvas) start a multi-select /
// rectangle-select. We only want shift to do that, so drop the
// metaKey/ctrlKey arms — ctrl/cmd+click stays a plain single interaction
// (e.g. our "jump to code" shortcut), which is read separately in main.js.
{
  const dst = 'media/vendor/cytoscape.min.js';
  const needle = 'e.shiftKey||e.metaKey||e.ctrlKey';
  const replacement = 'e.shiftKey';
  const contents = fs.readFileSync(dst, 'utf8');
  const count = contents.split(needle).length - 1;
  if (count !== 1) {
    console.error(`EXPECTED exactly 1 occurrence of multi-select-key predicate in ${dst}, found ${count}`);
    process.exit(1);
  }
  fs.writeFileSync(dst, contents.replace(needle, replacement));
  console.log(`${dst}: patched multi-select key to shift-only`);
}
