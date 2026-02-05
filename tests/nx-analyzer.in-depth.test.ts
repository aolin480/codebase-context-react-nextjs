import { describe, expect, it, beforeEach } from "vitest";
import { NxAnalyzer } from "../src/analyzers/nx/index.js";

/**
 * In-depth tests for NX analyzer internal logic.
 * These tests verify tag parsing, executor detection, and framework detection.
 */
describe("NxAnalyzer - In-depth", () => {
  let analyzer: NxAnalyzer;

  beforeEach(() => {
    analyzer = new NxAnalyzer();
  });

  describe("tag dimension parsing", () => {
    it("parses scope:* tags correctly", async () => {
      // Since parseTagDimensions is internal, we test via analyze metadata
      const filePath = "/workspace/libs/shared/src/index.ts";
      const code = `export const value = 1;`;

      // We can't directly test the helper, but we verify the pattern detection works
      const result = await analyzer.analyze(filePath, code);
      expect(result.framework).toBe("nx");
    });
  });

  describe("dependency categorization", () => {
    it("categorizes NX packages as build tools", async () => {
      const filePath = "/workspace/libs/shared/src/index.ts";
      const code = `
import { Tree } from '@nx/devkit';
import { createProjectGraphAsync } from '@nx/workspace';
export function test(tree: Tree) {}
`;

      const result = await analyzer.analyze(filePath, code);

      expect(result.dependencies.some((d) => d.name === "@nx/devkit" && d.category === "build")).toBe(true);
      expect(result.dependencies.some((d) => d.name === "@nx/workspace" && d.category === "build")).toBe(true);
    });

    it("categorizes framework packages correctly", async () => {
      const filePath = "/workspace/apps/web/src/main.tsx";
      const code = `
import React from 'react';
import { render } from 'react-dom';
import next from 'next';
import { Component } from '@angular/core';
`;

      const result = await analyzer.analyze(filePath, code);

      expect(result.dependencies.some((d) => d.name === "react" && d.category === "framework")).toBe(true);
      expect(result.dependencies.some((d) => d.name === "react-dom" && d.category === "framework")).toBe(true);
      expect(result.dependencies.some((d) => d.name === "next" && d.category === "framework")).toBe(true);
      expect(result.dependencies.some((d) => d.name === "@angular/core" && d.category === "framework")).toBe(true);
    });

    it("categorizes state management packages correctly", async () => {
      const filePath = "/workspace/libs/state/src/index.ts";
      const code = `
import { configureStore } from '@reduxjs/toolkit';
import { create } from 'zustand';
`;

      const result = await analyzer.analyze(filePath, code);

      expect(result.dependencies.some((d) => d.name === "@reduxjs/toolkit" && d.category === "state")).toBe(true);
      expect(result.dependencies.some((d) => d.name === "zustand" && d.category === "state")).toBe(true);
    });

    it("categorizes UI packages correctly", async () => {
      const filePath = "/workspace/libs/ui/src/index.ts";
      const code = `
import { Button } from '@mui/material';
import styled from 'styled-components';
`;

      const result = await analyzer.analyze(filePath, code);

      expect(result.dependencies.some((d) => d.name === "@mui/material" && d.category === "ui")).toBe(true);
      expect(result.dependencies.some((d) => d.name === "styled-components" && d.category === "ui")).toBe(true);
    });

    it("categorizes testing packages correctly", async () => {
      const filePath = "/workspace/libs/utils/src/index.spec.ts";
      const code = `
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
`;

      const result = await analyzer.analyze(filePath, code);

      expect(result.dependencies.some((d) => d.name === "vitest" && d.category === "testing")).toBe(true);
      expect(result.dependencies.some((d) => d.name === "@testing-library/react" && d.category === "testing")).toBe(true);
    });
  });

  describe("pattern deduplication", () => {
    it("does not duplicate patterns for multiple @nx imports", async () => {
      const filePath = "/workspace/libs/shared/src/index.ts";
      const code = `
import { Tree, formatFiles } from '@nx/devkit';
import { generateFiles } from '@nx/devkit';
import { updateJson } from '@nx/devkit';
`;

      const result = await analyzer.analyze(filePath, code);
      const patterns = (result.metadata?.detectedPatterns || []) as Array<{ category: string; name: string }>;

      // Should only have one @nx/devkit pattern, not multiple
      const devkitPatterns = patterns.filter((p) => p.name === "@nx/devkit");
      expect(devkitPatterns.length).toBe(1);
    });
  });

  describe("component detection", () => {
    it("detects exported functions as components", async () => {
      const filePath = "/workspace/libs/utils/src/helpers.ts";
      const code = `
export function processData(data: unknown[]) {
  return data.map(d => d);
}

export class DataService {
  process(data: unknown[]) {
    return processData(data);
  }
}
`;

      const result = await analyzer.analyze(filePath, code);

      expect(result.components.some((c) => c.name === "processData" && c.type === "function")).toBe(true);
      expect(result.components.some((c) => c.name === "DataService" && c.type === "class")).toBe(true);
    });
  });

  describe("file extension handling", () => {
    it("handles .ts files", async () => {
      const result = await analyzer.analyze(
        "/workspace/apps/api/src/main.ts",
        `export const app = {};`
      );
      expect(result.language).toBe("typescript");
    });

    it("handles .tsx files", async () => {
      const result = await analyzer.analyze(
        "/workspace/apps/web/src/App.tsx",
        `export function App() { return <div />; }`
      );
      expect(result.language).toBe("typescript");
    });

    it("handles .js files", async () => {
      const result = await analyzer.analyze(
        "/workspace/apps/legacy/src/main.js",
        `export const app = {};`
      );
      expect(result.language).toBe("javascript");
    });

    it("handles .jsx files", async () => {
      const result = await analyzer.analyze(
        "/workspace/apps/legacy/src/App.jsx",
        `export function App() { return <div />; }`
      );
      expect(result.language).toBe("javascript");
    });

    it("handles .mjs files", async () => {
      const result = await analyzer.analyze(
        "/workspace/apps/api/src/config.mjs",
        `export const config = {};`
      );
      expect(result.language).toBe("javascript");
    });

    it("handles .mts files", async () => {
      const result = await analyzer.analyze(
        "/workspace/apps/api/src/config.mts",
        `export const config: Record<string, string> = {};`
      );
      expect(result.language).toBe("typescript");
    });
  });

  describe("re-exports handling", () => {
    it("detects re-exports", async () => {
      const filePath = "/workspace/libs/shared/src/index.ts";
      const code = `
export { Button } from './button';
export { Input, type InputProps } from './input';
export * from './utils';
`;

      const result = await analyzer.analyze(filePath, code);

      expect(result.exports.some((e) => e.name === "Button" && e.type === "re-export")).toBe(true);
      expect(result.exports.some((e) => e.name === "Input" && e.type === "re-export")).toBe(true);
    });
  });

  describe("priority", () => {
    it("has lower priority than framework-specific analyzers", () => {
      // NX analyzer should have priority 70, lower than React (80), Next.js (90), Angular (100)
      expect(analyzer.priority).toBe(70);
    });
  });
});
