/// <reference types="@cloudflare/workers-types" />

import type * as WorkerModule from "../src/worker/entry.js";
import type { TestCodeModeObject } from "./worker-entry.js";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly PTOOLS_CODE_MODE: DurableObjectNamespace<TestCodeModeObject>;
      readonly PTOOLS_PUBLIC_ACCESS_TOKEN: string;
    }

    interface GlobalProps {
      readonly mainModule: typeof WorkerModule;
      readonly durableNamespaces: "TestCodeModeObject";
    }
  }
}
