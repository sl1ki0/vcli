export type PermissionMode = "yolo" | "ask" | "read-only";
export type ReasoningEffort =
  | "default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type ToolKind = "read" | "write" | "execute";
export type JsonSchema = Record<string, unknown>;
export interface Usage {
  input: number;
  output: number;
  cached: number;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface Message {
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  providerData?: unknown;
}
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}
export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  maxOutputTokens: number;
}
export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "usage"; usage: Usage }
  | { type: "done"; providerData?: unknown };
export interface ProviderAdapter {
  readonly id: string;
  readonly model: string;
  readonly contextWindow: number;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
export interface Evidence {
  path: string;
  line: number;
  endLine?: number;
}
export interface ArchitectureNode {
  id: string;
  label: string;
  kind: "component" | "package" | "module" | "file" | "external";
  path?: string;
  parent?: string;
  signatures?: string[];
  evidence?: Evidence[];
  status?: "observed" | "planned" | "unresolved" | "inferred";
  change?: "added" | "removed" | "modified";
}
export interface ArchitectureEdge {
  id: string;
  source: string;
  target: string;
  kind: "import" | "type-import" | "reexport" | "contains" | "uses";
  evidence?: Evidence[];
  status?: "observed" | "planned" | "unresolved" | "inferred";
  change?: "added" | "removed" | "modified";
}
export interface ArchitectureGraph {
  revision: string;
  root: string;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  diagnostics: string[];
  cycles: string[][];
  stats: { files: number; parsed: number; cached: number; durationMs: number };
}
export interface ArchitectureDesign {
  version: 1;
  components: {
    id: string;
    label: string;
    paths: string[];
    dependencies?: string[];
    forbiddenDependencies?: string[];
  }[];
  decisions: string[];
}
export interface Drift {
  kind: "forbidden-dependency" | "unmapped-module" | "missing-component";
  message: string;
  evidence?: Evidence[];
}
export interface ArchitectureService {
  scan(root: string): Promise<ArchitectureGraph>;
  readDesign(root: string): Promise<ArchitectureDesign>;
  writeDesign(root: string, design: ArchitectureDesign): Promise<void>;
  intendedGraph(root: string, design: ArchitectureDesign): ArchitectureGraph;
  check(graph: ArchitectureGraph, design: ArchitectureDesign): Drift[];
}
export interface ToolContext {
  root: string;
  signal: AbortSignal;
  sessionId: string;
}
export interface ToolResult {
  text: string;
  fullOutput?: string;
  details?: unknown;
  changedPaths?: string[];
  isError?: boolean;
}
export interface ToolDefinition extends ToolSchema {
  kind: ToolKind;
  eager?: boolean;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
export interface TaskLedger {
  goal: string;
  constraints: string[];
  decisions: string[];
  pending: string[];
  touchedPaths: string[];
  verification: string[];
}
export interface Session {
  id: string;
  root: string;
  provider: string;
  model: string;
  status: "running" | "complete" | "failed" | "aborted" | "budget";
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  /** Human-facing conversation, independent of compacted provider context. */
  chat?: ChatMessage[];
  ledger: TaskLedger;
  usage: Usage;
  /** Reported usage plus conservative reservations for unmeasured requests. */
  budgetSpent?: number;
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  createdAt: string;
  status: "streaming" | "complete" | "failed" | "aborted";
}
export interface RuntimeEvent {
  type:
    | "session"
    | "text"
    | "reasoning"
    | "message-start"
    | "message-end"
    | "tool-start"
    | "tool-end"
    | "architecture"
    | "usage"
    | "compaction"
    | "status"
    | "approval";
  sessionId: string;
  time: string;
  data: Record<string, unknown>;
}
export interface SessionStore {
  create(root: string, provider: ProviderAdapter, goal: string): Promise<Session>;
  get(id: string): Promise<Session | undefined>;
  list(root?: string): Promise<Session[]>;
  save(session: Session): Promise<void>;
  append(event: RuntimeEvent): Promise<void>;
  putArtifact(sessionId: string, content: string): Promise<string>;
  readArtifact(id: string): Promise<string>;
  pendingMutations(sessionId: string): Promise<string[]>;
}
export interface ContextSettings {
  promptTokens: number;
  mapTokens: number;
  schemaTokens: number;
  resultTokens: number;
  outputTokens: number;
  taskTokens?: number;
  maxTurns: number;
}
export interface ContextPlanner {
  build(
    session: Session,
    graph: ArchitectureGraph,
    tools: ToolSchema[],
    settings: ContextSettings,
    window: number,
  ): ModelRequest;
}
export interface NormalizedMcpServer {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}
export interface Skill {
  name: string;
  description: string;
  path: string;
  plugin?: string;
}
export interface Plugin {
  name: string;
  version: string;
  root: string;
  source: string;
  revision?: string;
  ecosystem: "portable" | "claude" | "codex" | "gemini";
  skills: Skill[];
  servers: NormalizedMcpServer[];
  unsupported: string[];
}
export interface ExtensionAdapter {
  load(root: string): Promise<Plugin>;
}
