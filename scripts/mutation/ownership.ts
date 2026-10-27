// Which tests measure a kernel module, DERIVED — never hand-listed.
//
// A mutation score is a statement about the tests that kill the mutants, so the
// scope has to follow the tests that exercise the kernel on purpose: the ones
// that import one of its mutated sources. An enumerated list cannot state that
// (a new test silently stays out), and transitive reach states something else:
// `packages/kernel/src/errors.ts` is reachable from nearly every test in the
// repository, so a reach-based scope is the whole suite. That scope grows with
// every unrelated test and no shard count bounds it, because every shard replays
// the full scope in its dry run — the weekly kernel-errors shard went from 1,396
// to 1,471 related files in one week and outran its job (weekly run 40164641005).
//
// So a test owns a kernel when it has an executable (value or dynamic) import
// of one of the kernel's mutated sources, directly or through a barrel's named
// re-export. A mutant that only a distant test can kill shows up as a survivor
// in the kernel's own tests — work for a test-strengthening PR, never a silent
// pass. The scope the weekly sweep runs
// and the PR lane's derived selection read this one rule.

import fs from 'node:fs';
import path from 'node:path';
import { workspaceSpecifierTargets } from '../layering/package-boundaries.ts';
import { resolveImportEdges } from '../layering/model.ts';
import { listTrackedTypeScriptFiles } from '../layering/tracked-sources.ts';
import { edgeKind, EXECUTABLE_EDGES } from '../depgraph/import-graph.ts';
import {
  affectedModules,
  isKernelTestFile,
  KERNEL_MODULES,
  normalizePath,
  type ModuleId,
  type KernelModule,
} from './modules.ts';
import { expandMutateFiles, threadHostileTestFiles } from './test-scope.ts';
import { MUTATION_EXCLUDED_TESTS } from '../../vitest.config.ts';

/**
 * Test files the mutation lane can attribute to a kernel at all: the unit roots, minus every test
 * the lane must not collect (`MUTATION_EXCLUDED_TESTS`, which includes other projects' tests).
 */
export function isTestFile(filePath: string): boolean {
  const file = normalizePath(filePath);
  return (
    isKernelTestFile(file) &&
    !MUTATION_EXCLUDED_TESTS.some((excluded) => path.matchesGlob(file, excluded))
  );
}

type ImportedModule = { target: string; symbols: readonly string[] };

const importsByRepository = new Map<string, Map<string, ImportedModule[]>>();

/**
 * Every tracked file's direct executable imports, with the names each one takes. Workspace package
 * specifiers resolve through the shared exports-map reader (scripts/layering/package-boundaries.ts),
 * so a test importing `@agent-device/kernel/errors` lands on `packages/kernel/src/errors.ts`.
 */
function directImports(repoRoot: string): Map<string, ImportedModule[]> {
  const cached = importsByRepository.get(repoRoot);
  if (cached) return cached;
  const files = listTrackedTypeScriptFiles(repoRoot);
  const sources = new Map(
    files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]),
  );
  const imports = new Map<string, ImportedModule[]>();
  for (const edge of resolveImportEdges(sources, workspaceSpecifierTargets(repoRoot))) {
    if (!EXECUTABLE_EDGES.has(edgeKind(edge))) continue;
    let targets = imports.get(edge.file);
    if (!targets) imports.set(edge.file, (targets = []));
    targets.push({ target: edge.target, symbols: edge.symbols });
  }
  importsByRepository.set(repoRoot, imports);
  return imports;
}

/**
 * The modules whose code `file` imports for execution: each direct import, and through a barrel the
 * module a named import comes from. A module cannot both import a name and declare it, so a name a
 * test takes from module M that M itself takes from T is one M re-exports from T.
 */
export function importedBy(file: string, repoRoot: string): ReadonlySet<string> {
  const imports = directImports(repoRoot);
  const reached = new Set<string>();
  const visit = (module: string, names: readonly string[]) => {
    for (const edge of imports.get(module) ?? []) {
      const reexported = edge.symbols.filter((symbol) => names.includes(symbol));
      if (reexported.length === 0 || reached.has(edge.target)) continue;
      reached.add(edge.target);
      visit(edge.target, reexported);
    }
  };
  for (const edge of imports.get(normalizePath(file)) ?? []) {
    reached.add(edge.target);
    visit(edge.target, edge.symbols);
  }
  return reached;
}

/** The concrete sources Stryker mutates for a module. */
export function mutatedSources(module: KernelModule, repoRoot: string): string[] {
  return expandMutateFiles(module.mutate, repoRoot);
}

type Deriver = {
  /** Kernel modules a single test file imports, in registry order. */
  ownersOf: (testFile: string) => ModuleId[];
};

/** Shares the import index and mutated-source sets across test queries. */
export function ownershipDeriver(repoRoot: string): Deriver {
  const sources = KERNEL_MODULES.map((module) => ({
    id: module.id,
    sources: mutatedSources(module, repoRoot),
  }));
  return {
    ownersOf(testFile) {
      const imported = importedBy(testFile, repoRoot);
      return sources
        .filter((entry) => entry.sources.some((source) => imported.has(source)))
        .map((entry) => entry.id);
    },
  };
}

/**
 * Kernel modules a diff affects: registry-owned paths plus every module the
 * changed tests own. Registry order, deduplicated.
 */
export function derivedAffectedModules(
  changedFiles: readonly string[],
  repoRoot: string,
): ModuleId[] {
  const ids = new Set<ModuleId>(affectedModules(changedFiles));
  const tests = changedFiles.filter(isTestFile).map(normalizePath);
  if (tests.length > 0) {
    const deriver = ownershipDeriver(repoRoot);
    for (const testFile of tests) {
      for (const id of deriver.ownersOf(testFile)) ids.add(id);
    }
  }
  return KERNEL_MODULES.filter((module) => ids.has(module.id)).map((module) => module.id);
}

/**
 * Every tracked test file, per module that owns it. Tracked files are what the import index reads,
 * so an unstaged new test owns nothing until it is added.
 */
export function ownedTestFiles(repoRoot: string): Map<ModuleId, string[]> {
  const deriver = ownershipDeriver(repoRoot);
  const owned = new Map<ModuleId, string[]>(KERNEL_MODULES.map((module) => [module.id, []]));
  for (const file of listTrackedTypeScriptFiles(repoRoot).filter(isTestFile)) {
    for (const id of deriver.ownersOf(file)) owned.get(id)!.push(file);
  }
  for (const files of owned.values()) files.sort();
  return owned;
}

/**
 * The tests Stryker replays for each module: its owned tests, minus the ones
 * that cannot run in Stryker's thread pool (see `threadHostileTestFiles`).
 */
export function mutationTestScopes(repoRoot: string): Map<ModuleId, string[]> {
  const excluded = new Set(threadHostileTestFiles(repoRoot));
  return new Map(
    [...ownedTestFiles(repoRoot)].map(([id, files]) => [
      id,
      files.filter((file) => !excluded.has(file)),
    ]),
  );
}

/** The union of {@link mutationTestScopes} for a module set. */
export function mutationTestFiles(modules: readonly ModuleId[], repoRoot: string): string[] {
  const scopes = mutationTestScopes(repoRoot);
  return [...new Set(modules.flatMap((id) => scopes.get(id) ?? []))].sort();
}
