/**
 * Core Indexer - Orchestrates codebase indexing
 * Scans files, delegates to analyzers, creates embeddings, stores in vector DB
 */

import { promises as fs } from 'fs';
import path from 'path';
import { glob } from 'glob';
import ignore from 'ignore';
import {
  CodebaseMetadata,
  CodeChunk,
  IndexingProgress,
  IndexingStats,
  IndexingPhase,
  CodebaseConfig,
  FrameworkAnalyzer,
  Dependency
} from '../types/index.js';
import { analyzerRegistry } from './analyzer-registry.js';
import { isCodeFile, isBinaryFile } from '../utils/language-detection.js';
import { getEmbeddingProvider } from '../embeddings/index.js';
import { getStorageProvider, CodeChunkWithEmbedding } from '../storage/index.js';
import {
  LibraryUsageTracker,
  PatternDetector,
  ImportGraph,
  InternalFileGraph,
  FileExport
} from '../utils/usage-tracker.js';
import { getFileCommitDates } from '../utils/git-dates.js';
import {
  detectEcosystemFromPackageJsons,
  readRootPackageJson,
  scanWorkspacePackageJsons
} from '../analyzers/orchestration/package-json.js';

export interface IndexerOptions {
  rootPath: string;
  config?: Partial<CodebaseConfig>;
  onProgress?: (progress: IndexingProgress) => void;
}

export class CodebaseIndexer {
  private rootPath: string;
  private config: CodebaseConfig;
  private progress: IndexingProgress;
  private onProgressCallback?: (progress: IndexingProgress) => void;

  constructor(options: IndexerOptions) {
    this.rootPath = path.resolve(options.rootPath);
    this.config = this.mergeConfig(options.config);
    this.onProgressCallback = options.onProgress;

    this.progress = {
      phase: 'initializing',
      percentage: 0,
      filesProcessed: 0,
      totalFiles: 0,
      chunksCreated: 0,
      errors: [],
      startedAt: new Date()
    };
  }

  private mergeConfig(userConfig?: Partial<CodebaseConfig>): CodebaseConfig {
    const defaultConfig: CodebaseConfig = {
      analyzers: {
        angular: { enabled: true, priority: 100 },
        react: { enabled: false, priority: 90 },
        vue: { enabled: false, priority: 90 },
        generic: { enabled: true, priority: 10 }
      },
      include: ['**/*.{ts,tsx,js,jsx,html,css,scss,sass,less}'],
      exclude: ['node_modules/**', 'dist/**', 'build/**', '.git/**', 'coverage/**'],
      respectGitignore: true,
      parsing: {
        maxFileSize: 1048576, // 1MB
        chunkSize: 100,
        chunkOverlap: 10,
        parseTests: true,
        parseNodeModules: false
      },
      styleGuides: {
        autoDetect: true,
        paths: ['STYLE_GUIDE.md', 'docs/style-guide.md', 'ARCHITECTURE.md'],
        parseMarkdown: true
      },
      documentation: {
        autoDetect: true,
        includeReadmes: true,
        includeChangelogs: false
      },
      embedding: {
        provider: 'transformers',
        model: 'Xenova/bge-small-en-v1.5',
        batchSize: 100
      },
      skipEmbedding: false,
      storage: {
        provider: 'lancedb',
        path: './codebase-index'
      }
    };

    return {
      ...defaultConfig,
      ...userConfig,
      analyzers: { ...defaultConfig.analyzers, ...userConfig?.analyzers },
      parsing: { ...defaultConfig.parsing, ...userConfig?.parsing },
      styleGuides: { ...defaultConfig.styleGuides, ...userConfig?.styleGuides },
      documentation: {
        ...defaultConfig.documentation,
        ...userConfig?.documentation
      },
      embedding: { ...defaultConfig.embedding, ...userConfig?.embedding },
      storage: { ...defaultConfig.storage, ...userConfig?.storage }
    };
  }

  async index(): Promise<IndexingStats> {
    const startTime = Date.now();
    const stats: IndexingStats = {
      totalFiles: 0,
      indexedFiles: 0,
      skippedFiles: 0,
      totalChunks: 0,
      totalLines: 0,
      duration: 0,
      avgChunkSize: 0,
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
        unknown: 0
      },
      errors: [],
      startedAt: new Date()
    };

