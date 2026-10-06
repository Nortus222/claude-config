// Cuts `text` to at most `max` UTF-16 units without splitting a surrogate pair: the Rust host rejects
// a record that carries a lone surrogate.
export const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
};
