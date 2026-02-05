import { describe, expect, it, beforeEach, vi } from "vitest";
import path from "path";
import { NxAnalyzer } from "../src/analyzers/nx/index.js";

describe("NxAnalyzer", () => {
  let analyzer: NxAnalyzer;

  beforeEach(() => {
    analyzer = new NxAnalyzer();
  });

  describe("canAnalyze", () => {
    it("returns true for files in apps/ directory", () => {
      const filePath = "/workspace/apps/my-app/src/main.ts";
      expect(analyzer.canAnalyze(filePath)).toBe(true);
    });

    it("returns true for files in libs/ directory", () => {
      const filePath = "/workspace/libs/shared/utils/src/index.ts";
      expect(analyzer.canAnalyze(filePath)).toBe(true);
    });

    it("returns true for files in tools/ directory", () => {
      const filePath = "/workspace/tools/scripts/src/generator.ts";
      expect(analyzer.canAnalyze(filePath)).toBe(true);
    });

    it("returns true for files importing @nx/ packages", () => {
      const filePath = "/workspace/src/custom.ts";
      const content = `import { createProjectGraphAsync } from '@nx/devkit';`;
      expect(analyzer.canAnalyze(filePath, content)).toBe(true);
    });

    it("returns false for files outside NX structure without @nx imports", () => {
      const filePath = "/workspace/src/utils.ts";
      const content = `export function helper() { return 42; }`;
      expect(analyzer.canAnalyze(filePath, content)).toBe(false);
    });

    it("returns false for non-supported extensions", () => {
      const filePath = "/workspace/apps/my-app/styles.css";
      expect(analyzer.canAnalyze(filePath)).toBe(false);
    });
  });

  describe("analyze", () => {
    it("analyzes files in apps/ directory correctly", async () => {
      const filePath = path.join(process.cwd(), "apps", "my-app", "src", "main.ts");
      const code = `
import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent);
`;

      const result = await analyzer.analyze(filePath, code);

      expect(result.framework).toBe("nx");
      expect(result.language).toBe("typescript");
      // Note: "NX Workspace" pattern is only added when project.json is found
      // In unit tests without filesystem, we verify basic analysis works
      expect(result.imports.some((i) => i.source === "@angular/platform-browser")).toBe(true);
    });

    it("detects @nx/ package imports", async () => {
      const filePath = path.join(process.cwd(), "libs", "shared", "src", "generator.ts");
      const code = `
import { Tree, formatFiles, generateFiles } from '@nx/devkit';
import { libraryGenerator } from '@nx/js';

export async function myGenerator(tree: Tree) {
  await libraryGenerator(tree, { name: 'test' });
  await formatFiles(tree);
}
`;

      const result = await analyzer.analyze(filePath, code);

      const patterns = (result.metadata?.detectedPatterns || []) as Array<{ category: string; name: string }>;
      expect(patterns.some((p) => p.category === "nxPackage" && p.name === "@nx/devkit")).toBe(true);
      expect(patterns.some((p) => p.category === "nxPackage" && p.name === "@nx/js")).toBe(true);
    });

    it("extracts exports correctly", async () => {
      const filePath = path.join(process.cwd(), "libs", "utils", "src", "index.ts");
      const code = `
export function formatDate(date: Date): string {
  return date.toISOString();
}

export class Logger {
  log(message: string) {
    console.log(message);
  }
}

export const VERSION = '1.0.0';

export default function main() {}
`;

      const result = await analyzer.analyze(filePath, code);

      expect(result.exports.some((e) => e.name === "formatDate" && e.type === "function")).toBe(true);
      expect(result.exports.some((e) => e.name === "Logger" && e.type === "class")).toBe(true);
      expect(result.exports.some((e) => e.name === "VERSION" && e.type === "variable")).toBe(true);
      expect(result.exports.some((e) => e.name === "default" && e.isDefault)).toBe(true);
    });

    it("extracts imports correctly", async () => {
      const filePath = path.join(process.cwd(), "apps", "api", "src", "main.ts");
      const code = `
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import * as dotenv from 'dotenv';
import config from './config';
`;

      const result = await analyzer.analyze(filePath, code);

      expect(result.imports.some((i) => i.source === "@nestjs/core")).toBe(true);
      expect(result.imports.some((i) => i.source === "./app/app.module")).toBe(true);
      expect(result.imports.some((i) => i.source === "dotenv" && i.imports.includes("*"))).toBe(true);
      expect(result.imports.some((i) => i.source === "./config" && i.isDefault)).toBe(true);
    });

    it("handles JSX files correctly", async () => {
      const filePath = path.join(process.cwd(), "apps", "web", "src", "App.tsx");
      const code = `
import React from 'react';

export function App() {
  return <div>Hello NX!</div>;
}
`;

      const result = await analyzer.analyze(filePath, code);

      expect(result.framework).toBe("nx");
      expect(result.language).toBe("typescript");
      expect(result.components.some((c) => c.name === "App")).toBe(true);
    });
  });

  describe("summarize", () => {
    it("generates summary with project name when available", () => {
      const chunk = {
        id: "test-1",
        content: "test content",
        filePath: "/workspace/libs/utils/src/helper.ts",
        relativePath: "libs/utils/src/helper.ts",
        startLine: 1,
        endLine: 10,
        language: "typescript",
        framework: "nx",
        componentType: "function",
        dependencies: [],
        imports: [],
        exports: [],
        tags: [],
        metadata: {
          componentName: "formatDate",
          nxProject: { name: "utils" },
        },
      };

      const summary = analyzer.summarize(chunk);
      expect(summary).toContain("utils");
      expect(summary).toContain("helper.ts");
    });

    it("generates summary without project name", () => {
      const chunk = {
        id: "test-2",
        content: "test content",
        filePath: "/workspace/src/standalone.ts",
        relativePath: "src/standalone.ts",
        startLine: 1,
        endLine: 5,
        language: "typescript",
        framework: "nx",
        dependencies: [],
        imports: [],
        exports: [],
        tags: [],
        metadata: {},
      };

      const summary = analyzer.summarize(chunk);
      expect(summary).toContain("standalone.ts");
      expect(summary).toContain("lines 1-5");
    });
  });
});
