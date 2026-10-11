// Host-owned Solid/OpenTUI modules are loaded only when a v2 recording starts.
// No composer mutation: this bounded display is an additive, documented slot.
export function createV2Preview(
  ctx,
  load = async () => {
    const [solid, tui] = await Promise.all([import("solid-js"), import("@opentui/solid")]);
    return { ...solid, ...tui };
  },
) {
  let generation = 0;
  let active = false;
  let partial = { stableText: "", tentativeText: "" };
  const nodes = new Set();
  let setContent = null;
  function display() {
    const stable = partial.stableText || "";
    const tentative = partial.tentativeText || "";
    return `Voice live · ${stable ? `${stable} ` : ""}${tentative ? `[${tentative}]` : stable ? "" : "Listening…"}`.slice(
      -1600,
    );
  }
  let unclaims = [];
  function clear() {
    generation += 1;
    active = false;
    partial = { stableText: "", tentativeText: "" };
    nodes.clear();
    setContent = null;
    for (const unclaim of unclaims.splice(0)) unclaim();
  }
  return {
    async begin() {
      clear();
      active = true;
      const mine = generation;
      const { createElement, setProp, insertNode, onCleanup } = await load();
      if (!active || mine !== generation) return false;
      setContent = (node, value) => setProp(node, "content", value);
      const render = () => {
        if (!active || mine !== generation) return null;
        const box = createElement("box");
        setProp(box, "height", 3);
        setProp(box, "flexShrink", 0);
        const node = createElement("text");
        setProp(node, "maxHeight", 5);
        setProp(node, "minHeight", 1);
        setProp(node, "width", "100%");
        setProp(node, "fg", ctx.theme?.text || "#eeeeee");
        setProp(node, "content", display());
        nodes.add(node);
        insertNode(box, node);
        onCleanup?.(() => nodes.delete(node));
        return box;
      };
      unclaims = [ctx.ui.slot({ before: "prompt.footer", render })];
      return true;
    },
    applyPartial(p) {
      if (!active) return;
      partial = { stableText: p?.stableText || "", tentativeText: p?.tentativeText || "" };
      for (const node of nodes) {
        if (node.isDestroyed) nodes.delete(node);
        else setContent?.(node, display());
      }
    },
    getTranscript: () => [partial.stableText, partial.tentativeText].filter(Boolean).join(" "),
    finalize(text) {
      clear();
      return { text, inserted: false };
    },
    cancel: clear,
    clear,
  };
}
