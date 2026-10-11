export const DEFAULT_HOSTED_URL = 'https://claude-config-prod-service.livelypebble-1d07564b.westus2.azurecontainerapps.io/v1';

// Desktop alone has a public service default; explicit local-only mode creates no hosted client.
export const desktopHostedUrl = (env: Readonly<Record<string, string | undefined>>): string | undefined => {
  if (env.NORTUSCC_DESKTOP_LOCAL_ONLY !== undefined && env.NORTUSCC_DESKTOP_LOCAL_ONLY !== '1') {
    throw new Error('NORTUSCC_DESKTOP_LOCAL_ONLY must be 1 when set');
  }
  if (env.NORTUSCC_DESKTOP_LOCAL_ONLY === '1') return undefined;
  return env.NORTUSCC_HOSTED_URL ?? DEFAULT_HOSTED_URL;
};
