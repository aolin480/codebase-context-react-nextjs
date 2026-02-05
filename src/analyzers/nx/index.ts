/**
 * NX Analyzer - Monorepo-aware analysis for NX workspaces.
 *
 * Detects:
 * - NX workspace structure (apps, libs, tools)
 * - Project boundaries and dependencies
 * - Project tags for categorization
 * - Executors and plugins in use
 *
 * No runtime execution: filesystem + AST only.
 */

import { promises as fs } from "fs";
import path from "path";
import { parse } from "@typescript-eslint/typescript-estree";
import {
  AnalysisResult,
  CodebaseMetadata,
  CodeChunk,
  CodeComponent,
  Dependency,
  ExportStatement,
  FrameworkAnalyzer,
  ImportStatement,
  PackageInfo,
} from "../../types/index.js";
import { createChunksFromCode } from "../../utils/chunking.js";
import { parseJsonInWorker } from "../../utils/async-json.js";
import { getIndexStatsMaxBytes } from "../../utils/index-stats-threshold.js";
import {
  getPackageName,
  mergeDependencies,
  readRootPackageJson,
} from "../orchestration/package-json.js";

type DetectedPattern = { category: string; name: string };

interface NxProjectJson {
  name?: string;
  $schema?: string;
  root?: string;
  sourceRoot?: string;
  projectType?: "application" | "library";
  tags?: string[];
  targets?: Record<string, NxTarget>;
  implicitDependencies?: string[];
  namedInputs?: Record<string, string[]>;
}

interface NxTarget {
  executor?: string;
  dependsOn?: string[];
  inputs?: string[];
  outputs?: string[];
  cache?: boolean;
  options?: Record<string, unknown>;
  configurations?: Record<string, unknown>;
}

interface NxJson {
  $schema?: string;
  extends?: string;
  targetDefaults?: Record<string, NxTarget>;
  namedInputs?: Record<string, string[]>;
  plugins?: Array<string | { plugin: string; options?: Record<string, unknown> }>;
  defaultProject?: string;
  defaultBase?: string;
  parallel?: number;
  cacheDirectory?: string;
  useDaemonProcess?: boolean;
  workspaceLayout?: {
    appsDir?: string;
    libsDir?: string;
  };
  generators?: Record<string, Record<string, unknown>>;
  release?: {
    version?: Record<string, unknown>;
    changelog?: Record<string, unknown>;
  };
  nxCloudAccessToken?: string;
  nxCloudUrl?: string;
}

interface NxProjectInfo {
  name: string;
  root: string;
  sourceRoot?: string;
  projectType: "application" | "library" | "unknown";
  tags: string[];
  /** Parsed tag dimensions (e.g., { scope: "shared", type: "util" }) */
  tagDimensions: Record<string, string>;
  targets: string[];
  /** Executors used by targets (e.g., ["@nx/jest:jest", "@nx/js:tsc"]) */
  executors: string[];
  implicitDependencies: string[];
}

export class NxAnalyzer implements FrameworkAnalyzer {
  readonly name = "nx";
  readonly version = "1.0.0";
  readonly supportedExtensions = [
    ".tsx",
    ".jsx",
    ".ts",
    ".js",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
  ];
  readonly priority = 70; // Lower than framework-specific analyzers

  // Cache for project info lookups
  private projectCache = new Map<string, NxProjectInfo | null>();
  private nxJsonCache: NxJson | null = null;
  private workspaceRoot: string | null = null;

