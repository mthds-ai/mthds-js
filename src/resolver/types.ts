export interface ParsedAddress {
  readonly org: string;
  readonly repo: string;
  readonly subpath: string | null;
}

// --- Package section ---
export interface PackageSection {
  readonly address: string;
  readonly version: string;
  readonly description: string;
  readonly display_name?: string;
  readonly authors?: string[];
  readonly license?: string;
  readonly mthds_version?: string;
}

// --- Exports: hierarchical with pipes arrays ---
export interface ExportNode {
  readonly pipes?: string[];
  readonly [subdomain: string]: ExportNode | string[] | undefined;
}
export type Exports = Record<string, ExportNode>;

// --- Dependencies ---
export interface DependencySpec {
  readonly address: string;
  readonly version: string;
}

// --- Manifest ---
export interface MethodsManifest {
  readonly package: PackageSection;
  readonly exports?: Exports;
  readonly dependencies?: Record<string, DependencySpec>;
}

export interface MethodsFile {
  readonly relativePath: string;
  readonly content: string;
}

export type PackageSource = "github" | "local";

// --- Single resolved method ---
export interface ResolvedMethod {
  readonly slug: string;
  readonly manifest: MethodsManifest;
  readonly rawManifest: string;
  readonly files: MethodsFile[];
}

// --- Skipped method ---
export interface SkippedMethod {
  readonly slug: string;
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
