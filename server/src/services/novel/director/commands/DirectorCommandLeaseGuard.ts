export class DirectorCommandLeaseLostError extends Error {
  readonly code = "DIRECTOR_COMMAND_LEASE_LOST";

  constructor(
    readonly commandId?: string,
    readonly leaseOwner?: string,
  ) {
    super(commandId
      ? `Director command lease was lost before execution completed: ${commandId}`
      : "Director command lease was lost before execution completed.");
    this.name = "DirectorCommandLeaseLostError";
  }
}

export interface DirectorCommandExecutionContext {
  signal?: AbortSignal;
  leaseOwner?: string;
  leaseAttempt?: number;
  leaseMs?: number;
}

export function throwIfDirectorCommandLeaseLost(
  signal?: AbortSignal,
  input: { commandId?: string; leaseOwner?: string } = {},
): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof DirectorCommandLeaseLostError) {
    throw signal.reason;
  }
  throw new DirectorCommandLeaseLostError(input.commandId, input.leaseOwner);
}

export function isDirectorCommandLeaseLost(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  return signal?.aborted === true || error instanceof DirectorCommandLeaseLostError;
}
