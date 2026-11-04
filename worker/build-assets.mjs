import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "worker", "public");
const assets = [
    ["update-index.html", "update-index.html"],
    ["worker/login.html", "login.html"],
    ["style/ico.png", "style/ico.png"],
];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const [source, destination] of assets) {
    const destinationPath = resolve(outputDirectory, destination);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(resolve(root, source), destinationPath);
}

console.log(`Prepared ${assets.length} static assets`);
