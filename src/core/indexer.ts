/**
 * Core Indexer - Orchestrates codebase indexing
 * Scans files, delegates to analyzers, creates embeddings, stores in vector DB
 */

import { randomUUID } from 'crypto';
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
  Dependency,
  IntelligenceData
} from '../types/index.js';
import { analyzerRegistry } from './analyzer-registry.js';
import { isCodeFile, isBinaryFile } from '../utils/language-detection.js';
import { getEmbeddingProvider, DEFAULT_MODEL } from '../embeddings/index.js';
import { getStorageProvider, CodeChunkWithEmbedding } from '../storage/index.js';
import {
  LibraryUsageTracker,
  PatternDetector,
  ImportGraph,
  InternalFileGraph,
  FileExport
} from '../utils/usage-tracker.js';
import { mergeSmallChunks } from '../utils/chunking.js';
import { getFileCommitDates } from '../utils/git-dates.js';
import {
  CODEBASE_CONTEXT_DIRNAME,
  INDEX_FORMAT_VERSION,
  INDEXING_STATS_FILENAME,
  INDEX_META_FILENAME,
  INDEX_META_VERSION,
  INTELLIGENCE_FILENAME,
  KEYWORD_INDEX_FILENAME,
  MANIFEST_FILENAME,
  RELATIONSHIPS_FILENAME,
  VECTOR_DB_DIRNAME
} from '../constants/codebase-context.js';
import {
  detectEcosystemFromPackageJsons,
  readRootPackageJson,
  scanWorkspacePackageJsons
} from '../analyzers/orchestration/package-json.js';

const STAGING_DIRNAME = '.staging';
const PREVIOUS_DIRNAME = '.previous';

import {
  computeFileHashes,
  readManifest,
  writeManifest,
  diffManifest,
  type FileManifest,
  type ManifestDiff
} from './manifest.js';

let cachedToolVersion: string | null = null;

async function getToolVersion(): Promise<string> {
  if (cachedToolVersion) return cachedToolVersion;

  try {
    const pkgRaw = await fs.readFile(new URL('../../package.json', import.meta.url), 'utf-8');
    const pkg = JSON.parse(pkgRaw) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.trim()) {
      cachedToolVersion = pkg.version;
      return cachedToolVersion;
    }
  } catch {
    // Best-effort — fall back below
  }

  cachedToolVersion = 'unknown';
  return cachedToolVersion;
}

/**
 * Perform a Windows-safe atomic swap of staging artifacts into active location.
 * Strategy: move current active to .previous, then rename staging to active.
 * If staging rename fails, restore from .previous.
 */