  canAnalyze(filePath: string, content?: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (!this.supportedExtensions.includes(ext)) return false;

    // Check if file is in an NX workspace structure
    const normalizedPath = filePath.replace(/\\/g, "/");

    // Strong signals: file is in apps/, libs/, or tools/ directory
    if (/\/(apps|libs|tools)\//.test(normalizedPath)) return true;

    // Content-based: imports from @nx/ packages
    if (content && /from\s+['"]@nx\//.test(content)) return true;

    return false;
  }

  async analyze(filePath: string, content: string): Promise<AnalysisResult> {
    const ext = path.extname(filePath).toLowerCase();
    const isJsx = ext.includes("x");
    const language =
      ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts"
        ? "typescript"
        : "javascript";
    const relativePath = path.relative(process.cwd(), filePath);

    const components: CodeComponent[] = [];
    const imports: ImportStatement[] = [];
    const exports: ExportStatement[] = [];
    const dependencies: string[] = [];
    const detectedPatterns: DetectedPattern[] = [];

    // Determine which NX project this file belongs to
    const projectInfo = await this.findProjectForFile(filePath);

    if (projectInfo) {
      detectedPatterns.push({ category: "monorepo", name: "NX Workspace" });

      if (projectInfo.projectType === "application") {
        detectedPatterns.push({ category: "projectType", name: "NX Application" });
      } else if (projectInfo.projectType === "library") {
        detectedPatterns.push({ category: "projectType", name: "NX Library" });
      }

      // Track project tags as patterns
      for (const tag of projectInfo.tags) {
        detectedPatterns.push({ category: "nxTag", name: tag });
      }
    }

    try {
      const ast = parse(content, {
        loc: true,
        range: true,
        comment: true,
        jsx: isJsx,
        sourceType: "module",
      });

      // Process imports and exports
      for (const node of ast.body) {
        if (node.type === "ImportDeclaration" && node.source.value) {
          const source = node.source.value as string;
          imports.push({
            source,
            imports: node.specifiers.map((s: any) => {
              if (s.type === "ImportDefaultSpecifier") return "default";
              if (s.type === "ImportNamespaceSpecifier") return "*";
              return s.imported?.name || s.local?.name || "unknown";
            }),
            isDefault: node.specifiers.some(
              (s: any) => s.type === "ImportDefaultSpecifier"
            ),
            isDynamic: false,
            line: node.loc?.start.line,
          });

          if (!source.startsWith(".") && !source.startsWith("/")) {
            dependencies.push(getPackageName(source));
          }

          // Detect NX-specific imports
          if (source.startsWith("@nx/")) {
            detectedPatterns.push({
              category: "nxPackage",
              name: source.split("/").slice(0, 2).join("/"),
            });
          }
        }

        // Named exports
        if (node.type === "ExportNamedDeclaration") {
          if (node.declaration?.type === "FunctionDeclaration" && node.declaration.id) {
            exports.push({
              name: node.declaration.id.name,
              isDefault: false,
              type: "function",
            });
            components.push(
              toComponent(node.declaration, "function", "function", {
                nxProject: projectInfo?.name,
              })
            );
          } else if (node.declaration?.type === "ClassDeclaration" && node.declaration.id) {
            exports.push({
              name: node.declaration.id.name,
              isDefault: false,
              type: "class",
            });
            components.push(
              toComponent(node.declaration, "class", "class", {
                nxProject: projectInfo?.name,
              })
            );
          } else if (node.declaration?.type === "VariableDeclaration") {
            for (const decl of node.declaration.declarations) {
              if (decl.id.type === "Identifier") {
                exports.push({
                  name: decl.id.name,
                  isDefault: false,
                  type: "variable",
                });
              }
            }
          } else if (node.specifiers && node.specifiers.length > 0) {
            for (const s of node.specifiers as any[]) {
              if (s.exported?.name) {
                exports.push({
                  name: s.exported.name,
                  isDefault: false,
                  type: "re-export",
                });
              }
            }
          }
        }

        // Default export
        if (node.type === "ExportDefaultDeclaration") {
          exports.push({ name: "default", isDefault: true, type: "default" });
        }
      }
    } catch (error) {
      console.warn(`Failed to parse NX file ${filePath}:`, error);
    }

    const uniqueDependencies = Array.from(new Set(dependencies)).sort();

    // Deduplicate patterns
    const uniquePatterns = deduplicatePatterns(detectedPatterns);

    const chunks = await createChunksFromCode(
      content,
      filePath,
      relativePath,
      language,
      components,
      {
        framework: "nx",
        detectedPatterns: uniquePatterns,
        nxProject: projectInfo
          ? {
              name: projectInfo.name,
              type: projectInfo.projectType,
              tags: projectInfo.tags,
            }
          : undefined,
      }
    );

    return {
      filePath,
      language,
      framework: "nx",
      components,
      imports,
      exports,
      dependencies: uniqueDependencies.map((name) => ({
        name,
        category: this.categorizeDependency(name),
      })),
      metadata: {
        analyzer: this.name,
        nxProject: projectInfo,
        detectedPatterns: uniquePatterns,
      },
      chunks,
    };
  }

  async detectCodebaseMetadata(rootPath: string): Promise<CodebaseMetadata> {
    this.workspaceRoot = rootPath;

    const rootPkg = await readRootPackageJson(rootPath);
    const packageJson = rootPkg?.packageJson;
    const projectName = packageJson?.name || path.basename(rootPath);
    const allDeps = packageJson ? mergeDependencies(packageJson) : {};

    // Load nx.json
    const nxJson = await this.loadNxJson(rootPath);
    this.nxJsonCache = nxJson;

    // Discover all projects
    const projects = await this.discoverProjects(rootPath, nxJson);

    // Detect NX plugins in use
    const nxPlugins = extractNxPlugins(nxJson);

    // Build dependencies list
    const dependencies: Dependency[] = Object.entries(allDeps).map(
      ([name, version]) => ({
        name,
        version: version as string,
        category: this.categorizeDependency(name),
      })
    );

    // Convert projects to PackageInfo format
    const packages: PackageInfo[] = projects.map((p) => ({
      name: p.name,
      path: p.root,
      type: p.projectType === "application" ? "app" : "library",
      framework: detectProjectFramework(p),
    }));

    // Determine workspace layout
    const appsDir = nxJson?.workspaceLayout?.appsDir || "apps";
    const libsDir = nxJson?.workspaceLayout?.libsDir || "libs";

    // Statistics from existing index
    const statistics = await tryLoadIndexStatistics(rootPath);

    return {
      name: projectName,
      rootPath,
      framework: {
        name: "NX",
        version: allDeps["nx"] || "unknown",
        type: "other",
        variant: "monorepo",
        stateManagement: detectStateLibraries(allDeps),
        uiLibraries: detectUiLibraries(allDeps),
        testingFrameworks: detectTestingLibraries(allDeps),
      },
      languages: [],
      dependencies,
      architecture: {
        type: "modular",
        layers: {
          presentation: 0,
          business: 0,
          data: 0,
          state: 0,
          core: 0,
          shared: 0,
          feature: 0,
          infrastructure: 0,
          unknown: 0,
        },
        modules: projects.map((p) => ({
          name: p.name,
          path: p.root,
          type: p.projectType,
          dependencies: p.implicitDependencies,
          exports: [],
        })),
        patterns: ["NX Monorepo", ...nxPlugins],
      },
      styleGuides: [],
      documentation: [],
      projectStructure: {
        type: "monorepo",
        workspaces: [appsDir, libsDir],
        packages,
      },
      statistics,
      customMetadata: {
        nxVersion: allDeps["nx"],
        plugins: nxPlugins,
        projectCount: projects.length,
        appCount: projects.filter((p) => p.projectType === "application").length,
        libCount: projects.filter((p) => p.projectType === "library").length,
        // Workspace configuration from nx.json
        defaultBase: nxJson?.defaultBase,
        parallel: nxJson?.parallel,
        usesNxCloud: Boolean(nxJson?.nxCloudAccessToken || nxJson?.nxCloudUrl),
        useDaemon: nxJson?.useDaemonProcess,
        // Tag dimensions summary
        tagDimensions: summarizeTagDimensions(projects),
        // All executors used across workspace
        executors: collectAllExecutors(projects),
        // Target defaults defined in nx.json
        targetDefaults: nxJson?.targetDefaults ? Object.keys(nxJson.targetDefaults) : [],
      },
    };
  }

  summarize(chunk: CodeChunk): string {
    const name = chunk.metadata?.componentName;
    const type = chunk.componentType;
    const fileName = path.basename(chunk.filePath);
    const project = chunk.metadata?.nxProject as { name?: string } | undefined;

    if (project?.name) {
      if (name && type) return `${name} (${type}) in ${project.name}/${fileName}.`;
      return `Code in ${project.name}/${fileName}: lines ${chunk.startLine}-${chunk.endLine}.`;
    }

    if (name && type) return `${name} (${type}) in ${fileName}.`;
    return `NX workspace code in ${fileName}: lines ${chunk.startLine}-${chunk.endLine}.`;
  }

  private async findProjectForFile(filePath: string): Promise<NxProjectInfo | null> {
    // Walk up directory tree looking for project.json
    let currentDir = path.dirname(filePath);
    const root = path.parse(currentDir).root;
    const maxDepth = 10;
    let depth = 0;

    while (currentDir !== root && depth < maxDepth) {
      // Check cache
      if (this.projectCache.has(currentDir)) {
        return this.projectCache.get(currentDir) || null;
      }

      const projectJsonPath = path.join(currentDir, "project.json");

      try {
        const content = await fs.readFile(projectJsonPath, "utf-8");
        const projectJson: NxProjectJson = JSON.parse(content);

        const tags = projectJson.tags || [];
        const targets = projectJson.targets || {};
        const projectInfo: NxProjectInfo = {
          name: projectJson.name || path.basename(currentDir),
          root: currentDir,
          sourceRoot: projectJson.sourceRoot,
          projectType: projectJson.projectType || "unknown",
          tags,
          tagDimensions: parseTagDimensions(tags),
          targets: Object.keys(targets),
          executors: extractExecutors(targets),
          implicitDependencies: projectJson.implicitDependencies || [],
        };

        this.projectCache.set(currentDir, projectInfo);
        return projectInfo;
      } catch {
        // No project.json at this level, continue up
      }

      currentDir = path.dirname(currentDir);
      depth++;
    }

    return null;
  }

  private async loadNxJson(rootPath: string): Promise<NxJson | null> {
    try {
      const nxJsonPath = path.join(rootPath, "nx.json");
      const content = await fs.readFile(nxJsonPath, "utf-8");
      return JSON.parse(content) as NxJson;
    } catch {
      return null;
    }
  }

  private async discoverProjects(
    rootPath: string,
    nxJson: NxJson | null
  ): Promise<NxProjectInfo[]> {
    const projects: NxProjectInfo[] = [];
    const appsDir = nxJson?.workspaceLayout?.appsDir || "apps";
    const libsDir = nxJson?.workspaceLayout?.libsDir || "libs";

    // Search in apps, libs, and tools directories
    const searchDirs = [
      path.join(rootPath, appsDir),
      path.join(rootPath, libsDir),
      path.join(rootPath, "tools"),
    ];

    for (const searchDir of searchDirs) {
      try {
        const entries = await fs.readdir(searchDir, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const projectDir = path.join(searchDir, entry.name);
          const projectJsonPath = path.join(projectDir, "project.json");

          try {
            const content = await fs.readFile(projectJsonPath, "utf-8");
            const projectJson: NxProjectJson = JSON.parse(content);

            const tags = projectJson.tags || [];
            const targets = projectJson.targets || {};
            projects.push({
              name: projectJson.name || entry.name,
              root: path.relative(rootPath, projectDir),
              sourceRoot: projectJson.sourceRoot,
              projectType: projectJson.projectType || "unknown",
              tags,
              tagDimensions: parseTagDimensions(tags),
              targets: Object.keys(targets),
              executors: extractExecutors(targets),
              implicitDependencies: projectJson.implicitDependencies || [],
            });
          } catch {
            // No project.json, might be a nested structure - check subdirectories
            await this.discoverNestedProjects(projectDir, rootPath, projects);
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    return projects;
  }

  private async discoverNestedProjects(
    dir: string,
    rootPath: string,
    projects: NxProjectInfo[]
  ): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const projectDir = path.join(dir, entry.name);
        const projectJsonPath = path.join(projectDir, "project.json");

        try {
          const content = await fs.readFile(projectJsonPath, "utf-8");
          const projectJson: NxProjectJson = JSON.parse(content);

          const tags = projectJson.tags || [];
          const targets = projectJson.targets || {};
          projects.push({
            name: projectJson.name || entry.name,
            root: path.relative(rootPath, projectDir),
            sourceRoot: projectJson.sourceRoot,
            projectType: projectJson.projectType || "unknown",
            tags,
            tagDimensions: parseTagDimensions(tags),
            targets: Object.keys(targets),
            executors: extractExecutors(targets),
            implicitDependencies: projectJson.implicitDependencies || [],
          });
        } catch {
          // No project.json at this level
        }
      }
    } catch {
      // Can't read directory
    }
  }

  private categorizeDependency(name: string): Dependency["category"] {
    if (name === "nx" || name.startsWith("@nx/")) return "build";
    if (name === "react" || name === "react-dom" || name === "@angular/core") return "framework";
    if (name === "next") return "framework";
    if (name.startsWith("@reduxjs/") || name === "redux" || name === "zustand") return "state";
    if (name === "@tanstack/react-query" || name === "swr" || name === "@apollo/client") return "http";
    if (name === "tailwindcss" || name === "@mui/material" || name === "styled-components") return "ui";
    if (name === "vitest" || name === "jest" || name === "@testing-library/react") return "testing";
    if (name === "typescript" || name === "eslint" || name === "vite") return "build";
    return "other";
  }
}

function toComponent(
  node: any,
  type: string,
  componentType: string,
  metadata: Record<string, unknown>
): CodeComponent {
  const startLine = node.loc?.start?.line ?? 1;
  const endLine = node.loc?.end?.line ?? startLine;
  const name = node.id?.name || "unknown";

  return {
    name,
    type,
    componentType,
    startLine,
    endLine,
    metadata,
  };
}

function deduplicatePatterns(patterns: DetectedPattern[]): DetectedPattern[] {
  const seen = new Set<string>();
  const result: DetectedPattern[] = [];

  for (const p of patterns) {
    const key = `${p.category}:${p.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  }

  return result;
}

function extractNxPlugins(nxJson: NxJson | null): string[] {
  if (!nxJson?.plugins) return [];

  return nxJson.plugins.map((p) => {
    if (typeof p === "string") return p;
    return p.plugin;
  });
}

/**
 * Parse NX project tags into dimension:value pairs.
 * Common conventions: scope:shared, type:util, scope:admin, type:feature
 * See: https://nx.dev/docs/features/enforce-module-boundaries
 */
function parseTagDimensions(tags: string[]): Record<string, string> {
  const dimensions: Record<string, string> = {};

  for (const tag of tags) {
    // Handle colon-separated tags (e.g., "scope:shared", "type:util")
    if (tag.includes(":")) {
      const [dimension, value] = tag.split(":", 2);
      if (dimension && value) {
        dimensions[dimension] = value;
      }
    }
  }

  return dimensions;
}

/**
 * Extract executor names from project targets.
 * Returns unique executors like ["@nx/jest:jest", "@nx/js:tsc"]
 */
function extractExecutors(targets: Record<string, NxTarget>): string[] {
  const executors = new Set<string>();

  for (const target of Object.values(targets)) {
    if (target.executor) {
      executors.add(target.executor);
    }
  }

  return Array.from(executors).sort();
}

function detectProjectFramework(project: NxProjectInfo): string | undefined {
  // Detect framework from executors (more accurate than target names)
  const executorsStr = project.executors.join(" ");
  const targetsStr = project.targets.join(" ");

  // Check executors first (most reliable)
  if (executorsStr.includes("@nx/next") || executorsStr.includes("@nrwl/next")) return "nextjs";
  if (executorsStr.includes("@nx/angular") || executorsStr.includes("@nrwl/angular")) return "angular";
  if (executorsStr.includes("@nx/react") || executorsStr.includes("@nrwl/react")) return "react";
  if (executorsStr.includes("@nx/vite") || executorsStr.includes("@nrwl/vite")) return "vite";
  if (executorsStr.includes("@nx/node") || executorsStr.includes("@nrwl/node")) return "node";
  if (executorsStr.includes("@nx/express") || executorsStr.includes("@nrwl/express")) return "express";
  if (executorsStr.includes("@nx/nest") || executorsStr.includes("@nrwl/nest")) return "nestjs";

  // Fallback to target names
  if (targetsStr.includes("next")) return "nextjs";
  if (targetsStr.includes("angular")) return "angular";
  if (targetsStr.includes("react")) return "react";
  if (targetsStr.includes("vite")) return "vite";
  if (targetsStr.includes("node")) return "node";

  return undefined;
}

/**
 * Summarize tag dimensions across all projects.
 * Returns counts like { scope: { shared: 5, admin: 3 }, type: { util: 10, feature: 8 } }
 */
function summarizeTagDimensions(
  projects: NxProjectInfo[]
): Record<string, Record<string, number>> {
  const summary: Record<string, Record<string, number>> = {};

  for (const project of projects) {
    for (const [dimension, value] of Object.entries(project.tagDimensions)) {
      if (!summary[dimension]) {
        summary[dimension] = {};
      }
      summary[dimension][value] = (summary[dimension][value] || 0) + 1;
    }
  }

  return summary;
}

/**
 * Collect all unique executors used across the workspace.
 */
function collectAllExecutors(projects: NxProjectInfo[]): string[] {
  const allExecutors = new Set<string>();

  for (const project of projects) {
    for (const executor of project.executors) {
      allExecutors.add(executor);
    }
  }

  return Array.from(allExecutors).sort();
}

async function tryLoadIndexStatistics(
  rootPath: string
): Promise<CodebaseMetadata["statistics"]> {
  const base: CodebaseMetadata["statistics"] = {
    totalFiles: 0,
    totalLines: 0,
    totalComponents: 0,
    componentsByType: {},
    componentsByLayer: {
      presentation: 0,
      business: 0,
      data: 0,
      state: 0,
      core: 0,
      shared: 0,
      feature: 0,
      infrastructure: 0,
      unknown: 0,
    },
  };

  try {
    const indexPath = path.join(rootPath, ".codebase-index.json");
    const stat = await fs.stat(indexPath);

    const maxBytes = getIndexStatsMaxBytes();
    if (maxBytes === 0 || stat.size > maxBytes) {
      return base;
    }

    const indexContent = await fs.readFile(indexPath, "utf-8");
    const chunks = (await parseJsonInWorker<
      Array<{
        filePath: string;
        startLine: number;
        endLine: number;
        componentType?: string;
        layer?: string;
      }>
    >(indexContent));

    if (Array.isArray(chunks) && chunks.length > 0) {
      base.totalFiles = new Set(chunks.map((c) => c.filePath)).size;
      base.totalLines = chunks.reduce(
        (sum: number, c) => sum + (c.endLine - c.startLine + 1),
        0
      );
      for (const chunk of chunks) {
        if (chunk.componentType) {
          base.componentsByType[chunk.componentType] =
            (base.componentsByType[chunk.componentType] || 0) + 1;
          base.totalComponents++;
        }
        const layer = chunk.layer as unknown;
        if (isArchitecturalLayer(layer, base.componentsByLayer)) {
          base.componentsByLayer[layer] = (base.componentsByLayer[layer] || 0) + 1;
        }
      }
    }
  } catch {
    // Index doesn't exist yet
  }

  return base;
}

function isArchitecturalLayer(
  layer: unknown,
  layers: CodebaseMetadata["statistics"]["componentsByLayer"]
): layer is keyof typeof layers {
  return typeof layer === "string" && layer in layers;
}

function detectStateLibraries(allDeps: Record<string, string>): string[] {
  const state: string[] = [];
  if (allDeps["@reduxjs/toolkit"] || allDeps["redux"]) state.push("redux");
  if (allDeps["@ngrx/store"]) state.push("ngrx");
  if (allDeps["zustand"]) state.push("zustand");
  if (allDeps["jotai"]) state.push("jotai");
  if (allDeps["recoil"]) state.push("recoil");
  if (allDeps["mobx"]) state.push("mobx");
  return state;
}

function detectUiLibraries(allDeps: Record<string, string>): string[] {
  const ui: string[] = [];
  if (allDeps["tailwindcss"]) ui.push("Tailwind");
  if (allDeps["@mui/material"]) ui.push("MUI");
  if (allDeps["@angular/material"]) ui.push("Angular Material");
  if (allDeps["primeng"]) ui.push("PrimeNG");
  if (allDeps["styled-components"]) ui.push("styled-components");
  if (
    allDeps["@radix-ui/react-slot"] ||
    Object.keys(allDeps).some((d) => d.startsWith("@radix-ui/react-"))
  ) {
    ui.push("Radix UI");
  }
  return ui;
}

function detectTestingLibraries(allDeps: Record<string, string>): string[] {
  const test: string[] = [];
  if (allDeps["vitest"]) test.push("Vitest");
  if (allDeps["jest"]) test.push("Jest");
  if (allDeps["@testing-library/react"]) test.push("Testing Library");
  if (allDeps["@testing-library/angular"]) test.push("Testing Library");
  if (allDeps["playwright"] || allDeps["@playwright/test"]) test.push("Playwright");
  if (allDeps["cypress"]) test.push("Cypress");
  if (allDeps["@nx/cypress"]) test.push("Cypress");
  if (allDeps["@nx/jest"]) test.push("Jest");
  return test;
}
