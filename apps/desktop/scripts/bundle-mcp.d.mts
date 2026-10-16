export function bundleMcp(input: { root: string; resources: string }): Promise<{
  protocol: number; executable: string; sdk: string; sha256: string;
}>;