async function atomicSwapStagingToActive(
  contextDir: string,
  stagingDir: string,
  buildId: string
): Promise<void> {
  const previousDir = path.join(contextDir, PREVIOUS_DIRNAME);
  const activeMetaPath = path.join(contextDir, INDEX_META_FILENAME);
  const activeIndexPath = path.join(contextDir, KEYWORD_INDEX_FILENAME);
  const activeIntelligencePath = path.join(contextDir, INTELLIGENCE_FILENAME);
  const activeVectorDir = path.join(contextDir, VECTOR_DB_DIRNAME);
  const activeManifestPath = path.join(contextDir, MANIFEST_FILENAME);
  const activeStatsPath = path.join(contextDir, INDEXING_STATS_FILENAME);
  const activeRelationshipsPath = path.join(contextDir, RELATIONSHIPS_FILENAME);

  const stagingMetaPath = path.join(stagingDir, INDEX_META_FILENAME);
  const stagingIndexPath = path.join(stagingDir, KEYWORD_INDEX_FILENAME);
  const stagingIntelligencePath = path.join(stagingDir, INTELLIGENCE_FILENAME);
  const stagingVectorDir = path.join(stagingDir, VECTOR_DB_DIRNAME);
  const stagingManifestPath = path.join(stagingDir, MANIFEST_FILENAME);
  const stagingStatsPath = path.join(stagingDir, INDEXING_STATS_FILENAME);
  const stagingRelationshipsPath = path.join(stagingDir, RELATIONSHIPS_FILENAME);

  // Step 1: Create .previous directory and move current active there
  await fs.mkdir(previousDir, { recursive: true });

  const moveIfExists = async (src: string, dest: string): Promise<void> => {
    try {
      await fs.rename(src, dest);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // File doesn't exist is OK, other errors are problems
        throw error;
      }
    }
  };

  const moveDirIfExists = async (src: string, dest: string): Promise<void> => {
    try {
      const stat = await fs.stat(src);
      if (stat.isDirectory()) {
        await fs.rename(src, dest);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  };

  // Move active artifacts to .previous
  await moveIfExists(activeMetaPath, path.join(previousDir, INDEX_META_FILENAME));
  await moveIfExists(activeIndexPath, path.join(previousDir, KEYWORD_INDEX_FILENAME));
  await moveIfExists(activeIntelligencePath, path.join(previousDir, INTELLIGENCE_FILENAME));
  await moveIfExists(activeManifestPath, path.join(previousDir, MANIFEST_FILENAME));
  await moveIfExists(activeStatsPath, path.join(previousDir, INDEXING_STATS_FILENAME));
  await moveIfExists(activeRelationshipsPath, path.join(previousDir, RELATIONSHIPS_FILENAME));
  await moveDirIfExists(activeVectorDir, path.join(previousDir, VECTOR_DB_DIRNAME));

  // Step 2: Move staging artifacts to active location
  try {
    await moveIfExists(stagingMetaPath, activeMetaPath);
    await moveIfExists(stagingIndexPath, activeIndexPath);
    await moveIfExists(stagingIntelligencePath, activeIntelligencePath);
    await moveIfExists(stagingManifestPath, activeManifestPath);
    await moveIfExists(stagingStatsPath, activeStatsPath);
    await moveIfExists(stagingRelationshipsPath, activeRelationshipsPath);
    await moveDirIfExists(stagingVectorDir, activeVectorDir);

    // Step 3: Clean up .previous and staging directories
    await cleanupDirectory(previousDir);
    await cleanupDirectory(stagingDir);

    // Also clean up the parent .staging/ directory if empty
    const stagingBase = path.join(contextDir, STAGING_DIRNAME);
    try {
      const remaining = await fs.readdir(stagingBase);
      if (remaining.length === 0) {
        await fs.rmdir(stagingBase);
      }
    } catch {
      // Directory doesn't exist or not empty - ignore
    }

    console.error(`Atomic swap complete: build ${buildId} now active`);
  } catch (swapError) {
    console.error('Atomic swap failed, attempting rollback:', swapError);

    // Attempt rollback: restore from .previous
    try {
      await moveIfExists(path.join(previousDir, INDEX_META_FILENAME), activeMetaPath);
      await moveIfExists(path.join(previousDir, KEYWORD_INDEX_FILENAME), activeIndexPath);
      await moveIfExists(path.join(previousDir, INTELLIGENCE_FILENAME), activeIntelligencePath);
      await moveIfExists(path.join(previousDir, MANIFEST_FILENAME), activeManifestPath);
      await moveIfExists(path.join(previousDir, INDEXING_STATS_FILENAME), activeStatsPath);
      await moveIfExists(path.join(previousDir, RELATIONSHIPS_FILENAME), activeRelationshipsPath);
      await moveDirIfExists(path.join(previousDir, VECTOR_DB_DIRNAME), activeVectorDir);
      console.error('Rollback successful');
    } catch (rollbackError) {
      console.error('Rollback also failed:', rollbackError);
    }

    throw swapError;
  }
}

/**
 * Best-effort cleanup of a directory and its contents.
 */
async function cleanupDirectory(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Best-effort: ignore cleanup failures
  }
}

export interface IndexerOptions {
  rootPath: string;
  config?: Partial<CodebaseConfig>;
  onProgress?: (progress: IndexingProgress) => void;
  incrementalOnly?: boolean;
}

interface PersistedIndexingStats {
  indexedFiles: number;
  totalChunks: number;
  totalFiles: number;
  generatedAt: string;
}

export class CodebaseIndexer {
  private rootPath: string;
  private config: CodebaseConfig;
  private progress: IndexingProgress;
  private onProgressCallback?: (progress: IndexingProgress) => void;
  private incrementalOnly: boolean;

