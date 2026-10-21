import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchitectureService } from "../src/index.ts";

const design = { version: 1 as const, components: [], decisions: ["external fixture"] };

test("architecture reads and writes refuse a symlinked metadata directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vcli-architecture-security-"));
  const root = join(directory, "project"),
    outside = join(directory, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, "main.ts"), "export const value = 1;");
    const original = JSON.stringify(design);
    await writeFile(join(outside, "architecture.json"), original);
    await symlink(outside, join(root, ".vcli"));
    const service = createArchitectureService();
    await expect(service.readDesign(root)).rejects.toThrow("symbolic links");
    await expect(
      service.writeDesign(root, { ...design, decisions: ["replacement"] }),
    ).rejects.toThrow("symbolic links");
    const graph = await service.scan(root);
    expect(graph.diagnostics).toContain(
      "Architecture index could not be read; rebuilding it from source",
    );
    expect(
      graph.diagnostics.some((value) => value.includes("Architecture index was not saved")),
    ).toBe(true);
    expect(await readFile(join(outside, "architecture.json"), "utf8")).toBe(original);
    expect(await readdir(outside)).toEqual(["architecture.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("architecture refuses linked metadata files and linked cache subdirectories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vcli-architecture-security-"));
  const root = join(directory, "project"),
    outside = join(directory, "outside");
  try {
    await mkdir(join(root, ".vcli"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(root, "main.ts"), "export const value = 1;");
    const external = join(outside, "design.json");
    await writeFile(external, JSON.stringify(design));
    const target = join(root, ".vcli/architecture.json");
    const service = createArchitectureService();
    for (const createLink of [symlink, link]) {
      await createLink(external, target);
      await expect(service.readDesign(root)).rejects.toThrow();
      await expect(service.writeDesign(root, design)).rejects.toThrow();
      await rm(target);
    }
    await symlink(outside, join(root, ".vcli/state"));
    const graph = await service.scan(root);
    expect(
      graph.diagnostics.some((value) => value.includes("Architecture index was not saved")),
    ).toBe(true);
    expect(await readdir(outside)).toEqual(["design.json"]);
    await rm(join(root, ".vcli/state"));
    await mkdir(join(root, ".vcli/state"));
    await symlink(external, join(root, ".vcli/state/architecture-index.json"));
    const linked = await service.scan(root);
    expect(
      linked.diagnostics.some((value) => value.includes("Architecture index was not saved")),
    ).toBe(true);
    expect(await readFile(external, "utf8")).toBe(JSON.stringify(design));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiler resolution cannot import metadata outside the project or protected state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vcli-architecture-input-"));
  const root = join(directory, "project");
  try {
    await mkdir(join(root, ".vcli"), { recursive: true });
    const hidden = JSON.stringify({ compilerOptions: { PRIVATE_SYNTHETIC_TOKEN: true } });
    await writeFile(join(directory, "outside.json"), hidden);
    await writeFile(join(root, ".vcli/config.json"), hidden);
    await writeFile(join(root, "main.ts"), 'import { value } from "@missing"; export { value };');
    for (const base of ["../outside.json", "./.vcli/config.json"]) {
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: base }));
      const graph = await createArchitectureService().scan(root);
      expect(graph.diagnostics.join("\n")).not.toContain("PRIVATE_SYNTHETIC_TOKEN");
      expect(graph.diagnostics.some((value) => value.includes("Cannot read file"))).toBe(true);
    }
    await rm(join(root, "tsconfig.json"));
    await symlink(join(directory, "outside.json"), join(root, "tsconfig.json"));
    const linked = await createArchitectureService().scan(root);
    expect(linked.diagnostics.join("\n")).not.toContain("PRIVATE_SYNTHETIC_TOKEN");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "architecture ignore and compiler metadata FIFOs do not block discovery",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vcli-architecture-fifo-"));
    try {
      for (const name of [".gitignore", "tsconfig.json"]) {
        const child = Bun.spawn(["mkfifo", join(root, name)]);
        expect(await child.exited).toBe(0);
      }
      await writeFile(join(root, "main.ts"), 'import { value } from "./dep"; export { value };');
      await writeFile(join(root, "dep.ts"), "export const value = 1;");
      const graph = await createArchitectureService().scan(root);
      expect(graph.nodes.some((value) => value.path === "main.ts")).toBe(true);
      expect(graph.diagnostics.some((value) => value.includes("regular files"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("architecture metadata writes obey the same size ceiling as subsequent reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "vcli-architecture-size-"));
  try {
    await expect(
      createArchitectureService().writeDesign(root, {
        ...design,
        decisions: ["x".repeat(1024 * 1024)],
      }),
    ).rejects.toThrow("exceeds 1 MiB");
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("architecture traversal and ignore complexity have aggregate limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "vcli-architecture-limits-"));
  try {
    let nested = root;
    for (let depth = 0; depth < 130; depth++) {
      nested = join(nested, "d");
      await mkdir(nested);
    }
    await expect(createArchitectureService().scan(root)).rejects.toThrow("depth exceeds 128");
    await rm(join(root, "d"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "ignored\n".repeat(1001));
    await expect(createArchitectureService().scan(root)).rejects.toThrow("rules exceed 1,000");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
