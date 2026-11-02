// ConvContext: the single shared state object threaded through the extracted
// conversation modules (lib/conversation/loop.js, lib/conversation/commands.js).
// Built once in registerConversation. Fields are mutable references so behavior
// stays identical to the previous giant closure; nothing is copied.
//
// @typedef {object} ConvContext
// @property {any} api
// @property {any} opts
// @property {any} logger
// @property {any} stt
// @property {any} tts
// @property {Function} isLiveNotesActive
// @property {number} maxTurns
// @property {number} replyTimeoutMs
// @property {number} restartDelayMs
// @property {any} stopPhrases
// @property {any} state - mutable shared flags (active, phase, turn, ...)
// @property {any} [loop] - filled in after the loop is built

/**
 * Build a ConvContext from registerConversation's arguments.
 * @param {any} args
 * @returns {any}
 */
export function createConvContext(args) {
  const a = args || {};
  const ctx = /** @type {any} */ ({
    api: a.api,
    opts: a.opts || {},
    logger: a.logger,
    stt: a.stt,
    tts: a.tts,
    isLiveNotesActive:
      typeof a.isLiveNotesActive === "function" ? a.isLiveNotesActive : () => false,
    maxTurns: Number(a.maxTurns) > 0 ? Number(a.maxTurns) : 50,
    replyTimeoutMs: Number(a.replyTimeoutMs) > 0 ? Number(a.replyTimeoutMs) : 300000,
    restartDelayMs: Number(a.restartDelayMs) >= 0 ? Number(a.restartDelayMs) : 350,
    stopPhrases: a.stopPhrases,
    state: a.state || {},
    loop: null,
  });
  return ctx;
}
