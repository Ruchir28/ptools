export type { CodeModeClientHandle } from "@ptools/code-mode-api";
export { HostNodeError, NODE_LOCAL_HOST_ID } from "./options.js";
export {
  connectLocalNodeHost,
  createNodeCodeModeClient,
} from "./clientHandles.js";
export type { ConnectLocalNodeHostOptions } from "./clientHandles.js";
export {
  DEFAULT_NODE_DEPLOYMENT_NAME,
  NodeDeploymentName,
  type NodeDeploymentName as NodeDeploymentNameType,
} from "./localDeployments/contracts/nodeDeploymentName.js";
export {
  DEFAULT_NODE_CONTROL_PLANE_PORT,
  DEFAULT_NODE_PUBLIC_ORIGIN,
  NodeControlPlanePort,
  NodeDeploymentStateDirectory,
  NodeLocalDeploymentDescriptor,
} from "./localDeployments/contracts/nodeLocalDeploymentDescriptor.js";
export {
  createNodeLocalDeployment,
  configureNodeLocalDeployment,
  listNodeLocalDeployments,
  resolveNodeLocalDeployment,
} from "./localDeployments/nodeLocalDeploymentCatalog.js";
export { startNodeLocalDeployment } from "./services/nodeLocalDeploymentRunner.js";
export { assertNodeDeploymentStateQuiescent } from "./hostControlPlaneDaemon/ownership/nodeHostControlPlaneOwnership.js";
