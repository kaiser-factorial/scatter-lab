import type { ModelToolCall, ModelTransport, ModelTurn } from './assistant';

// A scripted stand-in for the model, plugged into runAssistantTurn through the
// transport seam. Each replay CASE is a sequence of steps — the turns a model
// would produce — so the whole tool layer (registry, execution, policy fences,
// validator rejections, revise loops) runs deterministically in vitest: no
// network, no key, no remembering every avenue by hand. The standing rule:
// every new tool or validator error code lands with at least one replay case
// in the same PR.
//
// A step can be a literal turn, or a function of what the "model" can see —
// the tool results so far, the offered tool names, the system prompt — which
// is how a case scripts a REVISION: propose a bad plan, read the rejection
// observation, emit the corrected call.

export type ReplayContext = {
  /** The latest tool result fed back, null on the opening call. */
  lastObservation: string | null;
  /** Every tool result so far, oldest first. */
  observations: string[];
  /** Tools offered on this round — the registry under the session policy. */
  toolNames: string[];
  /** This round's system prompt. */
  system: string;
  /** 0-based round index. */
  round: number;
};

export type ReplayStep = ModelTurn | ((ctx: ReplayContext) => ModelTurn);

/** A turn that only speaks. */
export const say = (text: string): ModelTurn => ({ content: text, toolCalls: [] });

/** A turn making one tool call. Arguments are JSON-encoded like the wire. */
export const call = (name: string, args: object = {}, text = ''): ModelTurn => ({
  content: text,
  toolCalls: [{ id: `replay_${name}_${JSON.stringify(args).length}`, name, arguments: JSON.stringify(args) }],
});

export type ReplayTransport = ModelTransport & {
  /** Every round's context, for asserting what the "model" was shown. */
  seen: ReplayContext[];
  /** Flat list of tool calls the script emitted, in order. */
  calls: ModelToolCall[];
};

export const replayTransport = (steps: ReplayStep[]): ReplayTransport => {
  const seen: ReplayContext[] = [];
  const calls: ModelToolCall[] = [];
  let round = 0;

  const transport: ModelTransport = async ({ messages, tools, onText }) => {
    const observations = messages
      .filter(m => m.role === 'tool')
      .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    const system = messages[0]?.role === 'system' && typeof messages[0].content === 'string'
      ? messages[0].content : '';
    const ctx: ReplayContext = {
      lastObservation: observations.length ? observations[observations.length - 1] : null,
      observations,
      toolNames: tools.map(t => (t.type === 'function' ? t.function.name : t.type)),
      system,
      round,
    };
    seen.push(ctx);
    const step = steps[round];
    if (!step) {
      throw new Error(
        `Replay script exhausted: the loop asked for round ${round + 1} but the case scripted ${steps.length}. ` +
        `Last observation: ${ctx.lastObservation ?? '(none)'}`,
      );
    }
    round++;
    const turn = typeof step === 'function' ? step(ctx) : step;
    // Mirror the streaming transport: spoken content reaches the panel's
    // onText handler, so cases can assert what the user would have seen.
    if (turn.content) onText(turn.content);
    calls.push(...turn.toolCalls);
    return turn;
  };

  return Object.assign(transport, { seen, calls });
};
