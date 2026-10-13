import { For, Show } from "solid-js";
import type { createCommandCompletion } from "./command-completion.ts";

export function CommandSuggestions(props: {
  completion: ReturnType<typeof createCommandCompletion>;
}) {
  const completion = props.completion;
  return (
    <Show when={completion.height()}>
      <box
        id="command-suggestions"
        height={completion.height()}
        flexShrink={0}
        paddingLeft={1}
        flexDirection="column"
        backgroundColor="#182330"
      >
        <text
          height={1}
          wrapMode="none"
          fg="#8e9ba9"
        >{`Commands ${completion.selected() + 1}/${completion.items().length} · ↑/↓ choose · Tab complete · Enter complete/send · Esc hide`}</text>
        <For each={completion.rows()}>
          {(item) => (
            <text
              height={1}
              wrapMode="none"
              fg={item.index === completion.selected() ? "#6ee7c2" : "#b8c4d2"}
              onMouseDown={() => completion.accept(item.index)}
            >{`${item.index === completion.selected() ? "›" : " "} ${item.value.trim()} · ${item.description}`}</text>
          )}
        </For>
      </box>
    </Show>
  );
}
