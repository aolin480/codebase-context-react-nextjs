import { describe, expect, it } from "vitest";
import path from "path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { analyzerRegistry } from "../src/core/analyzer-registry.js";
import { CodebaseIndexer } from "../src/core/indexer.js";
import { AngularAnalyzer } from "../src/analyzers/angular/index.js";
import { NextJsAnalyzer } from "../src/analyzers/nextjs/index.js";
import { ReactAnalyzer } from "../src/analyzers/react/index.js";
import { GenericAnalyzer } from "../src/analyzers/generic/index.js";

function resetRegistry() {
  for (const analyzer of analyzerRegistry.getAll()) {
    analyzerRegistry.unregister(analyzer.name);
  }
}

describe("CodebaseIndexer metadata aggregation", () => {
  it("prefers framework metadata with real dependencies over higher-priority unknowns", async () => {
    resetRegistry();
    analyzerRegistry.register(new AngularAnalyzer());
    analyzerRegistry.register(new NextJsAnalyzer());
    analyzerRegistry.register(new ReactAnalyzer());
    analyzerRegistry.register(new GenericAnalyzer());

    const tmpRoot = path.join(process.cwd(), "tests", ".tmp", `meta-${randomUUID()}`);
    await mkdir(tmpRoot, { recursive: true });

    try {
      await writeFile(
        path.join(tmpRoot, "package.json"),
        JSON.stringify(
          {
            name: "tmp-next",
            dependencies: {
              next: "^14.1.0",
              react: "^18.2.0",
              "react-dom": "^18.2.0"
            }
          },
          null,
          2
        ),
        "utf-8"
      );

      const indexer = new CodebaseIndexer({ rootPath: tmpRoot });
      const metadata = await indexer.detectMetadata();

      expect(metadata.framework?.type).toBe("nextjs");
      expect(metadata.framework?.version).toBe("14.1.0");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
      resetRegistry();
    }
  });
});