    try {
      // Phase 1: Scanning
      this.updateProgress('scanning', 0);
      let files = await this.scanFiles();

      // Memory safety: limit total files to prevent heap exhaustion
      const MAX_FILES = 10000;
      if (files.length > MAX_FILES) {
        console.warn(
          `WARNING: Found ${files.length} files, limiting to ${MAX_FILES} to prevent memory issues.`
        );
        console.warn(
          `Consider using more specific include patterns or excluding large directories.`
        );
        files = files.slice(0, MAX_FILES);
      }

      stats.totalFiles = files.length;
      this.progress.totalFiles = files.length;

      console.error(`Found ${files.length} files to index`);

      // Phase 2: Analyzing & Parsing
      this.updateProgress('analyzing', 0);
      const allChunks: CodeChunk[] = [];
      const libraryTracker = new LibraryUsageTracker();
      const patternDetector = new PatternDetector();
      const importGraph = new ImportGraph();
      const internalFileGraph = new InternalFileGraph(this.rootPath);

      // Fetch git commit dates for pattern momentum analysis
      const fileDates = await getFileCommitDates(this.rootPath);

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        this.progress.currentFile = file;
        this.progress.filesProcessed = i + 1;
        this.progress.percentage = Math.round(((i + 1) / files.length) * 100);

        try {
          // Normalize line endings to \n for consistent cross-platform output
          const rawContent = await fs.readFile(file, 'utf-8');
          const content = rawContent.replace(/\r\n/g, '\n');
          const result = await analyzerRegistry.analyzeFile(file, content);

          if (result) {
            allChunks.push(...result.chunks);
            stats.indexedFiles++;
            stats.totalLines += content.split('\n').length;

            // Track library usage AND import graph from imports
            for (const imp of result.imports) {
              libraryTracker.track(imp.source, file);
              importGraph.trackImport(imp.source, file, imp.line || 1);

              // Track internal file-to-file imports (relative paths)
              if (imp.source.startsWith('.')) {
                // Resolve the relative import to an absolute path
                const fileDir = path.dirname(file);
                let resolvedPath = path.resolve(fileDir, imp.source);

                // Try common extensions if not already specified
                const ext = path.extname(resolvedPath);
                if (!ext) {
                  for (const tryExt of ['.ts', '.tsx', '.js', '.jsx']) {
                    const withExt = resolvedPath + tryExt;
                    // We don't check if file exists for performance - just track what's referenced
                    resolvedPath = withExt;
                    break;
                  }
                }

                internalFileGraph.trackImport(file, resolvedPath, imp.imports);
              }
            }

            // Track exports for unused export detection
            if (result.exports && result.exports.length > 0) {
              const fileExports: FileExport[] = result.exports.map((exp) => ({
                name: exp.name,
                type: exp.isDefault ? 'default' : (exp.type as FileExport['type']) || 'other'
              }));
              internalFileGraph.trackExports(file, fileExports);
            }

            // Detect generic patterns from code
            patternDetector.detectFromCode(content, file);

            // Helper to extract code snippet around a pattern
            const extractSnippet = (
              pattern: RegExp,
              linesBefore = 1,
              linesAfter = 3
            ): string | undefined => {
              const match = content.match(pattern);
              if (!match) return undefined;
              const lines = content.split('\n');
              const matchIndex = content.substring(0, match.index).split('\n').length - 1;
              const start = Math.max(0, matchIndex - linesBefore);
              const end = Math.min(lines.length, matchIndex + linesAfter + 1);
              return lines.slice(start, end).join('\n').trim();
            };

            const relPath = file.split(/[\\/]/).slice(-3).join('/');

            // Get file date for pattern momentum tracking
            // Try multiple path formats since git uses forward slashes
            const normalizedRelPath = path.relative(this.rootPath, file).replace(/\\/g, '/');
            const fileDate = fileDates.get(normalizedRelPath);

            // GENERIC PATTERN FORWARDING
            // Framework analyzers return detectedPatterns in metadata - we just forward them
            // This keeps the indexer framework-agnostic
            if (result.metadata?.detectedPatterns) {
              for (const pattern of result.metadata.detectedPatterns) {
                // Try to extract a relevant snippet for the pattern
                const snippetPattern = this.getSnippetPatternFor(pattern.category, pattern.name);
                const snippet = snippetPattern ? extractSnippet(snippetPattern) : undefined;
                patternDetector.track(
                  pattern.category,
                  pattern.name,
                  snippet ? { file: relPath, snippet } : undefined,
                  fileDate
                );
              }
            }

            // Track file for Golden File scoring (framework-agnostic based on patterns)
            const detectedPatterns = result.metadata?.detectedPatterns || [];
            const hasPattern = (category: string, name: string) =>
              detectedPatterns.some(
                (p: { category: string; name: string }) =>
                  p.category === category && p.name === name
              );

            const patternScore =
              (hasPattern('dependencyInjection', 'inject() function') ? 1 : 0) +
              (hasPattern('stateManagement', 'Signals') ? 1 : 0) +
              (hasPattern('reactivity', 'Computed') ? 1 : 0) +
              (hasPattern('reactivity', 'Effect') ? 1 : 0) +
              (hasPattern('componentStyle', 'Standalone') ? 1 : 0) +
              (hasPattern('componentInputs', 'Signal-based inputs') ? 1 : 0);
            if (patternScore >= 3) {
              patternDetector.trackGoldenFile(relPath, patternScore, {
                inject: hasPattern('dependencyInjection', 'inject() function'),
                signals: hasPattern('stateManagement', 'Signals'),
                computed: hasPattern('reactivity', 'Computed'),
                effect: hasPattern('reactivity', 'Effect'),
                standalone: hasPattern('componentStyle', 'Standalone'),
                signalInputs: hasPattern('componentInputs', 'Signal-based inputs')
              });
            }

            // Update component statistics
            for (const component of result.components) {
              if (component.componentType) {
                stats.componentsByType[component.componentType] =
                  (stats.componentsByType[component.componentType] || 0) + 1;
              }
              if (component.layer) {
                stats.componentsByLayer[component.layer]++;
              }
            }
          } else {
            stats.skippedFiles++;
          }
        } catch (error) {
          stats.skippedFiles++;
          stats.errors.push({
            filePath: file,
            error: error instanceof Error ? error.message : String(error),
            phase: 'analyzing',
            timestamp: new Date()
          });
        }

        if (this.onProgressCallback) {
          this.onProgressCallback(this.progress);
        }
      }

