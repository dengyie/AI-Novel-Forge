export interface StartupRecoverySequenceDependencies<TResult> {
  recoverCore: () => Promise<TResult>;
  startDeferredServices: () => void;
  startVolumeRecovery: () => Promise<void>;
  startDirectorWorker: () => void;
  shouldStop?: () => boolean;
}

export interface StartupRecoverySequenceResult<TResult> {
  recoveryResult: TResult;
  backgroundRecovery: Promise<void>;
}

/**
 * Startup ordering boundary for the resource-heavy recovery lanes.
 *
 * Core task recovery first persists/claims the durable work that survived the
 * previous process. Volume execution then runs before director leasing, but
 * outside the HTTP readiness wait. The caller must observe backgroundRecovery
 * failures; shutdown is checked again before starting the deferred worker.
 */
export async function runStartupRecoverySequence<TResult>(
  dependencies: StartupRecoverySequenceDependencies<TResult>,
): Promise<StartupRecoverySequenceResult<TResult>> {
  const result = await dependencies.recoverCore();
  if (dependencies.shouldStop?.()) {
    return { recoveryResult: result, backgroundRecovery: Promise.resolve() };
  }
  dependencies.startDeferredServices();
  const backgroundRecovery = (async () => {
    try {
      await dependencies.startVolumeRecovery();
    } finally {
      // A failed volume scan must remain observable without starving director
      // commands once no volume execution is running.
      if (!dependencies.shouldStop?.()) dependencies.startDirectorWorker();
    }
  })();
  return { recoveryResult: result, backgroundRecovery };
}
