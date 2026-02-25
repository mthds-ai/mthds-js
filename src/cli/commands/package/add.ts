import * as p from "@clack/prompts";
import { printLogo } from "../index.js";

export function packageAdd(
  _dep: string,
  _options: { directory?: string; alias?: string; version?: string; path?: string },
): void {
  printLogo();
  p.intro("mthds package add");
  p.log.error("Dependencies are not supported in this version.");
  p.outro("");
}
