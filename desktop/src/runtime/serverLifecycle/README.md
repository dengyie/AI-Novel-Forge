# Desktop server lifecycle

Owns bounded readiness probes, owned process exit waiting and Electron quit gating.
`runtime/server.ts` owns spawning and IPC transport; `main.ts` owns windows and startup promise registration.
The matching server capability is `server/src/app/desktopLifecycle`: private parent IPC enters normal graceful shutdown.
Neither module exposes shutdown over HTTP. Tests run without Electron UI.
