import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
  setActiveEmbeddedRunLifecycleGeneration,
  type EmbeddedAgentQueueHandle,
} from "./run-state.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunAbortableForRunId,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunHandleSessionId,
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSessionFile,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

function createRunHandle(params: {
  abort?: EmbeddedAgentQueueHandle["abort"];
  queueMessage: EmbeddedAgentQueueHandle["queueMessage"];
  runId: string;
}): EmbeddedAgentQueueHandle {
  return {
    kind: "embedded",
    runId: params.runId,
    queueMessage: params.queueMessage,
    isStreaming: () => true,
    isAbortable: () => false,
    isCompacting: () => false,
    abort: params.abort ?? (() => {}),
  };
}

describe("embedded run registry lifecycle generations", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
  });

  it("rejects a delayed prior-lifecycle registration for a current session owner", async () => {
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const staleQueueMessage = vi.fn(async () => {});
    const staleAbort = vi.fn();
    const staleHandle = createRunHandle({
      abort: staleAbort,
      queueMessage: staleQueueMessage,
      runId: "stale-run",
    });
    setActiveEmbeddedRunLifecycleGeneration(staleHandle, priorLifecycleGeneration);

    rotateAgentEventLifecycleGeneration();
    const currentQueueMessage = vi.fn(async () => {});
    const currentAbort = vi.fn();
    setActiveEmbeddedRun(
      "shared-session",
      createRunHandle({
        abort: currentAbort,
        queueMessage: currentQueueMessage,
        runId: "current-run",
      }),
      "agent:main:current",
      "/tmp/current-session.jsonl",
    );

    setActiveEmbeddedRun(
      "shared-session",
      staleHandle,
      "agent:main:stale",
      "/tmp/stale-session.jsonl",
    );
    updateActiveEmbeddedRunSessionFile(
      "shared-session",
      "/tmp/stale-update.jsonl",
      priorLifecycleGeneration,
    );

    await expect(
      queueEmbeddedAgentMessageWithOutcomeAsync("shared-session", "still live"),
    ).resolves.toMatchObject({ queued: true, target: "embedded_run" });
    expect(currentQueueMessage).toHaveBeenCalledOnce();
    expect(staleQueueMessage).not.toHaveBeenCalled();
    expect(staleAbort).toHaveBeenCalledWith("restart");
    expect(currentAbort).not.toHaveBeenCalled();
    expect(listActiveEmbeddedRunSessionIds()).toContain("shared-session");
    expect(listActiveEmbeddedRunSessionKeys()).toEqual(["agent:main:current"]);
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:stale")).toBeUndefined();
    expect(
      resolveActiveEmbeddedRunHandleSessionIdBySessionFile("/tmp/stale-update.jsonl"),
    ).toBeUndefined();
    expect(isEmbeddedAgentRunAbortableForRunId("current-run")).toBe(false);
    expect(isEmbeddedAgentRunAbortableForRunId("stale-run")).toBe(true);
  });

  it("rejects a delayed prior-lifecycle registration without a replacement owner", async () => {
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const staleQueueMessage = vi.fn(async () => {});
    const staleAbort = vi.fn();
    const staleHandle = createRunHandle({
      abort: staleAbort,
      queueMessage: staleQueueMessage,
      runId: "stale-run",
    });
    setActiveEmbeddedRunLifecycleGeneration(staleHandle, priorLifecycleGeneration);

    rotateAgentEventLifecycleGeneration();
    setActiveEmbeddedRun(
      "stale-session",
      staleHandle,
      "agent:main:stale",
      "/tmp/stale-session.jsonl",
    );

    await expect(
      queueEmbeddedAgentMessageWithOutcomeAsync("stale-session", "should not arrive"),
    ).resolves.toMatchObject({ queued: false, reason: "no_active_run" });
    expect(staleQueueMessage).not.toHaveBeenCalled();
    expect(staleAbort).toHaveBeenCalledWith("restart");
    expect(listActiveEmbeddedRunSessionIds()).not.toContain("stale-session");
    expect(listActiveEmbeddedRunSessionKeys()).not.toContain("agent:main:stale");
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:stale")).toBeUndefined();
    expect(
      resolveActiveEmbeddedRunHandleSessionIdBySessionFile("/tmp/stale-session.jsonl"),
    ).toBeUndefined();
    expect(isEmbeddedAgentRunAbortableForRunId("stale-run")).toBe(true);
  });

  it("propagates failure to abort a delayed prior-lifecycle registration", () => {
    const priorLifecycleGeneration = getAgentEventLifecycleGeneration();
    const staleHandle = createRunHandle({
      abort: () => {
        throw new Error("stale abort failed");
      },
      queueMessage: vi.fn(async () => {}),
      runId: "stale-run",
    });
    setActiveEmbeddedRunLifecycleGeneration(staleHandle, priorLifecycleGeneration);

    rotateAgentEventLifecycleGeneration();

    expect(() => setActiveEmbeddedRun("stale-session", staleHandle, "agent:main:stale")).toThrow(
      "stale abort failed",
    );
    expect(listActiveEmbeddedRunSessionIds()).not.toContain("stale-session");
  });

  it("lets a current-lifecycle owner replace a stale session owner", async () => {
    const staleQueueMessage = vi.fn(async () => {});
    const staleAbort = vi.fn();
    const staleHandle = createRunHandle({
      abort: staleAbort,
      queueMessage: staleQueueMessage,
      runId: "stale-run",
    });
    setActiveEmbeddedRun(
      "shared-session",
      staleHandle,
      "agent:main:stale",
      "/tmp/stale-session.jsonl",
    );

    rotateAgentEventLifecycleGeneration();
    const currentQueueMessage = vi.fn(async () => {});
    const currentAbort = vi.fn();
    setActiveEmbeddedRun(
      "shared-session",
      createRunHandle({
        abort: currentAbort,
        queueMessage: currentQueueMessage,
        runId: "current-run",
      }),
      "agent:main:current",
      "/tmp/current-session.jsonl",
    );
    clearActiveEmbeddedRun("shared-session", staleHandle, "agent:main:stale");

    await expect(
      queueEmbeddedAgentMessageWithOutcomeAsync("shared-session", "now current"),
    ).resolves.toMatchObject({ queued: true, target: "embedded_run" });
    expect(currentQueueMessage).toHaveBeenCalledOnce();
    expect(staleQueueMessage).not.toHaveBeenCalled();
    expect(staleAbort).toHaveBeenCalledOnce();
    expect(staleAbort).toHaveBeenCalledWith("restart");
    expect(currentAbort).not.toHaveBeenCalled();
    expect(listActiveEmbeddedRunSessionIds()).toContain("shared-session");
    expect(listActiveEmbeddedRunSessionKeys()).toEqual(["agent:main:current"]);
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:stale")).toBeUndefined();
    expect(
      resolveActiveEmbeddedRunHandleSessionIdBySessionFile("/tmp/stale-session.jsonl"),
    ).toBeUndefined();
  });

  it("preserves a current owner registered synchronously by stale abort", async () => {
    const currentQueueMessage = vi.fn(async () => {});
    const currentAbort = vi.fn();
    const currentHandle = createRunHandle({
      abort: currentAbort,
      queueMessage: currentQueueMessage,
      runId: "current-run",
    });
    const staleAbort = vi.fn(() => {
      setActiveEmbeddedRun(
        "shared-session",
        currentHandle,
        "agent:main:current",
        "/tmp/current-session.jsonl",
      );
    });
    const staleHandle = createRunHandle({
      abort: staleAbort,
      queueMessage: vi.fn(async () => {}),
      runId: "stale-run",
    });
    setActiveEmbeddedRun(
      "shared-session",
      staleHandle,
      "agent:main:stale",
      "/tmp/stale-session.jsonl",
    );

    rotateAgentEventLifecycleGeneration();

    await expect(
      queueEmbeddedAgentMessageWithOutcomeAsync("shared-session", "current survives"),
    ).resolves.toMatchObject({ queued: true, target: "embedded_run" });
    expect(staleAbort).toHaveBeenCalledWith("restart");
    expect(currentAbort).not.toHaveBeenCalled();
    expect(currentQueueMessage).toHaveBeenCalledOnce();
    expect(listActiveEmbeddedRunSessionKeys()).toEqual(["agent:main:current"]);
  });

  it("evicts reply operations created by a prior hot-loaded module instance", async () => {
    const replyRunsA = await importFreshModule<
      typeof import("../../auto-reply/reply/reply-run-registry.js")
    >(import.meta.url, "../../auto-reply/reply/reply-run-registry.js?scope=generation-a");
    const operation = replyRunsA.createReplyOperation({
      sessionKey: "agent:main:hot-loaded",
      sessionId: "hot-loaded-session",
      resetTriggered: false,
    });
    const cancel = vi.fn();
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });

    const replyRunsB = await importFreshModule<
      typeof import("../../auto-reply/reply/reply-run-registry.js")
    >(import.meta.url, "../../auto-reply/reply/reply-run-registry.js?scope=generation-b");
    rotateAgentEventLifecycleGeneration();

    expect(cancel).toHaveBeenCalledWith("restart");
    expect(replyRunsB.isReplyRunActiveForSessionId("hot-loaded-session")).toBe(false);
  });
});