      stats.totalChunks = allChunks.length;
      stats.avgChunkSize =
        allChunks.length > 0
          ? Math.round(allChunks.reduce((sum, c) => sum + c.content.length, 0) / allChunks.length)
          : 0;

      // Memory safety: limit chunks to prevent embedding memory issues
      const MAX_CHUNKS = 5000;
      let chunksToEmbed = allChunks;
      if (allChunks.length > MAX_CHUNKS) {
        console.warn(
          `WARNING: ${allChunks.length} chunks exceed limit. Indexing first ${MAX_CHUNKS} chunks.`
        );
        chunksToEmbed = allChunks.slice(0, MAX_CHUNKS);
      }

      // Phase 3: Embedding
      const chunksWithEmbeddings: CodeChunkWithEmbedding[] = [];

      if (!this.config.skipEmbedding) {
        this.updateProgress('embedding', 50);
        console.error(`Creating embeddings for ${chunksToEmbed.length} chunks...`);

        // Initialize embedding provider
        const embeddingProvider = await getEmbeddingProvider(this.config.embedding);

        // Generate embeddings for all chunks
        const batchSize = this.config.embedding?.batchSize || 32;

        for (let i = 0; i < chunksToEmbed.length; i += batchSize) {
          const batch = chunksToEmbed.slice(i, i + batchSize);
          const texts = batch.map((chunk) => {
            // Create a searchable text representation
            const parts = [chunk.content];
            if (chunk.metadata?.componentName) {
              parts.unshift(`Component: ${chunk.metadata.componentName}`);
            }
            if (chunk.componentType) {
              parts.unshift(`Type: ${chunk.componentType}`);
            }
            return parts.join('\n');
          });

          const embeddings = await embeddingProvider.embedBatch(texts);

          for (let j = 0; j < batch.length; j++) {
            chunksWithEmbeddings.push({
              ...batch[j],
              embedding: embeddings[j]
            });
          }

          // Update progress
          const embeddingProgress = 50 + Math.round((i / chunksToEmbed.length) * 25);
          this.updateProgress('embedding', embeddingProgress);

          if ((i + batchSize) % 100 === 0 || i + batchSize >= chunksToEmbed.length) {
            console.error(
              `Embedded ${Math.min(i + batchSize, chunksToEmbed.length)}/${
                chunksToEmbed.length
              } chunks`
            );
          }
        }
      } else {
        console.error('Skipping embedding generation (skipEmbedding=true)');
      }

