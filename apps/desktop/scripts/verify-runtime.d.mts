export function verifyAppRuntime(app: string, version: string): Promise<{ bunSha256: string; agentVersion: string; mcpSha256: string }>;
