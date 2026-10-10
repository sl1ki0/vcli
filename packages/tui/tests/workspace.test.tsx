import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { testRender } from "@opentui/solid";
import { ImageRenderable } from "@opentui/core";
import { createTestRenderer, setRendererCapabilities } from "@opentui/core/testing";
import { layoutGraph, rasterize, renderSvg, sceneToViewport } from "@vcli/architecture";
import type { ArchitectureGraph, ArchitectureService } from "@vcli/core";
import { Workspace } from "../src/workspace.tsx";

const graph: ArchitectureGraph = {
  root: "/sample",
  revision: "a",
  nodes: [
    { id: "app", label: "App", kind: "module", path: "app.ts" },
    { id: "db", label: "Database", kind: "module", path: "db.ts" },
  ],
  edges: [{ id: "app-db", source: "app", target: "db", kind: "import" }],
  diagnostics: [],
  cycles: [],
  stats: { files: 2, parsed: 2, cached: 0, durationMs: 1 },
};
const architecture: ArchitectureService = {
  scan: async () => graph,
  readDesign: async () => ({
    version: 1,
    components: [{ id: "planned", label: "Planned API", paths: ["api/"] }],
    decisions: [],
  }),
  writeDesign: async () => {},
  intendedGraph: () => ({
    ...graph,
    revision: "intent",
    nodes: [{ id: "planned", label: "Planned API", kind: "component", status: "planned" }],
    edges: [],
  }),
  check: () => [],
};

async function waitForImage(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      setup.renderer.off("frame", inspect);
      reject(new Error("Diagram image did not load"));
    }, 3000);
    const inspect = () => {
      const image = setup.renderer.root.findDescendantById("architecture-image");
      if (image instanceof ImageRenderable && image.image && !image.loading) {
        clearTimeout(deadline);
        setup.renderer.off("frame", inspect);
        resolve();
      }
    };
    setup.renderer.on("frame", inspect);
    inspect();
    setup.renderer.requestRender();
  });
}