  constructor(options: IndexerOptions) {
    this.rootPath = path.resolve(options.rootPath);
    this.config = this.mergeConfig(options.config);
    this.onProgressCallback = options.onProgress;
    this.incrementalOnly = options.incrementalOnly ?? false;

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
        maxFileSize: 1048576,
        chunkSize: 50,
        chunkOverlap: 0,
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
        model: DEFAULT_MODEL,
        batchSize: 32
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

    let stagingDir: string | null = null;

    try {
      // Ensure there is at least a generic fallback analyzer registered when the indexer
      // is used directly (e.g. in tests or standalone scripts).
      if (analyzerRegistry.getAll().length === 0) {
        const { GenericAnalyzer } = await import('../analyzers/generic/index.js');
        analyzerRegistry.register(new GenericAnalyzer());
      }

      const buildId = randomUUID();
      const generatedAt = new Date().toISOString();
      const toolVersion = await getToolVersion();

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

      // Phase 1b: Incremental diff (if incremental mode)
      const contextDir = path.join(this.rootPath, CODEBASE_CONTEXT_DIRNAME);
      const manifestPath = path.join(contextDir, MANIFEST_FILENAME);
      const indexingStatsPath = path.join(contextDir, INDEXING_STATS_FILENAME);
      let diff: ManifestDiff | null = null;
      let currentHashes: Record<string, string> | null = null;
      let previousManifest: FileManifest | null = null;

      if (this.incrementalOnly) {
        this.updateProgress('scanning', 10);
        console.error('Computing file hashes for incremental diff...');
        currentHashes = await computeFileHashes(files, this.rootPath);

        previousManifest = await readManifest(manifestPath);
        diff = diffManifest(previousManifest, currentHashes);

        console.error(
          `Incremental diff: ${diff.added.length} added, ${diff.changed.length} changed, ` +
            `${diff.deleted.length} deleted, ${diff.unchanged.length} unchanged`
        );

        stats.incremental = {
          added: diff.added.length,
          changed: diff.changed.length,
          deleted: diff.deleted.length,
          unchanged: diff.unchanged.length
        };

        // Short-circuit: nothing changed
        if (diff.added.length === 0 && diff.changed.length === 0 && diff.deleted.length === 0) {
          console.error('No files changed - skipping re-index.');
          this.updateProgress('complete', 100);
          stats.duration = Date.now() - startTime;
          stats.completedAt = new Date();

          let restoredFromPersistedStats = false;

          try {
            const persisted = JSON.parse(
              await fs.readFile(indexingStatsPath, 'utf-8')
            ) as Partial<PersistedIndexingStats>;

            if (
              typeof persisted.indexedFiles === 'number' &&
              typeof persisted.totalChunks === 'number' &&
              typeof persisted.totalFiles === 'number'
            ) {
              stats.indexedFiles = persisted.indexedFiles;
              stats.totalChunks = persisted.totalChunks;
              stats.totalFiles = persisted.totalFiles;
              restoredFromPersistedStats = true;
            }
          } catch {
            // No persisted stats yet — fall back below
          }

          if (!restoredFromPersistedStats) {
            if (previousManifest) {
              stats.indexedFiles = Object.keys(previousManifest.files).length;
            }

            try {
              const existingIndexPath = path.join(contextDir, KEYWORD_INDEX_FILENAME);
              const existing = JSON.parse(await fs.readFile(existingIndexPath, 'utf-8')) as unknown;
              const existingObj = existing as { chunks?: unknown };
              const existingChunks: unknown = Array.isArray(existing)
                ? existing
                : existingObj && Array.isArray(existingObj.chunks)
                  ? existingObj.chunks
                  : null;
              if (Array.isArray(existingChunks)) {
                stats.totalChunks = existingChunks.length;
                if (stats.indexedFiles === 0) {
                  const uniqueFiles = new Set(
                    existingChunks.map((c: { filePath?: string }) => c.filePath)
                  );
                  stats.indexedFiles = uniqueFiles.size;
                }
              }
            } catch {
              // Keyword index doesn't exist yet — keep best-known counts
            }
          }

          stats.totalFiles = files.length;

          return stats;
        }
      }

      // Build the set of files that need analysis + embedding (incremental: only added/changed)
      const filesToProcess = diff
        ? files.filter((f) => {
            const rel = path.relative(this.rootPath, f).replace(/\\/g, '/');
            return diff!.added.includes(rel) || diff!.changed.includes(rel);
          })
        : files;

      // Phase 2: Analyzing & Parsing
      // Intelligence tracking (patterns, libraries, import graph) runs on ALL files
      // but embedding only runs on filesToProcess
      this.updateProgress('analyzing', 0);
      const allChunks: CodeChunk[] = [];
      const changedChunks: CodeChunk[] = []; // Only chunks from added/changed files
      const libraryTracker = new LibraryUsageTracker();
      const patternDetector = new PatternDetector();
      const importGraph = new ImportGraph();
      const internalFileGraph = new InternalFileGraph(this.rootPath);

      // Fetch git commit dates for pattern momentum analysis
      const fileDates = await getFileCommitDates(this.rootPath);

      // When incremental, track which files need embedding
      const filesToProcessSet = diff ? new Set(filesToProcess.map((f) => f)) : null;

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
            const isFileChanged = !filesToProcessSet || filesToProcessSet.has(file);

            const mergedChunks = mergeSmallChunks(result.chunks, 15);

            allChunks.push(...mergedChunks);
            if (isFileChanged) {
              changedChunks.push(...mergedChunks);
            }
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

                internalFileGraph.trackImport(file, resolvedPath, imp.line || 1, imp.imports);
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
            if (
              result.metadata?.detectedPatterns &&
              Array.isArray(result.metadata.detectedPatterns)
            ) {
              for (const pattern of result.metadata.detectedPatterns as Array<{
                category: string;
                name: string;
              }>) {
                // Try to extract a relevant snippet for the pattern
                // Ask analyzer registry for snippet pattern (framework-agnostic delegation)
                const analyzer = analyzerRegistry.findAnalyzer(file);
                const snippetPattern =
                  analyzer?.getSnippetPattern?.(pattern.category, pattern.name) ?? null;
                const snippet = snippetPattern ? extractSnippet(snippetPattern) : undefined;
                patternDetector.track(
                  pattern.category,
                  pattern.name,
                  snippet ? { file: relPath, snippet } : undefined,
                  fileDate
                );
              }
            }

            // Track file for Golden File scoring (framework-agnostic)
            // A golden file = file with patterns in ≥3 distinct categories
            const rawPatterns = result.metadata?.detectedPatterns;
            const detectedPatterns: Array<{ category: string; name: string }> = Array.isArray(
              rawPatterns
            )
              ? (rawPatterns as Array<{ category: string; name: string }>)
              : [];
            const uniqueCategories = new Set(detectedPatterns.map((p) => p.category));
            const patternScore = uniqueCategories.size;
            if (patternScore >= 3) {
              const patternFlags: Record<string, boolean> = {};
              for (const p of detectedPatterns) {
                patternFlags[`${p.category}:${p.name}`] = true;
              }
              patternDetector.trackGoldenFile(relPath, patternScore, patternFlags);
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

      // Determine which chunks to embed: in incremental mode, only changed/added file chunks
      const chunksForEmbedding = diff ? changedChunks : allChunks;

      // Memory safety: limit chunks to prevent embedding memory issues
      const MAX_CHUNKS = 5000;
      let chunksToEmbed = chunksForEmbedding;
      if (chunksForEmbedding.length > MAX_CHUNKS) {
        console.warn(
          `WARNING: ${chunksForEmbedding.length} chunks exceed limit. Indexing first ${MAX_CHUNKS} chunks.`
        );
        chunksToEmbed = chunksForEmbedding.slice(0, MAX_CHUNKS);
      }

      // Phase 3: Embedding (only changed/added chunks in incremental mode)
      const chunksWithEmbeddings: CodeChunkWithEmbedding[] = [];

      if (!this.config.skipEmbedding && chunksToEmbed.length > 0) {
        this.updateProgress('embedding', 50);
        console.error(
          `Creating embeddings for ${chunksToEmbed.length} chunks` +
            (diff ? ` (${allChunks.length} total, ${chunksToEmbed.length} changed)` : '') +
            '...'
        );

        // Initialize embedding provider
        const embeddingProvider = await getEmbeddingProvider(this.config.embedding);

        // Generate embeddings for all chunks
        // Outer batch size controls how many chunks we collect before calling embedBatch.
        // embedBatch internally sub-batches further based on model context size.
        const batchSize = Math.min(this.config.embedding?.batchSize || 32, 32);

        for (let i = 0; i < chunksToEmbed.length; i += batchSize) {
          const batch = chunksToEmbed.slice(i, i + batchSize);
          const texts = batch.map((chunk) => {
            const meta: string[] = [];
            if (chunk.relativePath) {
              meta.push(`path:${chunk.relativePath}`);
            }
            if (chunk.componentType && chunk.componentType !== 'unknown') {
              meta.push(`type:${chunk.componentType}`);
            }
            if (chunk.metadata?.componentName) {
              meta.push(`component:${chunk.metadata.componentName}`);
            }
            if (chunk.layer && chunk.layer !== 'unknown') {
              meta.push(`layer:${chunk.layer}`);
            }
            const prefix = meta.length > 0 ? meta.join(' ') + '\n' : '';
            return prefix + chunk.content;
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
      } else if (this.config.skipEmbedding) {
        console.error('Skipping embedding generation (skipEmbedding=true)');
      } else if (chunksToEmbed.length === 0 && diff) {
        console.error('No chunks to embed (all unchanged)');
      }

      // Phase 4: Storing
      this.updateProgress('storing', 75);

      // For full rebuilds, use staging directory for atomic swap
      // For incremental, write directly to active location
      const isFullRebuild = !diff;
      let activeContextDir = contextDir;

      if (isFullRebuild) {
        // Create staging directory for atomic swap
        const stagingBase = path.join(contextDir, STAGING_DIRNAME);
        stagingDir = path.join(stagingBase, buildId);
        await fs.mkdir(stagingDir, { recursive: true });
        activeContextDir = stagingDir;
        console.error(`Full rebuild: writing to staging ${stagingDir}`);
      }

      await fs.mkdir(activeContextDir, { recursive: true });

      if (!this.config.skipEmbedding) {
        const storagePath = path.join(activeContextDir, VECTOR_DB_DIRNAME);
        const storageProvider = await getStorageProvider({ path: storagePath });

        if (diff) {
          // Incremental: delete old chunks for changed + deleted files, then add new
          const filesToDelete = [...diff.changed, ...diff.deleted].map((rel) =>
            path.join(this.rootPath, rel).replace(/\\/g, '/')
          );
          // Also try with OS-native separators for matching
          const filePathsForDelete = [...diff.changed, ...diff.deleted].map((rel) =>
            path.resolve(this.rootPath, rel)
          );
          const allDeletePaths = [...new Set([...filesToDelete, ...filePathsForDelete])];

          if (allDeletePaths.length > 0) {
            await storageProvider.deleteByFilePaths(allDeletePaths);
          }
          if (chunksWithEmbeddings.length > 0) {
            await storageProvider.store(chunksWithEmbeddings);
          }
          console.error(
            `Incremental store: deleted chunks for ${diff.changed.length + diff.deleted.length} files, ` +
              `added ${chunksWithEmbeddings.length} new chunks`
          );
        } else {
          // Full rebuild: store to staging (no clear - fresh directory)
          console.error(`Storing ${chunksToEmbed.length} chunks to staging...`);
          await storageProvider.store(chunksWithEmbeddings);
        }
      }

      // Vector DB build marker (required for version gating)
      // Write after semantic store step so marker reflects the latest DB state.
      const vectorDir = path.join(activeContextDir, VECTOR_DB_DIRNAME);
      await fs.mkdir(vectorDir, { recursive: true });
      await fs.writeFile(
        path.join(vectorDir, 'index-build.json'),
        JSON.stringify({ buildId, formatVersion: INDEX_FORMAT_VERSION })
      );

      // Keyword index always uses ALL chunks (full regen)
      const indexPath = path.join(activeContextDir, KEYWORD_INDEX_FILENAME);
      // Memory safety: cap keyword index too
      const keywordChunks =
        allChunks.length > MAX_CHUNKS ? allChunks.slice(0, MAX_CHUNKS) : allChunks;
      await fs.writeFile(
        indexPath,
        JSON.stringify({
          header: { buildId, formatVersion: INDEX_FORMAT_VERSION },
          chunks: keywordChunks
        })
      );

      // Save library usage and pattern stats (always full regen)
      const intelligencePath = path.join(activeContextDir, INTELLIGENCE_FILENAME);
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
        header: { buildId, formatVersion: INDEX_FORMAT_VERSION },
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
        generatedAt
      };
      await fs.writeFile(intelligencePath, JSON.stringify(intelligence, null, 2));

      // Write relationships sidecar (versioned, for fast lookup)
      const relationshipsPath = path.join(activeContextDir, RELATIONSHIPS_FILENAME);
      const graphData = internalFileGraph.toJSON();

      // Build reverse import map (importedBy)
      const importedBy: Record<string, string[]> = {};
      if (graphData.imports) {
        for (const [file, deps] of Object.entries(graphData.imports)) {
          for (const dep of deps as string[]) {
            if (!importedBy[dep]) importedBy[dep] = [];
            importedBy[dep].push(file);
          }
        }
      }

      // Build symbol export map (exportedBy)
      const exportedBy: Record<string, string[]> = {};
      if (graphData.exports) {
        for (const [file, exps] of Object.entries(graphData.exports)) {
          for (const exp of exps as Array<{ name: string; type: string }>) {
            if (exp.name && exp.name !== 'default') {
              if (!exportedBy[exp.name]) exportedBy[exp.name] = [];
              if (!exportedBy[exp.name].includes(file)) {
                exportedBy[exp.name].push(file);
              }
            }
          }
        }
      }

      const relationships = {
        header: { buildId, formatVersion: INDEX_FORMAT_VERSION },
        generatedAt,
        graph: {
          imports: graphData.imports || {},
          ...(graphData.importDetails ? { importDetails: graphData.importDetails } : {}),
          importedBy,
          exports: graphData.exports || {}
        },
        symbols: {
          exportedBy
        },
        stats: graphData.stats || internalFileGraph.getStats()
      };
      await fs.writeFile(relationshipsPath, JSON.stringify(relationships, null, 2));

      // Write manifest (both full and incremental)
      // For full rebuild, write to staging; for incremental, write to active
      const activeManifestPath = path.join(activeContextDir, MANIFEST_FILENAME);
      const manifest: FileManifest = {
        version: 1,
        generatedAt: new Date().toISOString(),
        files: currentHashes ?? (await computeFileHashes(files, this.rootPath))
      };
      await writeManifest(activeManifestPath, manifest);

      const persistedStats: PersistedIndexingStats = {
        indexedFiles: stats.indexedFiles,
        totalChunks: stats.totalChunks,
        totalFiles: stats.totalFiles,
        generatedAt
      };
      const activeIndexingStatsPath = path.join(activeContextDir, INDEXING_STATS_FILENAME);
      await fs.writeFile(activeIndexingStatsPath, JSON.stringify(persistedStats, null, 2));

      // Index meta (authoritative) — write last so readers never observe meta pointing to missing artifacts.
      const metaPath = path.join(activeContextDir, INDEX_META_FILENAME);
      await fs.writeFile(
        metaPath,
        JSON.stringify(
          {
            metaVersion: INDEX_META_VERSION,
            formatVersion: INDEX_FORMAT_VERSION,
            buildId,
            generatedAt,
            toolVersion,
            artifacts: {
              keywordIndex: { path: KEYWORD_INDEX_FILENAME },
              vectorDb: { path: VECTOR_DB_DIRNAME, provider: 'lancedb' },
              intelligence: { path: INTELLIGENCE_FILENAME },
              manifest: { path: MANIFEST_FILENAME },
              indexingStats: { path: INDEXING_STATS_FILENAME },
              relationships: { path: RELATIONSHIPS_FILENAME }
            }
          },
          null,
          2
        )
      );

      // Atomic swap for full rebuilds: move staging into active location
      if (isFullRebuild && stagingDir) {
        console.error('Performing atomic swap of staging to active...');
        await atomicSwapStagingToActive(contextDir, stagingDir, buildId);
      }

      // Phase 5: Complete
      this.updateProgress('complete', 100);

      stats.duration = Date.now() - startTime;
      stats.completedAt = new Date();

      if (diff) {
        console.error(
          `Incremental indexing complete in ${stats.duration}ms ` +
            `(${diff.added.length} added, ${diff.changed.length} changed, ` +
            `${diff.deleted.length} deleted, ${diff.unchanged.length} unchanged)`
        );
      } else {
        console.error(`Indexing complete in ${stats.duration}ms`);
        console.error(`Indexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks`);
      }

      return stats;
    } catch (error) {
      this.progress.phase = 'error';
      stats.errors.push({
        filePath: this.rootPath,
        error: error instanceof Error ? error.message : String(error),
        phase: this.progress.phase,
        timestamp: new Date()
      });
      // Clean up staging directory on failure (best-effort)
      if (stagingDir) {
        console.error('Cleaning up staging directory after failure...');
        await cleanupDirectory(stagingDir);
      }
      throw error;
    }
  }

  private async scanFiles(): Promise<string[]> {
    const files: string[] = [];
    const seen = new Set<string>();

    // Read .gitignore if respecting it
    let ig: ReturnType<typeof ignore.default> | null = null;
    let gitignorePatterns: string[] = [];
    if (this.config.respectGitignore) {
      try {
        const gitignorePath = path.join(this.rootPath, '.gitignore');
        const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
        ig = ignore.default().add(gitignoreContent);
        // Extract gitignore patterns for glob's ignore parameter
        // Need to normalize patterns for glob: remove leading slashes, add ** variants for directories
        gitignorePatterns = gitignoreContent
          .split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))
          .flatMap(line => {
            // Remove leading slash (gitignore root notation)
            const normalized = line.startsWith('/') ? line.slice(1) : line;
            // If it's a directory pattern, include both the directory and its contents
            if (normalized.endsWith('/')) {
              const dir = normalized.slice(0, -1);
              return [dir, `${dir}/**`, `**/${dir}`, `**/${dir}/**`];
            }
            // For regular patterns, include both root and nested matches
            return [normalized, `**/${normalized}`];
          });
      } catch (_error) {
        // No .gitignore or couldn't read it
      }
    }

    // Scan with glob
    const includePatterns = this.config.include || ['**/*'];
    const excludePatterns = this.config.exclude || [];
    // Combine exclude patterns with gitignore patterns to avoid scanning ignored directories
    const allIgnorePatterns = [...excludePatterns, ...gitignorePatterns];

    for (const pattern of includePatterns) {
      const matches = await glob(pattern, {
        cwd: this.rootPath,
        absolute: true,
        ignore: allIgnorePatterns,
        nodir: true
      });

      for (const file of matches) {
        const normalizedFile = file.replace(/\\/g, '/');
        if (seen.has(normalizedFile)) {
          continue;
        }
        seen.add(normalizedFile);

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
      const intelligencePath = path.join(
        this.rootPath,
        CODEBASE_CONTEXT_DIRNAME,
        INTELLIGENCE_FILENAME
      );
      const intelligenceContent = await fs.readFile(intelligencePath, 'utf-8');
      const intelligence = JSON.parse(intelligenceContent) as IntelligenceData;

      // Phase 06: ignore legacy intelligence files that lack a versioned header.
      if (!intelligence || typeof intelligence !== 'object' || !intelligence.header) {
        return metadata;
      }

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

  private mergeLanguages(
    base: CodebaseMetadata["languages"],
    incoming: CodebaseMetadata["languages"]
  ): CodebaseMetadata["languages"] {
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

  private mergeDependencies(base: Dependency[], incoming: Dependency[]): Dependency[] {
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
    base: Record<string, unknown>,
    incoming: Record<string, unknown>,
    analyzerName: string
  ): Record<string, unknown> {
    const baseAnalyzers =
      base.analyzers && typeof base.analyzers === 'object' && !Array.isArray(base.analyzers)
        ? (base.analyzers as Record<string, unknown>)
        : {};
    const incomingAnalyzers =
      incoming.analyzers &&
      typeof incoming.analyzers === 'object' &&
      !Array.isArray(incoming.analyzers)
        ? (incoming.analyzers as Record<string, unknown>)
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

  getProgress(): IndexingProgress {
    return { ...this.progress };
  }
}
