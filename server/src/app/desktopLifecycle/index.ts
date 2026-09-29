/** Private parent IPC only; never mounted on an HTTP route. */
export function registerDesktopParentShutdown(options: {
  runtime?: string;
  nodeProcess: {
    connected?: boolean;
    on(event: "message", listener: (message: unknown) => void): unknown;
    parentPort?: { on(event: "message", listener: (event: { data: unknown }) => void): unknown };
  };
  shutdown: () => void;
}): void {
  if (options.runtime !== "desktop") return;
  const receive = (message: unknown) => {
    if (typeof message === "object" && message !== null
      && "type" in message && message.type === "ai-novel:shutdown") options.shutdown();
  };
  if (options.nodeProcess.parentPort) {
    options.nodeProcess.parentPort.on("message", (event) => receive(event.data));
  } else if (options.nodeProcess.connected) {
    options.nodeProcess.on("message", receive);
  }
}