describe("visual workspace", () => {
  test("proposal presentation finishes before the next agent action", async () => {
    let capture = () => "",
      proposedFrame = "";
    let presented!: () => void;
    const completed = new Promise<void>((resolve) => {
      presented = resolve;
    });
    const setup = await testRender(
      () => (
        <Workspace
          root="/sample"
          graph={graph}
          architecture={architecture}
          permission="yolo"
          renderer="kitty"
          run={async (_prompt, _signal, emit) => {
            await emit({
              type: "tool-end",
              sessionId: "test",
              time: "now",
              data: {
                name: "architecture_propose",
                result: "design",
                details: {
                  intended: architecture.intendedGraph("/sample", {
                    version: 1,
                    components: [],
                    decisions: [],
                  }),
                },
              },
            });
            proposedFrame = capture();
            presented();
            return {
              id: "test",
              root: "/sample",
              provider: "fixture",
              model: "fixture",
              status: "complete",
              createdAt: "now",
              updatedAt: "now",
              messages: [],
              ledger: {
                goal: "design",
                constraints: [],
                decisions: [],
                pending: [],
                verification: [],
                touchedPaths: [],
              },
              usage: { input: 0, output: 0, cached: 0 },
            };
          }}
        />
      ),
      { width: 120, height: 30 },
    );
    try {
      capture = setup.captureCharFrame;
      setup.renderer.emit(
        "capabilities",
        setRendererCapabilities(setup.renderer, { kitty_graphics: true, multiplexer: "none" }),
      );
      await setup.mockInput.typeText("Design a component");
      setup.mockInput.pressEnter();
      await completed;
      expect(proposedFrame).toContain("INTENDED");
      expect(proposedFrame).toContain("Planned API");
      expect(proposedFrame).not.toContain("Architecture intended");
    } finally {
      setup.renderer.destroy();
    }
  });
  test("tree fallback supports keyboard view changes and narrow resize", async () => {
    const setup = await testRender(
      () => (
        <Workspace
          root="/sample"
          graph={graph}
          architecture={architecture}
          permission="yolo"
          renderer="off"
        />
      ),
      { width: 120, height: 30 },
    );
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("YOLO");
      expect(setup.captureCharFrame()).toContain("tree fallback");
      setup.mockInput.pressTab();
      await setup.flush();
      setup.mockInput.pressKey("v");
      await setup.waitForFrame((frame) => frame.includes("INTENDED"));
      await setup.waitForFrame((frame) => frame.includes("Planned API"));
      setup.resize(80, 24);
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("INTENDED");
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressEscape();
      await setup.flush();
    } finally {
      setup.renderer.destroy();
    }
  });
  test("new graphics capabilities enable the managed image surface", async () => {
    const setup = await testRender(
      () => (
        <Workspace
          root="/sample"
          graph={graph}
          architecture={architecture}
          permission="read-only"
          renderer="auto"
        />
      ),
      { width: 100, height: 30 },
    );
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("tree fallback");
      setup.renderer.emit(
        "capabilities",
        setRendererCapabilities(setup.renderer, { kitty_graphics: true, multiplexer: "none" }),
      );
      await setup.waitForFrame((frame) => !frame.includes("tree fallback"));
      setup.renderer.emit(
        "capabilities",
        setRendererCapabilities(setup.renderer, { kitty_graphics: false, sixel: false }),
      );
      await setup.waitForFrame((frame) => frame.includes("tree fallback"));
    } finally {
      setup.renderer.destroy();
    }
  });
  test.each(["kitty", "sixel"] as const)("real %s images reach the transport", async (protocol) => {
    const chunks: string[] = [];
    const stdout = Object.assign(
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
          callback();
        },
      }),
      { isTTY: true, columns: 50, rows: 20, getColorDepth: () => 24 },
    ) as NodeJS.WriteStream;
    const setup = await createTestRenderer({
      stdout,
      bufferedOutput: "stdout",
      width: 50,
      height: 20,
    });
    try {
      // Sixel needs the terminal's reported pixel size, unlike Kitty placement.
      Object.defineProperty(setup.renderer, "resolution", {
        configurable: true,
        get: () => ({ width: 500, height: 400 }),
      });
      setRendererCapabilities(setup.renderer, {
        kitty_graphics: protocol === "kitty",
        sixel: protocol === "sixel",
        multiplexer: "none",
      });
      const png = rasterize(renderSvg(await layoutGraph(graph)));
      const image = new ImageRenderable(setup.renderer, {
        id: "test-graph",
        source: png,
        width: 45,
        height: 16,
        protocol,
      });
      setup.renderer.root.add(image);
      await image.loadPromise;
      await setup.flush();
      expect(image.effectiveProtocol).toBe(protocol);
      if (protocol === "kitty") expect(chunks.join("")).toContain("\u001b_G");
      else expect(chunks.join("")).toMatch(/\u001bP[^q]*q/);
    } finally {
      setup.renderer.destroy();
    }
  });
  test("mouse selection uses the same viewport after terminal resizing", async () => {
    const setup = await testRender(
      () => (
        <Workspace
          root="/sample"
          graph={graph}
          architecture={architecture}
          permission="yolo"
          renderer="kitty"
        />
      ),
      { width: 120, height: 30, useMouse: true },
    );
    try {
      setup.renderer.emit(
        "capabilities",
        setRendererCapabilities(setup.renderer, { kitty_graphics: true, multiplexer: "none" }),
      );
      const scene = await layoutGraph(graph);
      await waitForImage(setup);
      for (const [width, height, target] of [
        [120, 30, "db"],
        [80, 24, "app"],
      ] as const) {
        setup.resize(width, height);
        await setup.flush();
        await waitForImage(setup);
        const treeWidth = width < 110 ? 0 : 25,
          inspectorWidth = width < 110 ? 0 : 28;
        const canvasWidth = width - treeWidth - inspectorWidth,
          canvasHeight = height - 11;
        const node = scene.nodes.find((node) => node.id === target)!;
        const point = sceneToViewport(
          { x: node.x + node.width / 2, y: node.y + node.height / 2 },
          {
            x: 0,
            y: 0,
            zoom: Math.min((canvasWidth * 10) / scene.width, (canvasHeight * 20) / scene.height),
            width: canvasWidth * 10,
            height: canvasHeight * 20,
          },
        );
        await setup.mockMouse.click(
          treeWidth + Math.floor(point.x / 10),
          2 + Math.floor(point.y / 20),
        );
        await setup.waitForFrame((frame) => frame.includes(`${target}.ts`));
      }
    } finally {
      setup.renderer.destroy();
    }
  });
});
