export interface Config {
  databaseUrl: string;
  apiKey: string;
  port: number;
}

function readRequired(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  }
  return value;
}

function readPort(): number {
  const raw = process.env.PORT?.trim();
  if (!raw) return 3000;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got "${raw}".`);
  }
  return port;
}

export function loadConfig(): Config {
  return {
    databaseUrl: readRequired('DATABASE_URL'),
    apiKey: readRequired('API_KEY'),
    port: readPort(),
  };
}
