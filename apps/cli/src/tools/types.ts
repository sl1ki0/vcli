import type { ArchitectureService, SessionStore } from "@vcli/core";

export interface BuiltinOptions {
  architecture: ArchitectureService;
  store: SessionStore;
  discover?: (query: string) => Promise<void>;
  record?: (values: {
    decisions?: string[];
    constraints?: string[];
    pending?: string[];
  }) => Promise<void>;
  skillList?: () => { name: string; description: string; path: string }[];
  loadSkill?: (name: string) => Promise<string>;
}
