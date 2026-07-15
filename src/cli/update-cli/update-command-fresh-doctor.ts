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
import {
  disableUpdatedPackageCompileCacheEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service.js";

export async function runPostPluginDoctorInFreshProcess(params: {
  root: string;
  yes: boolean;
  json: boolean;
  timeoutMs: number;
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
  const result = await runExec(resolveNodeRunner(), args, {
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
