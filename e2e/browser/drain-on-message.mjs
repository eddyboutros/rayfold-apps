// Preloaded into a service a spec starts itself (`node --import ./drain-on-message.mjs ...`): the message "drain" on
// its IPC channel is SIGTERM, as a deploy sends it. On Windows one process cannot send another a signal it can catch,
// so this is how a spec reaches the service's real drain (stopOnSignal in packages/service-kit) on every platform.
process.on("message", (m) => {
  if (m === "drain") process.emit("SIGTERM", "SIGTERM");
});
