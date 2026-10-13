export const HELP = `vcli — architecture-first AI coding

vcli                                  Open the visual workspace
vcli setup                            Connect a provider, model and API key
vcli run <task> [--json]                Run the coding agent
vcli run <task> --plan                 Explore and save a plan without source edits
vcli memory|hooks|tasks|plans show      Inspect local workflow state
vcli checkpoints list|restore <id>     Inspect or rewind a captured file edit
vcli architecture scan|view|check      Inspect structure or declared drift
vcli architecture export --format svg|png|json --output <file>
vcli sessions list|resume <id> [task]   Inspect or resume durable sessions
     sessions resume <id> --build      Explicitly implement a saved planning session
vcli config show|set <key> <value>      Configure provider/model/permissions/budgets
vcli plugins list|install <source>|remove <name>
vcli plugins marketplace add <name> <source>|list|refresh <name>|remove <name>
vcli plugins install <plugin> --marketplace <name>

Options: --root <path> --provider <openai|anthropic|gemini|openrouter|compatible>
         --model <id> --endpoint <url> --permission <yolo|ask|read-only>
         --reasoning <default|none|minimal|low|medium|high|xhigh|max>
         --renderer <auto|kitty|sixel|blocks|off> --project --ref <git-ref> --subdir <path>
API keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY or GOOGLE_API_KEY, OPENROUTER_API_KEY,
          VCLI_COMPATIBLE_API_KEY.
YOLO is the default. Graph exploration and export require no API key.
Workspace: F1 or /help for commands; /open <folder>, /connect, /tokens, /config.
Chat: /chat, /split, /architecture change layout; /history opens conversations;
      /new starts a conversation; /reasoning adjusts model effort.
Launch against your source project: vcli --root <project-folder>.
`;
