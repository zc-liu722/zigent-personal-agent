import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FileMcpOAuthProvider } from "./oauth-provider.js";
import { lockState, releaseLock, removeStaleLock, tryAcquireLock } from "./authorization-lock.js";
import { authorizationFailure, type AuthorizationFailure, type AuthorizationStage } from "../productivity/authorization-failure.js";

const AUTHORIZATION_LOCK_POLL_MS = 1_500;
const AUTHORIZATION_LOCK_GRACE_MS = 90_000;
const CONNECT_TIMEOUT_MS = 60_000;

export type McpAuthorizationConfig = {
  serverUrl: string;
  timeoutMs: number;
  proxyUrl?: string;
};
export type McpAuthorizationPrompt = { authorizationUrl: string; expiresAt: number };
export type McpAuthorizationOutcome = "authorized" | "failed";

export type McpAuthorizationCallback = {
  callbackUrl: string;
  register(requestId: string, state: string, expiresAt: number): Promise<void>;
  waitForCode(requestId: string, expiresAt: number, signal: AbortSignal): Promise<string>;
};
type AuthorizationOptions = {
  label: string;
  clientName: string;
  createProvider(onAuthorizationUrl?: (url: URL) => Promise<void>, callbackUrl?: string): FileMcpOAuthProvider;
  verificationCallbackUrl?: string;
  request?: typeof fetch;
  withConnection?: (action: () => Promise<void>) => Promise<void>;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

/** Service adapters supply transport/connection policies; OAuth orchestration is shared. */
export class McpAuthorizationCoordinator {
  private activeAuthorization: Promise<void> | undefined;
  private stage: AuthorizationStage = "prepare";

  constructor(
    private readonly config: McpAuthorizationConfig,
    private readonly storagePath: string,
    private readonly bridge: McpAuthorizationCallback,
    private readonly options: AuthorizationOptions
  ) {}

  private withConnection(action: () => Promise<void>): Promise<void> {
    return this.options.withConnection ? this.options.withConnection(action) : action();
  }

  private client(): Client {
    return new Client({ name: this.options.clientName, version: "1.0.0" });
  }

  private transport(provider: FileMcpOAuthProvider): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(this.config.serverUrl), {
      authProvider: provider,
      ...(this.options.request ? { fetch: this.options.request } : {})
    });
  }

  private async verifyAuthorized(): Promise<void> {
    const provider = this.options.createProvider(undefined, this.options.verificationCallbackUrl);
    await provider.selectServer(this.config.serverUrl);
    const client = this.client();
    const transport = this.transport(provider);
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** OAuth belongs to the application, not the chat turn that requested it. */
  start(
    sendPrompt: (prompt: McpAuthorizationPrompt) => Promise<void>,
    notify: (outcome: McpAuthorizationOutcome, failure?: AuthorizationFailure) => Promise<void>
  ): void {
    if (!this.activeAuthorization) {
      this.stage = "prepare";
      const operation = this.authorizeShared(sendPrompt);
      const tracked = operation.finally(() => {
        if (this.activeAuthorization === tracked) this.activeAuthorization = undefined;
      });
      this.activeAuthorization = tracked;
      void tracked.then(
        () => notify("authorized"),
        error => {
          const failure = authorizationFailure(this.stage, error);
          console.warn(`${this.options.label} authorization failed`, failure);
          return notify("failed", failure);
        }
      ).catch(() => {
        // Never log OAuth URLs, credentials, or the notification request body.
        console.warn(`Unable to send ${this.options.label} authorization result notice`);
      });
    }
  }

  private async authorizeShared(sendPrompt: (prompt: McpAuthorizationPrompt) => Promise<void>): Promise<void> {
    const lockPath = `${this.storagePath}.authorizing`;
    const staleAfterMs = this.config.timeoutMs + AUTHORIZATION_LOCK_GRACE_MS;
    const deadline = Date.now() + staleAfterMs;

    while (Date.now() < deadline) {
      const lock = await tryAcquireLock(lockPath);
      if (lock) {
        try {
          await this.withConnection(() => this.authorizeAsOwner(sendPrompt));
          return;
        } finally {
          await releaseLock(lock);
        }
      }

      if (await removeStaleLock(lockPath, staleAfterMs)) continue;
      await delay(AUTHORIZATION_LOCK_POLL_MS);
      if (!(await lockState(lockPath))) {
        const provider = this.options.createProvider();
        if (await provider.tokens()) {
          await this.withConnection(() => this.verifyAuthorized());
          return;
        }
      }
    }
    throw new Error(`Another ${this.options.label} authorization is still pending; please try again shortly`);
  }

  private async authorizeAsOwner(sendPrompt: (prompt: McpAuthorizationPrompt) => Promise<void>): Promise<void> {
    const requestId = randomUUID();
    const state = `${requestId}.${randomBytes(32).toString("base64url")}`;
    let expiresAt = 0;
    let promptSent = false;
    const provider = this.options.createProvider(async (authorizationUrl) => {
      // Discovery and client registration must not consume the user's login window.
      expiresAt = Date.now() + this.config.timeoutMs;
      this.stage = "bridge_registration";
      await this.bridge.register(requestId, state, expiresAt);
      await sendPrompt({ authorizationUrl: authorizationUrl.toString(), expiresAt });
      promptSent = true;
      this.stage = "user_authorization";
    }, this.bridge.callbackUrl);
    await provider.selectServer(this.config.serverUrl);
    await provider.resetForAuthorization(state);

    const transport = this.transport(provider);
    const client = this.client();
    try {
      this.stage = "client_registration";
      try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error;
      }
      if (!promptSent) throw new Error(`${this.options.label} did not provide an authorization URL`);
      const signal = AbortSignal.timeout(Math.max(1, expiresAt - Date.now()));
      const code = await this.bridge.waitForCode(requestId, expiresAt, signal);
      this.stage = "token_exchange";
      await transport.finishAuth(code);
    } finally {
      await client.close().catch(() => undefined);
    }
    await provider.resetTransientState();
    this.stage = "verify";
    await this.verifyAuthorized();
  }
}
