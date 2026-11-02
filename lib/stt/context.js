// SttContext: the single shared state object threaded through the extracted
// STT modules (lib/stt/controller.js, lib/stt/commands.js, ...). Built once
// in registerSTT. Fields are mutable references so behavior stays identical
// to the previous giant closure; nothing is copied.
//
// @typedef {object} SttContext
// @property {any} api
// @property {any} kv
// @property {any} complete
// @property {any} prompts
// @property {any} opts
// @property {any} logger
// @property {Function} toast
// @property {any} state - mutable shared flags (recording, processing, ...)
// @property {any} [controller] - filled in after the controller is built

/**
 * Build a SttContext from registerSTT's arguments. The `state` object is the
 * single mutable bag the extracted modules read/write instead of closure vars.
 * @param {any} args
 * @returns {any}
 */
export function createSttContext(args) {
  const a = args || {};
  const ctx = /** @type {any} */ ({
    api: a.api,
    kv: a.kv,
    complete: a.complete,
    prompts: a.prompts,
    opts: a.opts || {},
    logger: a.logger,
    toast: a.toast,
    state: a.state || {},
    controller: null,
  });
  return ctx;
}
