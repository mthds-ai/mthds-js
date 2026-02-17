export interface Method {
  id: string;
  name: string;
  description: string | null;
  content: string | null;
  version: string | null;
  repository: string | null;
  dependencies: string | null;
  installs: number;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      methods: {
        Row: Method;
        Insert: Omit<Method, "id" | "created_at" | "installs">;
        Update: Partial<Omit<Method, "id">>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
