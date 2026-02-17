import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types.js";

const SUPABASE_URL = "https://nnusulwfrelkuejkdgif.supabase.co";
const SUPABASE_KEY =
  "sb_publishable_7nx0iaNVuAQ7z1hZnuwKEQ_1L_xBZxn";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_KEY);
