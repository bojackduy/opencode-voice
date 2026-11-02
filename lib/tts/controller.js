// Extracted controller methods for registerTTS (Phase C2). Each factory takes
// one TtsContext and returns the methods it owns; implementations live in
// registerTTS and are threaded through ctx so behavior is unchanged.

/**
 * @param {any} ctx
 */
export function createControllerMethods(ctx) {
  return {
    speak: (text) => (typeof ctx.speak === "function" ? ctx.speak(text) : undefined),
    speakAssistantTurn: (sessionID, message, suffix) =>
      typeof ctx.speakAssistantTurn === "function"
        ? ctx.speakAssistantTurn(sessionID, message, suffix)
        : undefined,
    stop: () => (typeof ctx.stopSpeech === "function" ? ctx.stopSpeech() : false),
    isSpeaking: () => (typeof ctx.isSpeaking === "function" ? ctx.isSpeaking() : false),
    pause: () => (typeof ctx.pause === "function" ? ctx.pause() : false),
    resume: () => (typeof ctx.resume === "function" ? ctx.resume() : false),
    replay: () => (typeof ctx.replay === "function" ? ctx.replay() : false),
    forward: (sec) => (typeof ctx.forward === "function" ? ctx.forward(sec) : undefined),
    rewind: (sec) => (typeof ctx.rewind === "function" ? ctx.rewind(sec) : undefined),
    setRate: (rate) => (typeof ctx.setRate === "function" ? ctx.setRate(rate) : rate),
    getState: () => (typeof ctx.getState === "function" ? ctx.getState() : {}),
    setConversationActive: (v) => {
      if (typeof ctx.setConversationActive === "function") ctx.setConversationActive(v);
    },
    getPhase: () => (typeof ctx.getPhase === "function" ? ctx.getPhase() : "idle"),
  };
}
