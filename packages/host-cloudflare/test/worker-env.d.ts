/// <reference types="@cloudflare/workers-types" />

import type { CodeModeObject } from "../src/objects/CodeModeObject.js";
import type * as WorkerModule from "../src/worker/entry.js";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly PTOOLS_CODE_MODE: DurableObjectNamespace<CodeModeObject>;
      readonly PTOOLS_PUBLIC_ACCESS_TOKEN: string;
    }

    interface GlobalProps {
      readonly mainModule: typeof WorkerModule;
      readonly durableNamespaces: "CodeModeObject";
    }
  }
}
