// Runs once when the server starts. Node only: the weekly backup needs the disk.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBackupSchedule } = await import("./server/backup-schedule");
    startBackupSchedule();
    // Prodigi sandbox callbacks: resume queued reconciliation jobs after a restart. Off unless
    // TICKETSTUB_PRODIGI_CALLBACKS=sandbox, and then nothing is imported or opened.
    if (process.env.TICKETSTUB_PRODIGI_CALLBACKS?.trim().toLowerCase() === "sandbox") {
      const { startProdigiCallbackWorker } = await import("./server/fulfillment/prodigi-host");
      startProdigiCallbackWorker();
    }
  }
}
