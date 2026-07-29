/**
 * Package a built channel for the Chrome Web Store.
 *
 *   node scripts/package.mjs           zip dist/      -> artifacts/grt-next-bus-<version>.zip
 *   node scripts/package.mjs --free    zip dist-free/ -> artifacts/grt-next-bus-free-<version>.zip
 *
 * Run after the matching `vite build`; `npm run zip` / `npm run zip:free` chain
 * both steps so the archive can only ever contain what was just built.
 *
 * This project publishes two listings from one codebase, so it keeps two output
 * directories. The rule that makes it consistent with the other extensions here
 * is simply: `dist/` is the one you load in Chrome. `dist-free/` exists only to
 * be packaged.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip, verifyZip } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const free = process.argv.slice(2).includes('--free');
const source = path.join(root, free ? 'dist-free' : 'dist');
const artifacts = path.join(root, 'artifacts');

/** Files a loadable extension cannot be missing. */
const REQUIRED = ['manifest.json', 'popup.html', 'popup.js', 'background.js'];

/** Every file under `dir`, as forward-slash paths relative to it. */
async function collect(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await collect(path.join(dir, entry.name), name)));
    else files.push({ name, data: await readFile(path.join(dir, entry.name)) });
  }
  return files;
}

async function main() {
  let files;
  try {
    files = await collect(source);
  } catch {
    throw new Error(
      `${path.relative(root, source)}/ does not exist. Run ` +
        `\`npm run ${free ? 'build:free' : 'build'}\` first.`,
    );
  }

  const present = new Set(files.map((file) => file.name));
  const missing = REQUIRED.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`${path.relative(root, source)}/ is missing: ${missing.join(', ')}`);
  }

  const manifest = JSON.parse(files.find((file) => file.name === 'manifest.json').data.toString('utf8'));

  // The Pro build opens an offscreen document to read the device location. A
  // manifest that asks for the permission without shipping the document is not
  // loadable — which is exactly the state the previously committed dist/ was in.
  if (manifest.permissions?.includes('offscreen') && !present.has('offscreen.html')) {
    throw new Error(
      'manifest requests the "offscreen" permission but offscreen.html is not in the build',
    );
  }

  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    throw new Error(`manifest is ${manifest.version} but package.json is ${pkg.version}`);
  }

  await mkdir(artifacts, { recursive: true });
  const name = `grt-next-bus${free ? '-free' : ''}-${manifest.version}.zip`;
  const archivePath = path.join(artifacts, name);
  const bytes = createZip(files);
  await writeFile(archivePath, bytes);

  const entries = verifyZip(bytes);
  if (entries.length !== files.length) {
    throw new Error(`zip verification found ${entries.length} of ${files.length} entries`);
  }

  console.log(
    `wrote artifacts/${name}  "${manifest.name}"  ` +
      `(${entries.length} files, ${(bytes.length / 1024).toFixed(1)} kB, verified)`,
  );
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
