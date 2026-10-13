import { SyntaxStyle } from "@opentui/core";

export function createChatStyle() {
  return SyntaxStyle.fromStyles({
    default: { fg: "#dce4ed" },
    "markup.heading": { fg: "#6ee7c2", bold: true },
    "markup.strong": { fg: "#f1f5f9", bold: true },
    "markup.bold": { fg: "#f1f5f9", bold: true },
    "markup.italic": { fg: "#cbd5e1", italic: true },
    "markup.list": { fg: "#6ee7c2" },
    "markup.raw": { fg: "#fbbf24", bg: "#17212d" },
    "markup.raw.block": { fg: "#dce4ed", bg: "#17212d" },
    "markup.link": { fg: "#38bdf8", underline: true },
    "markup.quote": { fg: "#94a3b8", italic: true },
    conceal: { fg: "#64748b" },
    keyword: { fg: "#c084fc" },
    string: { fg: "#6ee7c2" },
    number: { fg: "#fbbf24" },
    comment: { fg: "#64748b", italic: true },
  });
}

/** Tolerate spaced emphasis in prose; preserve escaped markers and literal code. */
export function normalizeChatMarkdown(content: string): string {
  let fence: string | undefined;
  return content
    .split("\n")
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return line;
      }
      if (fence || /^(?: {4}|\t)/.test(line)) return line;
      const segments = line.split(/(`+[^`]*`+)/g);
      return segments
        .map((part, index) =>
          index % 2 ? part : part.replace(/(?<!\\)\*\*[ \t]+([^*\n]+?)[ \t]+\*\*/g, "**$1**"),
        )
        .join("");
    })
    .join("\n");
}
