import { supabase } from "./client.js";
import type { Package } from "./types.js";

export async function fetchPackageByAddressAndSlug(
  address: string,
  slug: string
): Promise<Package | null> {
  const { data, error } = await supabase
    .from("packages")
    .select("*")
    .eq("address", address)
    .eq("slug", slug)
    .single();

  if (error || !data) return null;
  return data;
}
