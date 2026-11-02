// TtsContext: the single shared state object threaded through the extracted
// TTS modules (lib/tts/controller.js, lib/tts/commands.js, ...). Built once
// in registerTTS. Fields are mutable references so behavior stays identical
// to the previous giant closure; nothing is copied.
//
// @typedef {object} TtsContext
// @property {any} api
// @property {any} kv
// @property {any} complete
// @property {any} prompts
// @property {any} opts
// @property {any} logger
// @property {Function} toast
// @property {any} deps
// @property {any} state
// @property {any} [controller]

/**
 * Build a TtsContext from registerTTS's arguments.
 * @param {any} args
 * @returns {any}
 */
export function createTtsContext(args) {
  const a = args || {};
  const ctx = /** @type {any} */ ({
    api: a.api,
    kv: a.kv,
    complete: a.complete,
    prompts: a.prompts,
    opts: a.opts || {},
    logger: a.logger,
    toast: a.toast,
    deps: a.deps || {},
    state: a.state || {},
    controller: null,
  });
  return ctx;
}
