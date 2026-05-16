# Gemini Workspace Mandates

This file defines foundational rules and workflows for all AI-assisted engineering tasks in this project. These instructions take precedence over general defaults.

## 1. The "Bottleneck-First" Research Workflow

Before proposing any strategy or implementation for a feature or bug fix, the agent MUST perform a **Hot Path Audit** and report findings.

### A. The Audit Process
1.  **Identify Per-Request Work:** Trace the main execution paths (e.g., `search`, `execute`, API handlers).
2.  **Scan for Heavy Operations:** Identify operations within these paths that perform:
    *   Dynamic code/type generation (e.g., `json-schema-to-typescript`).
    *   Heavy I/O or network requests.
    *   Deep object transformations or repeated serialization.
    *   Blocking CPU-bound tasks.
3.  **Trace Lifecycle Decisions:** Determine if an operation happening at "runtime" (per request) could instead happen at "start-up" (Layer/Service initialization).

### B. Proactive Reporting
Before implementation, present a **Findings & Observations** report with:
*   **The Observation:** "Function X performs Y on every Z call."
*   **The Trade-off:** "This prioritizes [Memory/Token Count/Simplicity] but at the cost of [Latency/CPU/Scale]."
*   **The Inquiry:** "Is this trade-off intentional, or should we explore a caching/pre-computation strategy?"

## 2. Architectural Red Flags

The agent must explicitly flag and discuss the following patterns if discovered:
*   **State Leakage:** Service-level state being modified by per-request flows without clear isolation.
*   **Inefficient Caching:** Large data structures being regenerated instead of being computed once.
*   **Hidden Latency:** Serial IPC calls or blocking operations in async-first environments.
*   **Implicit Dependencies:** Cross-package imports that bypass the defined service/registry layers.

## 3. Engineering Standards

*   **Explicit Composition:** Prefer wrappers and delegation over inheritance.
*   **Type Safety:** No `any` casts or warning suppressions unless explicitly instructed.
*   **Verification:** Every change must include a plan for empirical verification (repro script or test case).
