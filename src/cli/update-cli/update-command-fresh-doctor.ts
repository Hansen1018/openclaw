// Runs the post-plugin migration pass without retaining pre-update plugin modules.
import { DOCTOR_DISABLE_CROSS_STATE_DIR_IMPORTS_ENV } from "../../commands/doctor-invocation.js";
import {
  UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
} from "../../commands/doctor/shared/update-phase.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { runExec } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveNodeRunner } from "./shared.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import {
  disableUpdatedPackageCompileCacheEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service.js";

export const POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON = "post-plugin-doctor-execution-failed";

export async function runPostPluginDoctorInFreshProcess(params: {
  root: string;
  yes: boolean;
  json: boolean;
  timeoutMs: number;
  nodeRunner?: string;
}): Promise<void> {
  const entryPath = await resolveGatewayInstallEntrypoint(params.root);
  if (!entryPath) {
    throw new Error("Updated OpenClaw entrypoint not found for post-plugin doctor");
  }
  const args = [
    entryPath,
    "doctor",
    "--repair",
    "--non-interactive",
    "--no-workspace-suggestions",
    ...(params.yes ? ["--yes"] : []),
  ];
  const result = await runExec(params.nodeRunner ?? resolveNodeRunner(), args, {
    cwd: params.root,
    timeoutMs: params.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    logOutput: false,
    baseEnv: stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env)),
    env: {
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      [DOCTOR_DISABLE_CROSS_STATE_DIR_IMPORTS_ENV]: "1",
      [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
      [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
    },
  });
  if (!params.json) {
    if (result.stdout.trim()) {
      defaultRuntime.log(result.stdout.trimEnd());
    }
    if (result.stderr.trim()) {
      defaultRuntime.error(result.stderr.trimEnd());
    }
  }
}

export async function applyFreshPostPluginDoctor(params: {
  root: string;
  pluginUpdate: PostCorePluginUpdateResult;
  yes: boolean;
  json: boolean;
  timeoutMs: number;
  nodeRunner?: string;
}): Promise<PostCorePluginUpdateResult> {
  try {
    await runPostPluginDoctorInFreshProcess(params);
    return params.pluginUpdate;
  } catch (err) {
    return {
      ...params.pluginUpdate,
      status: "error",
      reason: POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON,
      warnings: [
        ...(params.pluginUpdate.warnings ?? []),
        {
          reason: String(err),
          message: "Updated plugin migrations could not be run in a fresh process.",
          guidance: ["Run `openclaw update repair` to retry post-update plugin repair."],
        },
      ],
    };
  }
}

export function applyPostPluginConfigValidation(
  pluginUpdate: PostCorePluginUpdateResult,
  configValid: boolean,
): PostCorePluginUpdateResult {
  if (
    configValid ||
    (pluginUpdate.status === "error" &&
      pluginUpdate.reason !== POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON)
  ) {
    return pluginUpdate;
  }
  return {
    ...pluginUpdate,
    status: "error",
    reason: "post-plugin-doctor-invalid-config",
    warnings: [
      ...(pluginUpdate.warnings ?? []),
      {
        reason: "Config remained invalid after updated plugin migrations.",
        message:
          "Post-update plugin migration did not produce a valid config; refusing to restart.",
        guidance: ["Run `openclaw doctor --fix`, then rerun `openclaw update repair`."],
      },
    ],
  };
}
