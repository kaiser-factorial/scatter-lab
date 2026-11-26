import { runAssistantTurn, type AppBridge } from "../../src/lib/assistant";
import { call, replayTransport, say } from "../../src/lib/replay";
declare global {
  interface Window {
    __scatterlabBridge: { current: AppBridge };
    efaReplayAction: (
      action: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
  }
}
window.efaReplayAction = async (action, args) => {
  let observation = "";
  const transport = replayTransport([
    call(action, args),
    (ctx) => {
      observation = ctx.lastObservation ?? "";
      if (!ctx.toolNames.includes(action))
        throw new Error(`Tool not registered: ${action}`);
      return say("Offline replay complete.");
    },
  ]);
  await runAssistantTurn(
    "",
    "",
    "offline-replay",
    [],
    "Review this synthetic EFA",
    window.__scatterlabBridge,
    { onText() {}, onToolUse() {} },
    transport,
  );
  try {
    return JSON.parse(observation);
  } catch {
    return observation;
  }
};
