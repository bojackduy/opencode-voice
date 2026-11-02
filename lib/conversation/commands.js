// Command definitions for registerConversation (Phase C3). Thin: bodies delegate
// to the loop object returned by createConversationLoop.

/**
 * @param {any} ctx
 * @param {any} loop
 */
export function createCommands(ctx, loop) {
  const api = ctx.api;
  const kb = (value) => (typeof loop.kb === "function" ? loop.kb(value) : undefined);
  return [
    {
      title: "Voice: conversation mode",
      value: "voice.conversation",
      category: "opencode-voice",
      description:
        "Toggle voice conversation (push-to-talk: press to record, press again to send, press while it speaks to interrupt)",
      ...(kb("voice.conversation") ? { keybind: kb("voice.conversation") } : {}),
      slash: { name: "voice-conversation" },
      onSelect() {
        loop.onKey();
      },
    },
    {
      title: "Voice: stop conversation",
      value: "voice.conversation-stop",
      category: "opencode-voice",
      description: "Exit voice conversation mode",
      slash: { name: "voice-conversation-stop" },
      onSelect() {
        if (loop.isActive()) {
          loop.stop("command");
          api.ui.toast({ message: "Conversation off", variant: "info", duration: 3000 });
        }
      },
    },
  ];
}
