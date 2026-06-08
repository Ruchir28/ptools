import type { CodeModeObject } from "../objects/CodeModeObject.js";

export interface PtoolsWorkerEnv {
  readonly PTOOLS_CODE_MODE: DurableObjectNamespace<CodeModeObject>;
  readonly PTOOLS_PUBLIC_ACCESS_TOKEN: string;
}
