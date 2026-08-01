import { cp, mkdir, rm } from 'node:fs/promises';

const out = 'dist-viewer';
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp('viewer/index.html', `${out}/index.html`);
await cp('viewer/app.js', `${out}/app.js`);
await cp('viewer/styles.css', `${out}/styles.css`);
await cp('viewer/diagram.html', `${out}/diagram.html`);
await cp('media', `${out}/media`, { recursive: true });
