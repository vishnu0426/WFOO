/**
 * What a password someone chooses for themselves must satisfy. Used when a temporary password is replaced and whenever a person changes
 * their own password. (A temporary password set by an administrator is not held to this: it only has to be replaced.)
 */
export const MIN_PASSWORD_LENGTH = 8;

// patterns anyone would try first, including the examples that appear in setup instructions
const EASY = ['password', 'passw0rd', 'admin@123', 'admin123', 'welcome', 'qwerty', 'letmein', 'changeme', 'iloveyou', '12345678', '123456789', '1234567890', 'abcdefgh'];

/** The first problem with a proposed password, in plain words, or null when it is acceptable. */
export function checkNewPassword(next: string, o: { current?: string; username?: string } = {}): string | null {
  if (next.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (next.length > 100) return 'Use at most 100 characters.';
  if (o.current !== undefined && next === o.current) return 'Choose a password different from your current one.';
  const lower = next.toLowerCase();
  if (o.username && o.username.length >= 3 && lower.includes(o.username.toLowerCase())) return 'The password cannot contain your username.';
  if (EASY.some((w) => lower.includes(w))) return 'That password is too easy to guess. Avoid common words and number runs.';
  if (new Set(next).size < 5) return 'Use a wider mix of characters.';
  if (!/[a-zA-Z]/.test(next) || !/[^a-zA-Z]/.test(next)) return 'Mix letters with numbers or symbols.';
  return null;
}
