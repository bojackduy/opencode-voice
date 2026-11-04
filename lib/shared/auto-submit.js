// Both command and fixed-button toggles use the same effective setting.
export function resolveSttAutoSubmit(opts, kv = null) {
  try {
    const saved = kv?.get("stt.autoSubmit");
    if (saved === true || saved === false) return saved;
  } catch {}
  return opts?.sttAutoSubmit === true;
}

export function toggleSttAutoSubmit(opts, kv) {
  const next = !resolveSttAutoSubmit(opts, kv);
  kv.set("stt.autoSubmit", next);
  return next;
}

// Live reader for delivery paths (Stop/finish): evaluates kv at call time
// so a mid-record toggle wins. Falls back to the option when kv is unset.
export function makeAutoSubmitNow(opts, kv) {
  return () => resolveSttAutoSubmit(opts, kv);
}
