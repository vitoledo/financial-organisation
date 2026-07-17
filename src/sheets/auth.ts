import { google, Auth } from 'googleapis';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const REDIRECT_PORT = 3000;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  tokensPath: string;
  /** No browser available (container/server): never wait on interactive consent. */
  headless?: boolean;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const PROVISION_HINT =
  'Rode `pnpm setup` (ou `docker compose run --rm app sync --setup-only`) em uma máquina ' +
  'com navegador e copie data/google-tokens.json para o servidor.';

/**
 * Get an authenticated OAuth2 client.
 * - If tokens exist on disk, load and refresh them.
 * - If not, start a local HTTP server and open the browser for consent.
 */
export async function getAuthClient(config: GoogleAuthConfig): Promise<Auth.OAuth2Client> {
  const oauth2Client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    REDIRECT_URI,
  );

  // Try loading saved tokens
  if (fs.existsSync(config.tokensPath)) {
    const tokens: Auth.Credentials = JSON.parse(
      fs.readFileSync(config.tokensPath, 'utf8'),
    );
    oauth2Client.setCredentials(tokens);

    // Proactively refresh if token is expired or about to expire
    if (isTokenExpired(tokens)) {
      config.logger?.info('Access token expired, refreshing...');
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(credentials);
        saveTokens(config.tokensPath, credentials, tokens);
        config.logger?.info('Token refreshed successfully.');
      } catch (err) {
        throw new Error(
          `Falha ao renovar o token do Google (refresh_token revogado ou expirado). ` +
          `${PROVISION_HINT} Causa: ${(err as Error).message}`,
        );
      }
    }

    return oauth2Client;
  }

  // No tokens — need interactive consent, which requires a browser.
  if (config.headless) {
    throw new Error(
      `Nenhum token do Google em ${config.tokensPath} e execução sem navegador (headless). ` +
      PROVISION_HINT,
    );
  }

  config.logger?.info('No saved tokens found. Starting OAuth2 consent flow...');
  const tokens = await interactiveConsent(oauth2Client, config);
  oauth2Client.setCredentials(tokens);
  saveTokens(config.tokensPath, tokens);
  config.logger?.info('OAuth2 consent completed and tokens saved.');

  return oauth2Client;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function isTokenExpired(tokens: Auth.Credentials): boolean {
  if (!tokens.expiry_date) return true;
  // Refresh 5 minutes before actual expiry
  return Date.now() > tokens.expiry_date - 5 * 60 * 1000;
}

/**
 * Persist tokens. A refresh response omits refresh_token, so the previous one
 * is carried over — otherwise the next headless run would have nothing to
 * refresh with and would need a browser again.
 */
function saveTokens(
  tokensPath: string,
  tokens: Auth.Credentials,
  previous?: Auth.Credentials,
): void {
  const dir = path.dirname(tokensPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const merged: Auth.Credentials = {
    ...tokens,
    refresh_token: tokens.refresh_token ?? previous?.refresh_token,
  };
  fs.writeFileSync(tokensPath, JSON.stringify(merged, null, 2));
}

/**
 * Opens a temporary local HTTP server, generates the consent URL,
 * and waits for the redirect with the authorization code.
 */
function interactiveConsent(
  oauth2Client: Auth.OAuth2Client,
  config: GoogleAuthConfig,
): Promise<Auth.Credentials> {
  return new Promise((resolve, reject) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });

    const server = http.createServer(async (req, res) => {
      try {
        if (!req.url?.startsWith('/oauth2callback')) {
          res.writeHead(404);
          res.end();
          return;
        }

        const urlObj = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
        const code = urlObj.searchParams.get('code');

        if (!code) {
          res.writeHead(400);
          res.end('Missing authorization code.');
          return;
        }

        const { tokens } = await oauth2Client.getToken(code);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="font-family: system-ui; text-align: center; padding: 60px;">
              <h1>✅ Autorização concedida!</h1>
              <p>Você pode fechar esta aba e voltar ao terminal.</p>
            </body>
          </html>
        `);

        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500);
        res.end('Internal error during OAuth2 callback.');
        server.close();
        reject(err);
      }
    });

    server.listen(REDIRECT_PORT, () => {
      console.log('\n══════════════════════════════════════════════════════════════');
      console.log('  🔐 Autorização do Google necessária!');
      console.log('  Abra o link abaixo no navegador para autorizar:');
      console.log(`\n  ${authUrl}\n`);
      console.log('══════════════════════════════════════════════════════════════\n');

      // Try to open the browser automatically
      import('open').then((mod) => mod.default(authUrl)).catch(() => {
        // If auto-open fails, user can copy the URL manually
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth2 consent timed out (5 minutes). Please try again.'));
    }, 5 * 60 * 1000);
  });
}
