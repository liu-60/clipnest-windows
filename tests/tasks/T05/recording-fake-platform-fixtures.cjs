"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PREPARATION_BOUNDARY = Object.freeze({
  classification: "PREPARATION_ONLY",
  productBehaviorExecuted: false,
  productionModulesImported: false,
  helperLaunched: false,
  desktopWindowCreated: false,
  systemClipboardReadOrWritten: false,
  physicalInputSent: false,
  networkUsed: false,
  applicationPersistentStateWritten: false,
});

// These are inert inputs for a future harness. They contain no expected result,
// assertion outcome, or recorded product call trace.
const SCENARIO_SEEDS = [
  { caseId: "P01", runs: [{ runId: "P01-ready-target", initialState: { capturedTarget: "fake-target-a", foregroundTarget: "fake-target-a", minimized: false, maximized: false }, stimuli: [{ event: "selection.captured" }, { event: "execute.requested" }] }] },
  { caseId: "P02", runs: [{ runId: "P02-restorable-target", initialState: { capturedTarget: "fake-target-a", foregroundTarget: "fake-target-b", capturedTargetAvailable: true }, stimuli: [{ event: "selection.captured" }, { event: "execute.requested" }] }] },
  { caseId: "P03", runs: [{ runId: "P03-minimized-target", initialState: { capturedTarget: "fake-target-a", foregroundTarget: "fake-target-b", minimized: true }, stimuli: [{ event: "selection.captured" }, { event: "execute.requested" }] }] },
  { caseId: "P04", runs: [{ runId: "P04-maximized-target", initialState: { capturedTarget: "fake-target-a", foregroundTarget: "fake-target-b", maximized: true, bounds: { left: 17, top: 23, width: 1280, height: 720 } }, stimuli: [{ event: "selection.captured" }, { event: "execute.requested" }] }] },
  { caseId: "P05", runs: [{ runId: "P05-destroyed-target", initialState: { capturedTarget: "fake-target-a", foregroundTarget: "fake-target-b", capturedProcessIdentity: "synthetic-process-a" }, stimuli: [{ event: "target.handle-destroyed" }, { event: "execute.requested" }] }, { runId: "P05-process-identity-changed", initialState: { capturedTarget: "fake-target-a", foregroundTarget: "fake-target-b", capturedProcessIdentity: "synthetic-process-a" }, stimuli: [{ event: "target.process-identity-changed" }, { event: "execute.requested" }] }] },
  { caseId: "P06", runs: [{ runId: "P06-trigger-held", initialState: { capturedTarget: "fake-target-a", physicallyHeldKeys: ["SHIFT"] }, stimuli: [{ event: "selection.captured" }, { event: "execute.requested" }] }] },
  { caseId: "P07", runs: [{ runId: "P07-cancel-before-copy", initialState: { commitBoundary: "before-clipboard" }, stimuli: [{ event: "execute.requested" }, { event: "cancel.requested" }] }, { runId: "P07-cancel-after-copy", initialState: { commitBoundary: "after-clipboard-before-input" }, stimuli: [{ event: "clipboard.commit-boundary-reached" }, { event: "cancel.requested" }] }] },
  { caseId: "P08", runs: [{ runId: "P08-cancel-while-waiting", initialState: { jobPhase: "waiting-for-focus-or-modifiers" }, stimuli: [{ event: "execute.requested" }, { event: "cancel.requested" }] }] },
  { caseId: "P09", runs: [{ runId: "P09-cancel-after-input-gate", initialState: { jobPhase: "input-commit-gate-crossed" }, stimuli: [{ event: "execute.requested" }, { event: "cancel.requested" }] }] },
  { caseId: "P10", runs: [{ runId: "P10-helper-disconnect", initialState: { helperInstance: "synthetic-helper-a", requestId: "P10-request-a" }, stimuli: [{ event: "request.sent" }, { event: "helper.disconnected" }] }] },
  { caseId: "P11", runs: [{ runId: "P11-external-change-before-write", initialState: { clipboardSequence: 10 }, stimuli: [{ event: "preparation.pending" }, { event: "clipboard.external-sequence-changed", value: 11 }, { event: "conditional-write.boundary" }] }, { runId: "P11-external-change-after-write", initialState: { clipboardSequence: 10 }, stimuli: [{ event: "conditional-write.boundary" }, { event: "clipboard.external-sequence-changed", value: 12 }, { event: "input.commit-boundary" }] }] },
  { caseId: "P12", runs: [{ runId: "P12-repeated-intents", initialState: { activeIntent: "synthetic-intent-a" }, stimuli: [{ event: "card.double-click" }, { event: "enter.repeated" }, { event: "enter.repeated" }] }] },
  { caseId: "P13", runs: [{ runId: "P13-stale-generation-ack", initialState: { firstGeneration: 31, secondGeneration: 32, requestGeneration: 31 }, stimuli: [{ event: "panel.generation-opened", value: 31 }, { event: "panel.generation-opened", value: 32 }, { event: "delayed-ack.arrived", value: 31 }] }] },
  { caseId: "P14", runs: [{ runId: "P14-authorization-denied", initialState: { capturedTargetIntegrity: "synthetic-higher-integrity", foregroundAuthorization: "denied" }, stimuli: [{ event: "execute.requested" }] }] },
  { caseId: "P15", runs: [{ runId: "P15-unchanged-image-sequence", initialState: { clipboardSequence: 55, clipboardKind: "image" }, stimuli: [{ event: "clipboard.sequence-notified", value: 55 }, { event: "clipboard.sequence-notified", value: 55 }, { event: "clipboard.sequence-notified", value: 55 }] }] },
  { caseId: "P16", runs: [{ runId: "P16-image-cache-miss", initialState: { clipboardSequence: 61, decodedCache: "miss", imageId: "synthetic-image-a" }, stimuli: [{ event: "image.selected" }, { event: "preparation.requested" }] }] },
  { caseId: "P17", runs: [{ runId: "P17-budget-full", initialState: { queueBudget: "full", memoryBudget: "full" }, stimuli: [{ event: "work.submitted", value: "synthetic-item-a" }, { event: "work.submitted", value: "synthetic-item-b" }] }] },
  { caseId: "P18", runs: [{ runId: "P18-foreground-switch", initialState: { capturedTarget: "fake-target-a", foregroundTarget: "fake-target-b", restorationInProgress: true }, stimuli: [{ event: "execute.requested" }, { event: "foreground.changed", value: "fake-target-c" }] }] },
  { caseId: "P19", runs: [{ runId: "P19-sequence-41-to-42", initialState: { clipboardSequence: 41, preparation: "pending" }, stimuli: [{ event: "clipboard.external-sequence-changed", value: 42 }, { event: "preparation.completed" }, { event: "conditional-write.requested" }] }] },
  { caseId: "P20", runs: [{ runId: "P20-sequence-42-to-43", initialState: { clipboardSequence: 42, ownConditionalWriteSequence: 42 }, stimuli: [{ event: "clipboard.external-sequence-changed", value: 43 }, { event: "input.commit-boundary" }] }] },
  { caseId: "P21", runs: [{ runId: "P21-A-before-deadline", initialState: { selectionDeadlineMs: 500, triggerHeld: true, preparation: "delayed" }, stimuli: [{ event: "trigger.repeated-before-deadline" }, { event: "preparation.completed-before-deadline" }] }, { runId: "P21-B-held-through-deadline", initialState: { selectionDeadlineMs: 500, triggerHeld: true, preparation: "delayed" }, stimuli: [{ event: "selection.deadline-reached" }, { event: "trigger.released-after-deadline" }] }, { runId: "P21-C-release-at-cutoff-prepare-late", initialState: { selectionDeadlineMs: 500, triggerHeld: false, preparation: "delayed" }, stimuli: [{ event: "trigger.released-at-cutoff" }, { event: "preparation.completed-after-deadline" }, { event: "trigger.re-pressed" }] }] },
  { caseId: "P22", runs: [{ runId: "P22-blocked-focus-worker", initialState: { workerState: "focus-api-blocked", controlReader: "available" }, stimuli: [{ event: "cancel.requested" }, { event: "focus-worker.released" }] }] },
  { caseId: "P23", runs: [{ runId: "P23-cancel-before-gate", initialState: { inputCommitGate: "not-crossed" }, stimuli: [{ event: "cancel.requested" }, { event: "input.commit-boundary" }] }, { runId: "P23-cancel-after-gate", initialState: { inputCommitGate: "crossed" }, stimuli: [{ event: "input.commit-boundary" }, { event: "cancel.requested" }] }] },
  { caseId: "P24", runs: [{ runId: "P24-item-changed", initialState: { preparedToken: "synthetic-token-a", identityChange: "item" }, stimuli: [{ event: "prepared-token.replayed" }] }, { runId: "P24-version-changed", initialState: { preparedToken: "synthetic-token-a", identityChange: "version" }, stimuli: [{ event: "prepared-token.replayed" }] }, { runId: "P24-profile-changed", initialState: { preparedToken: "synthetic-token-a", identityChange: "profile" }, stimuli: [{ event: "prepared-token.replayed" }] }, { runId: "P24-helper-changed", initialState: { preparedToken: "synthetic-token-a", identityChange: "helper-instance" }, stimuli: [{ event: "prepared-token.replayed" }] }] },
  { caseId: "P25", runs: [{ runId: "P25-oversized-frame", initialState: { streamVariant: "oversized-frame" }, stimuli: [{ event: "stream.submitted" }] }, { runId: "P25-missing-frame", initialState: { streamVariant: "missing-frame" }, stimuli: [{ event: "stream.submitted" }] }, { runId: "P25-reordered-chunks", initialState: { streamVariant: "reordered-chunks" }, stimuli: [{ event: "stream.submitted" }] }, { runId: "P25-duplicate-chunk", initialState: { streamVariant: "duplicate-chunk" }, stimuli: [{ event: "stream.submitted" }] }, { runId: "P25-hash-mismatch", initialState: { streamVariant: "hash-mismatch" }, stimuli: [{ event: "stream.submitted" }] }, { runId: "P25-valid-bounded", initialState: { streamVariant: "valid-bounded" }, stimuli: [{ event: "stream.submitted" }] }] },
  { caseId: "P26", runs: [{ runId: "P26-not-foreground", initialState: { hostForeground: false }, stimuli: [{ event: "foreground-authorization.requested" }] }, { runId: "P26-authorization-fails", initialState: { hostForeground: true, authorization: "denied" }, stimuli: [{ event: "foreground-authorization.requested" }] }, { runId: "P26-helper-identity-changes", initialState: { helperPid: "synthetic-pid-a", helperCreationIdentity: "synthetic-created-a" }, stimuli: [{ event: "helper.pid-or-creation-identity-changed" }, { event: "foreground-authorization.requested" }] }] },
  { caseId: "P27", runs: [{ runId: "P27-foreground-switch-after-hide", initialState: { panel: "hidden", capturedTarget: "fake-target-a", focusPreparation: "in-progress" }, stimuli: [{ event: "foreground.changed", value: "fake-target-b" }, { event: "fixed-target-job.continued" }] }] },
  { caseId: "P28", runs: [{ runId: "P28-backpressured-duplicate-enter", initialState: { activeJobs: 1, stdout: "backpressured" }, stimuli: [{ event: "enter.duplicate" }] }, { runId: "P28-backpressured-duplicate-show", initialState: { activeJobs: 1, stdout: "backpressured" }, stimuli: [{ event: "show.duplicate" }] }, { runId: "P28-cancel-reader-and-overflow", initialState: { activeJobs: 1, stdout: "backpressured", cancelReader: "available" }, stimuli: [{ event: "cancel.requested" }, { event: "transport-buffer.exceeded" }] }] },
];

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, fileName), "utf8"));
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

