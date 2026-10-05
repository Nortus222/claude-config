const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi;
const SECRET_PARAM = /([?&](?:token|access_token|password|key)=)[^&\s#'"]+/gi;

// Removes credentials a URL may carry, wherever the URL appears in the text.
export function redact(text: string): string {
  return text.replace(USERINFO, '$1').replace(SECRET_PARAM, '$1***');
}
