import * as p from "@clack/prompts";
import { printLogo } from "../index.js";

const STUB_MESSAGE =
  "Not yet implemented in mthds-js. Use mthds-python for package management.";

function packageStub(cmd: string): () => void {
  return () => {
    printLogo();
    p.intro(`mthds package ${cmd}`);
    p.log.warning(STUB_MESSAGE);
    p.outro("");
  };
}

export const packageInit = packageStub("init");
export const packageList = packageStub("list");
export const packageAdd = packageStub("add");
export const packageLock = packageStub("lock");
export const packageInstall = packageStub("install");
export const packageUpdate = packageStub("update");
