import { supabase } from "./client.js";
import type { Method } from "./types.js";

export async function fetchMethodBySlug(
  slug: string
): Promise<Method | null> {
  const { data, error } = await supabase
    .from("methods")
    .select("*")
    .eq("name", slug)
    .single();

  if (error || !data) return null;
  return data;
}