      // Phase 4: Storing
      this.updateProgress('storing', 75);

      if (!this.config.skipEmbedding) {
        console.error(`Storing ${chunksToEmbed.length} chunks...`);

        // Store in LanceDB for vector search
        const storagePath = path.join(this.rootPath, '.codebase-index');
        const storageProvider = await getStorageProvider({ path: storagePath });
        await storageProvider.clear(); // Clear existing index
        await storageProvider.store(chunksWithEmbeddings);
      }

      // Also save JSON for keyword search (Fuse.js) - use chunksToEmbed for consistency
      const indexPath = path.join(this.rootPath, '.codebase-index.json');
      // Write without pretty-printing to save memory
      await fs.writeFile(indexPath, JSON.stringify(chunksToEmbed));

      // Save library usage and pattern stats
      const intelligencePath = path.join(this.rootPath, '.codebase-intelligence.json');
      const libraryStats = libraryTracker.getStats();

      // Extract tsconfig paths for AI to understand import aliases
      let tsconfigPaths: Record<string, string[]> | undefined;
      try {
        const tsconfigPath = path.join(this.rootPath, 'tsconfig.json');
        const tsconfigContent = await fs.readFile(tsconfigPath, 'utf-8');
        const tsconfig = JSON.parse(tsconfigContent);
        if (tsconfig.compilerOptions?.paths) {
          tsconfigPaths = tsconfig.compilerOptions.paths;
          console.error(
            `Found ${Object.keys(tsconfigPaths!).length} path aliases in tsconfig.json`
          );
        }
      } catch (_error) {
        // No tsconfig.json or no paths defined
      }

      const intelligence = {
        libraryUsage: libraryStats,
        patterns: patternDetector.getAllPatterns(),
        goldenFiles: patternDetector.getGoldenFiles(5),
        // tsconfig paths help AI understand import aliases (e.g., @mycompany/* -> libs/*)
        // This reveals which @scoped packages are internal vs external
        tsconfigPaths,
        importGraph: {
          usages: importGraph.getAllUsages(),
          topUsed: importGraph.getTopUsed(30)
        },
        // Internal file graph for circular dependency and unused export detection
        internalFileGraph: internalFileGraph.toJSON(),
        generatedAt: new Date().toISOString()
      };
      await fs.writeFile(intelligencePath, JSON.stringify(intelligence, null, 2));

      // Phase 5: Complete
      this.updateProgress('complete', 100);

      stats.duration = Date.now() - startTime;
      stats.completedAt = new Date();

      console.error(`Indexing complete in ${stats.duration}ms`);
      console.error(`Indexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks`);

