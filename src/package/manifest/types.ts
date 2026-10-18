export interface ParsedAddress {
  readonly org: string;
  readonly repo: string;
  readonly subpath: string | null;
}

// --- Package section ---
export interface PackageSection {
  readonly name: string;
  readonly address: string;
  readonly version: string;
  readonly description: string;
  readonly display_name?: string;
  readonly authors?: string[];
  readonly license?: string;
  readonly mthds_version?: string;
  readonly main_pipe?: string;
  readonly exclude?: string[];
}

// --- Exports: hierarchical with pipes arrays ---
export interface ExportNode {
  readonly pipes?: string[];
  readonly [subdomain: string]: ExportNode | string[] | undefined;
}
export type Exports = Record<string, ExportNode>;

// --- Manifest ---
export interface MethodsManifest {
  readonly package: PackageSection;
  readonly exports?: Exports;
}

/** One file of a method's tree: its tree path and its exact bytes. */
export interface MethodsFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type PackageSource = "github" | "local";

// --- Single resolved method ---
export interface ResolvedMethod {
  readonly name: string;
  readonly manifest: MethodsManifest;
  readonly rawManifest: string;
  /**
   * Every file of the method's tree, as the standard's lister defines it from the method's
   * directory, its `METHODS.toml` included, sorted by tree path byte for byte.
   */
  readonly files: MethodsFile[];
}

// --- Skipped method ---
export interface SkippedMethod {
  readonly dirName: string;
  readonly errors: string[];
}

// --- Resolved repo (multiple methods) ---
export interface ResolvedRepo {
  readonly methods: ResolvedMethod[];
  readonly skipped: SkippedMethod[];
  readonly source: PackageSource;
  readonly repoName: string;
  readonly isPublic: boolean;
}
