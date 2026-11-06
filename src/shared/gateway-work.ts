import type { AskMode } from "./persona.js";

export interface GatewayJob {
  id: string;
  mode: AskMode;
  input: string | null;
  language: string;
  application_id: string;
  interaction_token: string;
  ephemeral: number;
  guild_id: string | null;
  requester_user_id: string | null;
}

export interface GatewayCommand {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  /** A malformed item must fail individually, not discard a committed batch. */
  payloadError?: string;
}

export interface GatewayWorkBatch {
  jobs: GatewayJob[];
  commands: GatewayCommand[];
}
