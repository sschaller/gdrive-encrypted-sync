import { requestUrl } from "obsidian";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function generateCodeChallenge(
  verifier: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generates a random state string for OAuth 2.0
 * @return random state string
 */
export function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let pendingOAuthResolve: ((code: string) => void) | null = null;
let pendingOAuthReject: ((err: Error) => void) | null = null;
let pendingOAuthState: string | null = null;

export function waitForOAuthCode(expectedState: string): {
  codePromise: Promise<string>;
  cancel: () => void;
} {
  // Cancel any previous pending flow
  if (pendingOAuthReject) {
    pendingOAuthReject(new Error("OAuth flow superseded"));
  }

  let timeoutId: ReturnType<typeof setTimeout>;

  const codePromise = new Promise<string>((resolve, reject) => {
    pendingOAuthResolve = resolve;
    pendingOAuthReject = reject;
    pendingOAuthState = expectedState;

    timeoutId = setTimeout(() => {
      pendingOAuthResolve = null;
      pendingOAuthReject = null;
      pendingOAuthState = null;
      reject(new Error("OAuth timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });

  const cancel = () => {
    clearTimeout(timeoutId);
    pendingOAuthResolve = null;
    pendingOAuthReject = null;
    pendingOAuthState = null;
  };

  return { codePromise, cancel };
}

export function handleOAuthCallback(params: Record<string, string>): void {
  if (!pendingOAuthResolve || !pendingOAuthReject) {
    return;
  }

  if (params.error) {
    const reject = pendingOAuthReject;
    pendingOAuthResolve = null;
    pendingOAuthReject = null;
    pendingOAuthState = null;
    reject(new Error(`OAuth error: ${params.error}`));
    return;
  }

  if (params.state !== pendingOAuthState) {
    const reject = pendingOAuthReject;
    pendingOAuthResolve = null;
    pendingOAuthReject = null;
    pendingOAuthState = null;
    reject(new Error("OAuth state mismatch"));
    return;
  }

  if (params.code) {
    const resolve = pendingOAuthResolve;
    pendingOAuthResolve = null;
    pendingOAuthReject = null;
    pendingOAuthState = null;
    resolve(params.code);
  }
}

export function buildAuthUrl(
  clientId: string,
  codeChallenge: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const response = await requestUrl({
    url: TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    throw: false,
  });

  if (response.status < 200 || response.status >= 400) {
    throw new Error(
      `Token exchange failed: ${response.status} ${JSON.stringify(response.json)}`,
    );
  }
  return response.json;
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await requestUrl({
    url: TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    throw: false,
  });

  if (response.status < 200 || response.status >= 400) {
    throw new Error(
      `Token refresh failed: ${response.status} ${JSON.stringify(response.json)}`,
    );
  }
  return response.json;
}
