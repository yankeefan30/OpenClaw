import { EscalationHandoffStore } from "../handoff.js";

process.once("message", async (message) => {
  try {
    const store = new EscalationHandoffStore({
      baseDirectory: message.directory,
      allowTestDirectory: true,
    });
    const value = await store.submitWithId(message.payload);
    process.send?.({ ok: true, reused: value.reused });
  } catch (error) {
    process.send?.({ ok: false, error: String(error?.code ?? "child_failed") });
  } finally {
    process.disconnect?.();
  }
});

process.send?.({ ready: true });
