import { Schema } from 'effect';

export type ItemKind = 'setting' | 'file' | 'skill' | 'integration';

// Logical identities: settings split at the first '#', skills at the final '/'.
export type ItemRef =
  | { readonly kind: 'setting'; readonly fileId: string; readonly key: string }
  | { readonly kind: 'file'; readonly fileId: string }
  | { readonly kind: 'skill'; readonly source: string; readonly name: string }
  | { readonly kind: 'integration'; readonly id: string };

export const parseItemId = (itemId: string): ItemRef | undefined => {
  if (itemId.startsWith('setting:')) {
    const rest = itemId.slice('setting:'.length);
    const at = rest.indexOf('#');
    return at > 0 && at < rest.length - 1 ? { kind: 'setting', fileId: rest.slice(0, at), key: rest.slice(at + 1) } : undefined;
  }
  if (itemId.startsWith('file:')) {
    const fileId = itemId.slice('file:'.length);
    return fileId === '' ? undefined : { kind: 'file', fileId };
  }
  if (itemId.startsWith('skill:')) {
    const rest = itemId.slice('skill:'.length);
    const at = rest.lastIndexOf('/');
    return at > 0 && at < rest.length - 1 ? { kind: 'skill', source: rest.slice(0, at), name: rest.slice(at + 1) } : undefined;
  }
  if (itemId.startsWith('integration:')) {
    const id = itemId.slice('integration:'.length);
    return id === '' ? undefined : { kind: 'integration', id };
  }
  return undefined;
};

export const ItemIdSchema = Schema.String.check(Schema.makeFilter((id) =>
  /^(setting|skill|integration|file):[A-Za-z0-9._:/#@-]{1,200}$/.test(id) && parseItemId(id) !== undefined));
