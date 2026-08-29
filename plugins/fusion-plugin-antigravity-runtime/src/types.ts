/**
 * Antigravity Runtime Plugin - Type Definitions
 *
 * Local AgentRuntime contract mirrors the engine shape without importing @fusion/engine.
 */

export interface AntigravityBinaryStatus {
  available: boolean;
  authenticated: boolean;
  binaryName?: string;
  binaryPath?: string;
  configuredBinaryPath?: string;
  usingConfiguredBinaryPath?: boolean;
  version?: string;
  diagnostics?: string[];
  reason?: string;
  probeDurationMs: number;
}

export interface AntigravityCallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
}

export interface AntigravityRuntimeContext {
  sessionPurpose?: string;
  toolMode?: "coding" | "readonly";
  customToolNames?: string[];
  requestedSkillNames?: string[];
}

export interface AntigravityStreamSession {
  model: unknown;
  systemPrompt: string;
  messages: unknown[];
  state: {
    messages: unknown[];
    errorMessage?: string;
  };
  apiKey?: string | undefined;
  thinkingLevel?: string | undefined;
  sessionId?: string;
  /** False until the first successful print-mode turn completes. */
  started: boolean;
  lastModelDescription: string;
  callbacks: AntigravityCallbacks;
  usage?: unknown;
  runtimeContext?: AntigravityRuntimeContext;
  fusedSystemPrompt: string;
  cwd: string;
  sessionAbortControllers?: Set<AbortController>;
  dispose(): void;
}

export type AgentSession = AntigravityStreamSession;

export interface AgentRuntimeOptions {
  cwd?: string;
  systemPrompt: string;
  tools?: "coding" | "readonly";
  customTools?: unknown;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
  defaultProvider?: string;
  defaultModelId?: string;
  fallbackProvider?: string;
  fallbackModelId?: string;
  defaultThinkingLevel?: string;
  sessionManager?: unknown;
  skillSelection?: unknown;
  skills?: string[];
  runtimeContext?: AntigravityRuntimeContext;
}

export interface AgentSessionResult {
  session: AgentSession;
  sessionFile?: string;
}

export interface AgentRuntime {
  id: string;
  name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void>;
  describeModel(session: AgentSession): string;
  dispose?(session: AgentSession): Promise<void>;
}
