// Renders each page in this folder to docs/screenshots/<page>.png with headless Chrome at 2x.
// A page states its size in CSS pixels: <meta name="screenshot-size" content="<width>x<height>">.
import { mkdirSync, readdirSync } from "node:fs";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const dir = import.meta.dir;
const out = `${dir}/../../docs/screenshots`;
mkdirSync(out, { recursive: true });

for (const page of readdirSync(dir).filter((f) => f.endsWith(".html"))) {
	const html = await Bun.file(`${dir}/${page}`).text();
	const size = html.match(/name="screenshot-size" content="(\d+)x(\d+)"/);
	if (size === null) throw new Error(`${page}: no screenshot-size meta`);
	const png = `${out}/${page.replace(/\.html$/, ".png")}`;
	const run = Bun.spawnSync([
		chrome,
		"--headless=new",
		"--hide-scrollbars",
		"--force-device-scale-factor=2",
		`--window-size=${size[1]},${size[2]}`,
		`--screenshot=${png}`,
		`file://${dir}/${page}`,
	]);
	if (run.exitCode !== 0)
		throw new Error(`${page}: Chrome exited ${run.exitCode}\n${run.stderr}`);
	console.log(png);
}
