import { requestUrl } from "obsidian";
import * as http from "http";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const LOOPBACK_HOST = "127.0.0.1";

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

/**
 * Starts a temporary local HTTP server to receive the OAuth callback,
 * then opens the browser to the Google auth URL.
 * @returns promise that resolves with the authorization code.
 */
export function startLoopbackServer(expectedState: string): Promise<{
  port: number;
  codePromise: Promise<string>;
  server: http.Server;
}> {
  return new Promise((resolveSetup) => {
    const server = http.createServer();

    const codePromise = new Promise<string>((resolveCode, rejectCode) => {
      const timeout = setTimeout(() => {
        server.close();
        rejectCode(new Error("OAuth timed out after 5 minutes"));
      }, 5 * 60 * 1000);

      server.on("request", (req, res) => {
        const url = new URL(req.url || "/", `http://${LOOPBACK_HOST}`);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const state = url.searchParams.get("state");

        res.setHeader("Content-Type", "text/html");

        if (error) {
          res.writeHead(400);
          res.end(
            "<html><body><h2>Authorization failed</h2><p>You can close this tab.</p></body></html>",
          );
          clearTimeout(timeout);
          server.close();
          rejectCode(new Error(`OAuth error: ${error}`));
          return;
        }

        if (code) {
          if (state !== expectedState) {
            res.writeHead(400);
            res.end(
              "<html><body><h2>Authorization failed</h2><p>State mismatch. You can close this tab.</p></body></html>",
            );
            clearTimeout(timeout);
            server.close();
            rejectCode(new Error("OAuth state mismatch"));
            return;
          }
          res.writeHead(200);
          res.end(
            "<html><body><h2>Authorization successful</h2><p>You can close this tab and return to Obsidian.</p></body></html>",
          );
          clearTimeout(timeout);
          server.close();
          resolveCode(code);
          return;
        }

        res.writeHead(400);
        res.end(
          "<html><body><h2>Missing authorization code</h2></body></html>",
        );
      });
    });

    // Use a fixed port so the redirect URI can be registered in Google Console
    server.listen(42813, LOOPBACK_HOST, () => {
      const addr = server.address();
      const port =
        typeof addr === "object" && addr !== null ? addr.port : 0;
      resolveSetup({ port, codePromise, server });
    });
  });
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
