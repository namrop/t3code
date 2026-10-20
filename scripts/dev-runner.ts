#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - bootstrap must not load dependency code.
import * as NodePath from "node:path";

import { reexecOwnedDev } from "./lib/owned-worktree.ts";
import type * as Runtime from "./dev-runner-runtime.ts";

if (import.meta.main) {
  reexecOwnedDev(NodePath.dirname(import.meta.dirname), [
    process.execPath,
    ...process.argv.slice(1),
  ]);
}

// Static runtime imports/re-exports would resolve dependencies before bootstrap.
const runtime = await import("./dev-runner-runtime.ts");

export const isProxiableBindHost: typeof Runtime.isProxiableBindHost = runtime.isProxiableBindHost;
export const DEFAULT_T3_HOME: typeof Runtime.DEFAULT_T3_HOME = runtime.DEFAULT_T3_HOME;
export const getDevRunnerModeArgs: typeof Runtime.getDevRunnerModeArgs =
  runtime.getDevRunnerModeArgs;
export const isBrowserAllowedPort: typeof Runtime.isBrowserAllowedPort =
  runtime.isBrowserAllowedPort;
export const DevRunnerConfigurationError: typeof Runtime.DevRunnerConfigurationError =
  runtime.DevRunnerConfigurationError;
export type DevRunnerConfigurationError = Runtime.DevRunnerConfigurationError;
export const DevRunnerInvalidPortOffsetError: typeof Runtime.DevRunnerInvalidPortOffsetError =
  runtime.DevRunnerInvalidPortOffsetError;
export type DevRunnerInvalidPortOffsetError = Runtime.DevRunnerInvalidPortOffsetError;
export const DevRunnerPortExhaustedError: typeof Runtime.DevRunnerPortExhaustedError =
  runtime.DevRunnerPortExhaustedError;
export type DevRunnerPortExhaustedError = Runtime.DevRunnerPortExhaustedError;
export const DevRunnerProcessError: typeof Runtime.DevRunnerProcessError =
  runtime.DevRunnerProcessError;
export type DevRunnerProcessError = Runtime.DevRunnerProcessError;
export const DevRunnerProcessExitError: typeof Runtime.DevRunnerProcessExitError =
  runtime.DevRunnerProcessExitError;
export type DevRunnerProcessExitError = Runtime.DevRunnerProcessExitError;
export const DevRunnerHostNotProxiableError: typeof Runtime.DevRunnerHostNotProxiableError =
  runtime.DevRunnerHostNotProxiableError;
export type DevRunnerHostNotProxiableError = Runtime.DevRunnerHostNotProxiableError;
export const resolveOffset: typeof Runtime.resolveOffset = runtime.resolveOffset;
export const createDevRunnerEnv: typeof Runtime.createDevRunnerEnv = runtime.createDevRunnerEnv;
export const checkPortAvailabilityOnHosts: typeof Runtime.checkPortAvailabilityOnHosts =
  runtime.checkPortAvailabilityOnHosts;
export const devPortProbeHosts: typeof Runtime.devPortProbeHosts = runtime.devPortProbeHosts;
export const findFirstAvailableOffset: typeof Runtime.findFirstAvailableOffset =
  runtime.findFirstAvailableOffset;
export const resolveModePortOffsets: typeof Runtime.resolveModePortOffsets =
  runtime.resolveModePortOffsets;
export const runDevRunnerWithInput: typeof Runtime.runDevRunnerWithInput =
  runtime.runDevRunnerWithInput;

if (import.meta.main) {
  runtime.runDevRunnerMain();
}
