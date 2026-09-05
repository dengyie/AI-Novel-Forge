export interface StartupRecoverySequenceDependencies<TResult> {
  recoverCore: () => Promise<TResult>;
  startDeferredServices: () => void;
  startVolumeRecovery: () => void;
  startDirectorWorker: () => void;
  shouldStop?: () => boolean;
}

/**
 * Startup ordering boundary for the resource-heavy recovery lanes.
 *
 * Core task recovery first persists/claims the durable work that survived the
 * previous process. Only after that scan settles may volume auto-resume and the
 * director worker start leasing commands. Their long-running work remains
 * asynchronous; this boundary prevents them from racing the core recovery scan.
 */
export async function runStartupRecoverySequence<TResult>(
  dependencies: StartupRecoverySequenceDependencies<TResult>,
): Promise<TResult> {
  const result = await dependencies.recoverCore();
  if (dependencies.shouldStop?.()) {
    return result;
  }
  dependencies.startDeferredServices();
  dependencies.startVolumeRecovery();
  dependencies.startDirectorWorker();
  return result;
}