      return stats;
    } catch (error) {
      this.progress.phase = 'error';
      stats.errors.push({
        filePath: this.rootPath,
        error: error instanceof Error ? error.message : String(error),
        phase: this.progress.phase,
        timestamp: new Date()
      });
      throw error;
    }
  }

  private async scanFiles(): Promise<string[]> {
    const files: string[] = [];

    // Read .gitignore if respecting it
    let ig: ReturnType<typeof ignore.default> | null = null;
    if (this.config.respectGitignore) {
      try {
        const gitignorePath = path.join(this.rootPath, '.gitignore');
        const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
        ig = ignore.default().add(gitignoreContent);
      } catch (_error) {
        // No .gitignore or couldn't read it
      }
    }

    // Scan with glob
    const includePatterns = this.config.include || ['**/*'];
    const excludePatterns = this.config.exclude || [];

    for (const pattern of includePatterns) {
      const matches = await glob(pattern, {
        cwd: this.rootPath,
        absolute: true,
        ignore: excludePatterns,
        nodir: true
      });

      for (const file of matches) {
        const relativePath = path.relative(this.rootPath, file);

        // Check gitignore
        if (ig && ig.ignores(relativePath)) {
          continue;
        }

        // Check if it's a code file
        if (!isCodeFile(file) || isBinaryFile(file)) {
          continue;
        }

        // Check file size
        try {
          const stats = await fs.stat(file);
          if (stats.size > (this.config.parsing?.maxFileSize || 1048576)) {
            console.warn(`Skipping large file: ${file} (${stats.size} bytes)`);
            continue;
          }
        } catch (_error) {
          continue;
        }

        files.push(file);
      }
    }

    return files;
  }

  private updateProgress(phase: IndexingPhase, percentage: number): void {
    this.progress.phase = phase;
    this.progress.percentage = percentage;

    if (this.onProgressCallback) {
      this.onProgressCallback(this.progress);
    }
  }

  async detectMetadata(): Promise<CodebaseMetadata> {
    const defaultName = path.basename(this.rootPath);
    let metadata = this.buildFallbackMetadata(defaultName);
    const frameworkCandidates: Array<{
      analyzerName: string;
      priority: number;
      metadata: CodebaseMetadata;
      score: number;
    }> = [];

    const analyzers = await this.selectMetadataAnalyzers(analyzerRegistry.getAll());
    for (const analyzer of analyzers) {
      try {
        const analyzerMetadata = await analyzer.detectCodebaseMetadata(this.rootPath);
        metadata = this.mergeMetadata(metadata, analyzerMetadata, analyzer.name, defaultName);

        if (analyzerMetadata.framework) {
          frameworkCandidates.push({
            analyzerName: analyzer.name,
            priority: analyzer.priority,
            metadata: analyzerMetadata,
            score: this.scoreFrameworkCandidate(analyzerMetadata)
          });
        }
      } catch (error) {
        console.warn(`Failed to detect metadata with ${analyzer.name}:`, error);
      }
    }

    if (frameworkCandidates.length > 0) {
      frameworkCandidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.priority - a.priority;
      });
      metadata.framework = frameworkCandidates[0].metadata.framework;
    }

    // Load intelligence data if available
    try {
      const intelligencePath = path.join(this.rootPath, '.codebase-intelligence.json');
      const intelligenceContent = await fs.readFile(intelligencePath, 'utf-8');
      const intelligence = JSON.parse(intelligenceContent);

      metadata.customMetadata = {
        ...metadata.customMetadata,
        libraryUsage: intelligence.libraryUsage,
        patterns: intelligence.patterns,
        intelligenceGeneratedAt: intelligence.generatedAt
      };
    } catch (_error) {
      // Intelligence file doesn't exist yet (indexing not run)
    }

    return metadata;
  }

  private async selectMetadataAnalyzers(
    analyzers: FrameworkAnalyzer[]
  ): Promise<FrameworkAnalyzer[]> {
    try {
      const packageJsons = await scanWorkspacePackageJsons(this.rootPath);
      const rootPackage = await readRootPackageJson(this.rootPath);
      if (rootPackage && !packageJsons.some((p) => p.filePath === rootPackage.filePath)) {
        packageJsons.unshift(rootPackage);
      }
      const ecosystem = detectEcosystemFromPackageJsons(packageJsons);
      const enabled = new Set<string>(ecosystem.frameworks);

      const selected = analyzers.filter(
        (analyzer) => analyzer.name === "generic" || enabled.has(analyzer.name)
      );

      return selected.length > 0 ? selected : analyzers;
    } catch {
      return analyzers;
    }
  }

  private buildFallbackMetadata(defaultName: string): CodebaseMetadata {
    return {
      name: defaultName,
      rootPath: this.rootPath,
      languages: [],
      dependencies: [],
      architecture: {
        type: "mixed",
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
        patterns: [],
      },
      styleGuides: [],
      documentation: [],
      projectStructure: {
        type: "single-app",
      },
      statistics: {
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
      },
      customMetadata: {},
    };
  }

  private mergeMetadata(
    base: CodebaseMetadata,
    incoming: CodebaseMetadata,
    analyzerName: string,
    defaultName: string
  ): CodebaseMetadata {
    const name = base.name !== defaultName ? base.name : (incoming.name || base.name);
    const languages = this.mergeLanguages(base.languages, incoming.languages);
    const dependencies = this.mergeDependencies(base.dependencies, incoming.dependencies);
    const architecture = this.mergeArchitecture(base.architecture, incoming.architecture);
    const styleGuides = this.mergeByFilePath(base.styleGuides, incoming.styleGuides);
    const documentation = this.mergeByFilePath(base.documentation, incoming.documentation);
    const projectStructure = this.mergeProjectStructure(base.projectStructure, incoming.projectStructure);
    const statistics = this.mergeStatistics(base.statistics, incoming.statistics);
    const customMetadata = this.mergeCustomMetadata(base.customMetadata, incoming.customMetadata, analyzerName);

    return {
      ...base,
      name,
      rootPath: incoming.rootPath || base.rootPath,
      languages,
      dependencies,
      architecture,
      styleGuides,
      documentation,
      projectStructure,
      statistics,
      customMetadata,
    };
  }

  private mergeLanguages(base: CodebaseMetadata["languages"], incoming: CodebaseMetadata["languages"]): CodebaseMetadata["languages"] {
    const byName = new Map<string, CodebaseMetadata["languages"][number]>();
    for (const entry of base) {
      byName.set(entry.name, entry);
    }
    for (const entry of incoming) {
      const existing = byName.get(entry.name);
      if (!existing) {
        byName.set(entry.name, entry);
        continue;
      }
      byName.set(entry.name, {
        ...existing,
        version: existing.version || entry.version,
        fileCount: Math.max(existing.fileCount, entry.fileCount),
        lineCount: Math.max(existing.lineCount, entry.lineCount),
        percentage: Math.max(existing.percentage, entry.percentage),
      });
    }
    return Array.from(byName.values());
  }

  private mergeDependencies(
    base: Dependency[],
    incoming: Dependency[]
  ): Dependency[] {
    const byName = new Map<string, Dependency>();
    const rank: Record<Dependency["category"], number> = {
      framework: 7,
      state: 6,
      ui: 5,
      routing: 4,
      http: 3,
      testing: 2,
      utility: 1,
      build: 1,
      other: 0,
    };

    for (const dep of base) {
      byName.set(dep.name, dep);
    }
    for (const dep of incoming) {
      const existing = byName.get(dep.name);
      if (!existing) {
        byName.set(dep.name, dep);
        continue;
      }
      const nextCategory =
        rank[dep.category] > rank[existing.category] ? dep.category : existing.category;
      byName.set(dep.name, {
        ...existing,
        version: existing.version || dep.version,
        category: nextCategory,
      });
    }

    return Array.from(byName.values());
  }

  private mergeArchitecture(
    base: CodebaseMetadata["architecture"],
    incoming: CodebaseMetadata["architecture"]
  ): CodebaseMetadata["architecture"] {
    const layers = { ...base.layers };
    for (const [layer, count] of Object.entries(incoming.layers)) {
      const key = layer as keyof typeof layers;
      layers[key] = Math.max(layers[key], count ?? 0);
    }
    const patterns = Array.from(new Set([...(base.patterns || []), ...(incoming.patterns || [])]));
    const type =
      base.type !== "mixed" ? base.type : incoming.type !== "mixed" ? incoming.type : base.type;

    return {
      ...base,
      type,
      layers,
      patterns,
    };
  }

  private mergeProjectStructure(
    base: CodebaseMetadata["projectStructure"],
    incoming: CodebaseMetadata["projectStructure"]
  ): CodebaseMetadata["projectStructure"] {
    if (base.type !== "single-app") {
      return base;
    }
    if (incoming.type !== "single-app") {
      return incoming;
    }
    return base;
  }

  private mergeStatistics(
    base: CodebaseMetadata["statistics"],
    incoming: CodebaseMetadata["statistics"]
  ): CodebaseMetadata["statistics"] {
    const componentsByType = { ...base.componentsByType };
    for (const [key, value] of Object.entries(incoming.componentsByType)) {
      componentsByType[key] = Math.max(componentsByType[key] || 0, value);
    }

    const componentsByLayer = { ...base.componentsByLayer };
    for (const [key, value] of Object.entries(incoming.componentsByLayer)) {
      const layer = key as keyof typeof componentsByLayer;
      componentsByLayer[layer] = Math.max(componentsByLayer[layer] || 0, value);
    }

    const totalComponents = Math.max(
      base.totalComponents,
      incoming.totalComponents,
      Object.values(componentsByType).reduce((sum, value) => sum + value, 0)
    );

    return {
      ...base,
      totalFiles: Math.max(base.totalFiles, incoming.totalFiles),
      totalLines: Math.max(base.totalLines, incoming.totalLines),
      totalComponents,
      componentsByType,
      componentsByLayer,
    };
  }

  private mergeByFilePath<T extends { filePath: string }>(base: T[], incoming: T[]): T[] {
    const byPath = new Map<string, T>();
    for (const entry of base) {
      byPath.set(entry.filePath, entry);
    }
    for (const entry of incoming) {
      if (!byPath.has(entry.filePath)) {
        byPath.set(entry.filePath, entry);
      }
    }
    return Array.from(byPath.values());
  }

  private mergeCustomMetadata(
    base: Record<string, any>,
    incoming: Record<string, any>,
    analyzerName: string
  ): Record<string, any> {
    const baseAnalyzers =
      base && typeof base.analyzers === "object" && base.analyzers
        ? (base.analyzers as Record<string, any>)
        : {};
    const incomingAnalyzers =
      incoming && typeof incoming.analyzers === "object" && incoming.analyzers
        ? (incoming.analyzers as Record<string, any>)
        : {};

    return {
      ...base,
      ...incoming,
      analyzers: {
        ...baseAnalyzers,
        ...incomingAnalyzers,
        [analyzerName]: incoming,
      },
    };
  }

  private scoreFrameworkCandidate(metadata: CodebaseMetadata): number {
    const framework = metadata.framework;
    if (!framework) return 0;
    const deps = new Set(metadata.dependencies.map((dep) => dep.name));
    const expectedDeps: Record<string, string[]> = {
      angular: ["@angular/core"],
      nextjs: ["next"],
      react: ["react", "react-dom"],
      vue: ["vue"],
      svelte: ["svelte"],
      solid: ["solid-js"],
      other: [],
    };
    const candidates = expectedDeps[framework.type] || [];
    const hasFrameworkDep = candidates.some((dep) => deps.has(dep));

    let score = 0;
    if (framework.version && framework.version !== "unknown") score += 2;
    if (hasFrameworkDep) score += 2;
    if (framework.variant && framework.variant !== "unknown") score += 1;
    return score;
  }


  /**
   * Get regex pattern for extracting code snippets based on pattern category and name
   * This maps abstract pattern names to actual code patterns
   */
  private getSnippetPatternFor(category: string, name: string): RegExp | null {
    const patterns: Record<string, Record<string, RegExp>> = {
      dependencyInjection: {
        'inject() function': /\binject\s*[<(]/,
        'Constructor injection': /constructor\s*\(/
      },
      stateManagement: {
        'RxJS': /BehaviorSubject|ReplaySubject|Subject|Observable/,
        'Signals': /\bsignal\s*[<(]/,
        'React Context': /\bcreateContext\s*\(|\buseContext\s*\(/,
        'redux-toolkit': /@reduxjs\/toolkit|configureStore|createSlice/
      },
      reactivity: {
        'Effect': /\beffect\s*\(/,
        'Computed': /\bcomputed\s*[<(]/,
        'Suspense': /<Suspense\b|React\.Suspense/,
        'Memoization': /\buseMemo\s*\(|\buseCallback\s*\(|\bmemo\s*\(/
      },
      componentStyle: {
        'Standalone': /standalone\s*:\s*true/,
        'NgModule-based': /@(?:Component|Directive|Pipe)\s*\(/,
        '"use client"': /^\s*['"]use client['"]\s*;?/,
        'memo()': /\bmemo\s*\(/
      },
      componentInputs: {
        'Signal-based inputs': /\binput\s*[<(]/,
        'Decorator-based @Input': /@Input\(\)/
      },
      routing: {
        'Next.js App Router': /\/app\//,
        'Next.js Pages Router': /\/pages\//,
        'Route Handler': /\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/,
        'API Route': /\/pages\/api\//
      },
      metadata: {
        'Next.js metadata': /\bexport\s+(?:const|function)\s+(metadata|generateMetadata)\b/
      },
      forms: {
        'react-hook-form': /\buseForm\s*\(|from\s+['"]react-hook-form['"]/ 
      },
      validation: {
        'zod': /\bz\.\w+|from\s+['"]zod['"]/ 
      },
      data: {
        'tanstack-query': /from\s+['"]@tanstack\/react-query['"]/ 
      },
      styling: {
        'tailwind': /tailwindcss|className\s*=\s*['"][^'"]*(?:bg-|text-|p-|m-)/
      },
      reactHooks: {
        'Built-in hooks': /\buse(?:State|Effect|Memo|Callback|Reducer|Ref|Context)\s*\(/,
        'Custom hooks': /\bfunction\s+use[A-Z0-9]\w*\s*\(|\bconst\s+use[A-Z0-9]\w*\s*=/
      }
    };
    return patterns[category]?.[name] || null;
  }

  getProgress(): IndexingProgress {
    return { ...this.progress };
  }
}
