import { copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "worker", "public");
const privateDataPath = resolve(root, "worker", "generated", "private-data.js");
const assets = [
    ["index.html", "index.html"],
    ["update-index.html", "update-index.html"],
    ["worker/login.html", "login.html"],
    ["style/ico.png", "style/ico.png"],
];

const validFileName = (fileName) =>
    typeof fileName === "string" &&
    /^[^/\\\u0000-\u001f\u007f]{1,240}$/u.test(fileName) &&
    !fileName.startsWith(".") &&
    (fileName.toLowerCase().endsWith(".yaml") || !fileName.includes("."));

const index = JSON.parse(await readFile(resolve(root, "files_info.json"), "utf8"));
if (!Array.isArray(index.files)) {
    throw new Error("files_info.json must contain a files array");
}

const privateFiles = Object.create(null);
for (const item of index.files) {
    for (const fileName of [item.node_name, item.yaml_name]) {
        if (fileName == null) {
            continue;
        }
        if (!validFileName(fileName)) {
            throw new Error(`Invalid private node file name in files_info.json: ${fileName}`);
        }
        const filePath = resolve(root, fileName);
        const fileStats = await lstat(filePath);
        if (!fileStats.isFile()) {
            throw new Error(`Private node path is not a file: ${fileName}`);
        }
        privateFiles[fileName] = await readFile(filePath, "utf8");
    }
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const [source, destination] of assets) {
    const destinationPath = resolve(outputDirectory, destination);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(resolve(root, source), destinationPath);
}

await mkdir(dirname(privateDataPath), { recursive: true });
await writeFile(privateDataPath, `export default new Map(${JSON.stringify(Object.entries(privateFiles))});\n`);

console.log(`Prepared ${assets.length} static assets and ${Object.keys(privateFiles).length} private node files`);
