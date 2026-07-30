import { Context } from "effect";
import type { PtoolsWorkerEnv } from "./ingress.js";

/** Stable Worker bindings captured by the cached HTTP application graph. */
export class WorkerIngressEnv extends Context.Service<
  WorkerIngressEnv,
  PtoolsWorkerEnv
>()("@ptools/host-cloudflare/WorkerIngressEnv") {}
