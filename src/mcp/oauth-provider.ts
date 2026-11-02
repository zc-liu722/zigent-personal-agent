import { randomUUID } from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { McpOAuthFileStore } from "./oauth-store.js";
import type { McpOAuthAccount } from "./account.js";

type FileMcpOAuthOptions = {
  label: string;
  softwareId: string;
  defaultServerUrl: string;
  callbackUrl: string;
  onAuthorizationUrl: (url: URL) => void | Promise<void>;
  preserveClientOnAuthorization: boolean;
  writeMode: "atomic" | "direct";
};

// Service adapters own registration and persistence policy; the lifecycle is shared.
export class FileMcpOAuthProvider implements OAuthClientProvider {
  private readonly store: McpOAuthFileStore;

  constructor(account: McpOAuthAccount, private readonly options: FileMcpOAuthOptions) {
    if (!account.agentId || !account.ownerUserId || !account.storagePath) throw new Error("MCP account binding is required");
    this.store = new McpOAuthFileStore(account, options.label, options.writeMode);
  }

  get redirectUrl(): string {
    return this.options.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "Zigent personal agents",
      software_id: this.options.softwareId,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    };
  }

  async state(): Promise<string> {
    const stored = await this.store.read();
    if (stored.state) return stored.state;
    const state = randomUUID();
    await this.store.update((current) => ({ ...current, state }));
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.store.read()).clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.store.update((current) => ({ ...current, clientInformation, clientRedirectUrl: this.redirectUrl }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.read()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.update((current) => ({ ...current, tokens }));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.options.onAuthorizationUrl(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.store.update((current) => ({ ...current, codeVerifier }));
  }

  async codeVerifier(): Promise<string> {
    const value = (await this.store.read()).codeVerifier;
    if (!value) throw new Error(`${this.options.label} OAuth code verifier is missing; start authorization again`);
    return value;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.store.update((current) => ({ ...current, discoveryState }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.store.read()).discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    await this.store.update((current) => {
      if (scope === "all") return current.serverUrl ? { serverUrl: current.serverUrl } : {};
      const next = { ...current };
      if (scope === "client") { delete next.clientInformation; delete next.clientRedirectUrl; }
      if (scope === "tokens") delete next.tokens;
      if (scope === "verifier") {
        delete next.codeVerifier;
        delete next.state;
      }
      if (scope === "discovery") delete next.discoveryState;
      return next;
    });
  }

  async resetTransientState(): Promise<void> {
    await this.store.update((current) => {
      const next = { ...current };
      delete next.codeVerifier;
      delete next.state;
      return next;
    });
  }

  async resetForAuthorization(state?: string): Promise<void> {
    await this.store.update((current) => ({
      ...(current.serverUrl ? { serverUrl: current.serverUrl } : {}),
      // A registration for the old bridge cannot authorize a different callback.
      ...(this.options.preserveClientOnAuthorization && current.clientInformation
        && (current.clientRedirectUrl === this.redirectUrl || ("redirect_uris" in current.clientInformation
          && current.clientInformation.redirect_uris.includes(this.redirectUrl)))
        ? { clientInformation: current.clientInformation, clientRedirectUrl: this.redirectUrl } : {}),
      ...(current.discoveryState ? { discoveryState: current.discoveryState } : {}),
      ...(state ? { state } : {})
    }));
  }

  async selectServer(serverUrl: string): Promise<void> {
    const selected = new URL(serverUrl).toString().replace(/\/$/, "");
    const stored = await this.store.read();
    const storedServer = stored.serverUrl
      ? new URL(stored.serverUrl).toString().replace(/\/$/, "")
      : undefined;
    if (storedServer === selected) return;
    await this.store.update((current) => {
      const previous = current.serverUrl ?? this.options.defaultServerUrl;
      if (new URL(previous).toString().replace(/\/$/, "") === selected) {
        return { ...current, serverUrl: selected };
      }
      return { serverUrl: selected };
    });
  }

  async expectedState(): Promise<string | undefined> {
    return (await this.store.read()).state;
  }
}
