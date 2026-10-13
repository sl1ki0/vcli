/** Reconstructs cursor-positioned PTY frames for visible-label readiness checks. */
export function createTerminalScreen(columns: number, rows: number) {
  let cells = Array.from({ length: rows }, () => Array<string>(columns).fill(" "));
  let row = 0;
  let column = 0;
  let pending = "";
  function update(text: string) {
    pending += text;
    let offset = 0;
    while (offset < pending.length) {
      if (pending[offset] === "\u001b") {
        const next = pending[offset + 1];
        if (!next) break;
        if (next === "[") {
          const end = pending.slice(offset + 2).search(/[@-~]/);
          if (end < 0) break;
          const body = pending.slice(offset + 2, offset + 2 + end);
          const action = pending[offset + 2 + end];
          const values = body.replace(/^\?/, "").split(";").map(Number);
          const amount = values[0] || 1;
          if (action === "H" || action === "f") {
            row = Math.min(rows - 1, Math.max(0, (values[0] || 1) - 1));
            column = Math.min(columns - 1, Math.max(0, (values[1] || 1) - 1));
          } else if (action === "G") column = Math.min(columns - 1, amount - 1);
          else if (action === "d") row = Math.min(rows - 1, amount - 1);
          else if (action === "A") row = Math.max(0, row - amount);
          else if (action === "B") row = Math.min(rows - 1, row + amount);
          else if (action === "C") column = Math.min(columns - 1, column + amount);
          else if (action === "D") column = Math.max(0, column - amount);
          else if ((action === "J" && values[0] === 2) || (action === "h" && body === "?1049")) {
            cells = Array.from({ length: rows }, () => Array<string>(columns).fill(" "));
            row = column = 0;
          } else if (action === "K") {
            const from = values[0] === 1 || values[0] === 2 ? 0 : column;
            const to = values[0] === 1 ? column + 1 : columns;
            cells[row]!.fill(" ", from, to);
          }
          offset += end + 3;
          continue;
        }
        if (["]", "P", "_", "^"].includes(next)) {
          const remainder = pending.slice(offset + 2);
          const end = remainder.search(/\u0007|\u001b\\/);
          if (end < 0) break;
          offset += end + 2 + (remainder[end] === "\u0007" ? 1 : 2);
          continue;
        }
        offset += 2;
        continue;
      }
      const point = pending.codePointAt(offset)!;
      const character = String.fromCodePoint(point);
      offset += character.length;
      if (character === "\r") column = 0;
      else if (character === "\n") row = Math.min(rows - 1, row + 1);
      else if (point >= 32 && point !== 127) {
        if (column >= columns) {
          column = 0;
          row = Math.min(rows - 1, row + 1);
        }
        cells[row]![column++] = character;
      }
    }
    pending = pending.slice(offset);
  }
  return { update, text: () => cells.map((line) => line.join("").trimEnd()).join("\n") };
}
