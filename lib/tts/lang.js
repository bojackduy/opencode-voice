// Sentence/language helpers relocated from lib/tts.js (pure move).
//
// Leaf module: depends only on node builtins. No closure state.

const VI_REGEX = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/;

const VI_LANG_WORD_THRESHOLD = 0.15;

export function splitSpokenSentences(text) {
  const flat = (text || "").replace(/\s+/g, " ");
  const parts = flat.split(/(?<=[.!?…])\s+(?=[\p{Lu}"“'‘(\[])/u);
  if (parts.length === 0) return { sentences: [], rest: "" };
  const lastComplete = /[.!?…]\s*$/.test(flat);
  if (lastComplete) return { sentences: parts.filter(Boolean), rest: "" };
  const rest = parts.pop() || "";
  return { sentences: parts.filter(Boolean), rest };
}

export function isSpeakableSentence(sentence) {
  const s = (sentence || "").trim();
  if (!s || s.length > 400 || s.includes("`")) return false;
  return true;
}

export const MAX_GROUP_CHARS = 240;

export function chunkLongGroups(groups, maxChars = MAX_GROUP_CHARS) {
  const out = [];
  for (const group of groups || []) {
    const text = (group?.text || "").trim();
    if (!text) continue;
    if (text.length <= maxChars) {
      out.push({ lang: group.lang, text });
      continue;
    }
    const { sentences, rest } = splitSpokenSentences(text);
    const parts = [...sentences];
    if (rest && rest.trim()) parts.push(rest.trim());
    let current = "";
    const flush = () => {
      if (current.trim()) out.push({ lang: group.lang, text: current.trim() });
      current = "";
    };
    for (const part of parts.length ? parts : [text]) {
      let piece = part;
      while (piece.length > maxChars * 2) {
        out.push({ lang: group.lang, text: piece.slice(0, maxChars).trim() });
        piece = piece.slice(maxChars).trim();
      }
      if ((current + " " + piece).trim().length > maxChars && current.trim()) flush();
      current = current ? `${current} ${piece}` : piece;
    }
    flush();
    if (!out.length || out[out.length - 1]?.lang !== group.lang)
      out.push({ lang: group.lang, text });
  }
  return out;
}

export function groupSentencesByLang(text) {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const { sentences, rest } = splitSpokenSentences(flat);
  const parts = [...sentences];
  if (rest.trim()) parts.push(rest.trim());
  const groups = [];
  for (const part of parts) {
    const lang = detectLang(part);
    const last = groups[groups.length - 1];
    if (last && last.lang === lang) last.text = `${last.text} ${part}`;
    else groups.push({ lang, text: part });
  }
  return groups;
}

export function detectLang(text) {
  if (!text) return "en";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "en";
  const viWords = words.filter((w) => VI_REGEX.test(w)).length;
  return viWords / words.length >= VI_LANG_WORD_THRESHOLD ? "vi" : "en";
}
