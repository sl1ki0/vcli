import { mkdir, copyFile, readdir, readFile, writeFile, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";
import { prepareProcessSupervisor } from "../apps/cli/src/workflows/process-supervisor.ts";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, "dist/vcli");
await mkdir(resolve(root, "dist"), { recursive: true });
// Standalone clients carry their native supervisor and never require a runtime compiler.
const supervisorBase64 =
  process.platform === "darwin"
    ? (await readFile(await prepareProcessSupervisor())).toString("base64")
    : undefined;
const result = await Bun.build({
  entrypoints: [
    resolve(root, "apps/cli/src/index.ts"),
    resolve(root, "packages/architecture/src/layout-worker.ts"),
  ],
  root,
  target: "bun",
  conditions: ["bun"],
  define: {
    "process.env.OPENTUI_LIBC": JSON.stringify(process.env.OPENTUI_LIBC ?? "glibc"),
    __VCLI_PROCESS_SUPERVISOR_BASE64__: JSON.stringify(supervisorBase64) ?? "undefined",
  },
  plugins: [solidPlugin],
  compile: {
    outfile: output,
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
  minify: process.env.VCLI_BUILD_DEBUG !== "1",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await copyFile(
  resolve(root, "THIRD_PARTY_NOTICES.md"),
  resolve(root, "dist/THIRD_PARTY_NOTICES.md"),
);
await copyFile(resolve(root, "docs/artifact-quickstart.md"), resolve(root, "dist/README.md"));
await copyFile(resolve(root, "docs/local-workflows.md"), resolve(root, "dist/WORKFLOWS.md"));
await copyFile(resolve(root, "docs/runtime.md"), resolve(root, "dist/RUNTIME.md"));
await copyFile(
  resolve(root, "packages/architecture/resources/OFL.txt"),
  resolve(root, "dist/JetBrainsMono-OFL.txt"),
);
const licenseRoot = join(root, "dist/licenses");
const seen = new Set<string>();
const index: { name: string; version: string; license: unknown; files: string[] }[] = [];
for (const entry of await readdir(join(root, "node_modules/.bun"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const modules = join(root, "node_modules/.bun", entry.name, "node_modules");
  for (const candidate of await readdir(modules).catch(() => [] as string[])) {
    const names = candidate.startsWith("@")
      ? (await readdir(join(modules, candidate))).map((name) => `${candidate}/${name}`)
      : [candidate];
    for (const name of names) {
      const directory = await realpath(join(modules, name));
      if (seen.has(directory)) continue;
      seen.add(directory);
      const metadata = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8").catch(() => "null"),
      );
      if (!metadata) continue;
      const files = (await readdir(directory)).filter((file) =>
        /^(LICENSE|LICENCE|COPYING|NOTICE)([.-].*)?$/i.test(file),
      );
      const destination = join(
        licenseRoot,
        `${metadata.name.replaceAll("/", "__")}@${metadata.version}`,
      );
      await mkdir(destination, { recursive: true });
      for (const file of files) await copyFile(join(directory, file), join(destination, file));
      index.push({
        name: metadata.name,
        version: metadata.version,
        license: metadata.license,
        files,
      });
    }
  }
}
index.sort((a, b) => a.name.localeCompare(b.name));
await writeFile(join(licenseRoot, "index.json"), JSON.stringify(index, null, 2) + "\n");
await mkdir(join(licenseRoot, "bun"), { recursive: true });
if (Bun.version === "1.3.13")
  await copyFile(join(root, "licenses/Bun-1.3.13.md"), join(licenseRoot, "bun/LICENSE.md"));
else {
  const bunNotices = await fetch(
    `https://raw.githubusercontent.com/oven-sh/bun/bun-v${Bun.version}/LICENSE.md`,
  );
  if (!bunNotices.ok)
    throw new Error("Cannot preserve the Bun runtime license; build is not distributable.");
  await writeFile(join(licenseRoot, "bun/LICENSE.md"), await bunNotices.text());
}
console.log(`Built ${output} for ${process.platform}/${process.arch}.`);
