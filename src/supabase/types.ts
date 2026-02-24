export interface Package {
  id: string;
  address: string;
  slug: string;
  version: string | null;
  description: string | null;
  display_name: string | null;
  authors: string[] | null;
  license: string | null;
  mthds_version: string | null;
  exports: Record<string, unknown> | null;
  dependencies: Record<string, unknown> | null;
  manifest_raw: string | null;
  installs: number;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      packages: {
        Row: Package;
        Insert: Omit<Package, "id" | "created_at" | "installs">;
        Update: Partial<Omit<Package, "id">>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