class RecordingFakePlatform {
  #calls = [];

  recordCall(call) {
    if (!call || typeof call !== "object" || Array.isArray(call) ||
        typeof call.label !== "string" || call.label.length === 0 ||
        typeof call.requestId !== "string" || call.requestId.length === 0 ||
        !call.details || typeof call.details !== "object" || Array.isArray(call.details)) {
      throw new TypeError("recordCall requires a label, requestId, and object details");
    }
    this.#calls.push(jsonClone({ label: call.label, requestId: call.requestId, details: call.details }));
  }

  snapshot() {
    return jsonClone(this.#calls);
  }
}

function loadFixtureCatalog() {
  const fixturePlan = readJson("fixture-plan.json");
  const assertionMap = readJson("assertion-map.json");
  const seedsById = new Map(SCENARIO_SEEDS.map((seed) => [seed.caseId, seed]));
  const cases = fixturePlan.cases.map((plannedCase) => {
    const seed = seedsById.get(plannedCase.id);
    if (!seed) throw new Error(`No preparation scenario seed for ${plannedCase.id}`);
    return {
      caseId: plannedCase.id,
      setup: plannedCase.setup,
      action: plannedCase.action,
      assertionIds: assertionMap.assertions
        .filter((assertion) => assertion.caseId === plannedCase.id)
        .map((assertion) => assertion.assertionId),
      runs: jsonClone(seed.runs),
    };
  });
  return {
    boundary: jsonClone(PREPARATION_BOUNDARY),
    fixturePlanStatus: fixturePlan.status,
    fixturePlanExecutionStatus: fixturePlan.executionStatus,
    assertionMapExecutionStatus: assertionMap.executionStatus,
    cases,
    assertions: jsonClone(assertionMap.assertions),
  };
}

module.exports = { PREPARATION_BOUNDARY, RecordingFakePlatform, SCENARIO_SEEDS, loadFixtureCatalog };
