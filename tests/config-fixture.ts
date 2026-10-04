/**
 * Test helper: rewrite the one `export const TRUSTED_FACTORY …` declaration of app/src/lib/robinhood/config.ts,
 * whatever its committed value (`null` before the deploy, `Object.freeze({ address, codeHash })` after it). Tests used
 * to replace the literal `= null;` line, which silently stopped matching once the deployed factory was committed
 * (adversary pass on c959260); this throws instead of returning the source unchanged.
 */
const DECLARATION = /^export const TRUSTED_FACTORY: TrustedFactory \| null = (?:null|Object\.freeze\(\{[^}]*\}\));$/gm;

export function replaceTrustedFactory(src: string, replacement: string): string {
  const found = src.match(DECLARATION) ?? [];
  if (found.length !== 1) throw new Error(`config.ts: expected one TRUSTED_FACTORY declaration, found ${found.length}`);
  return src.replace(DECLARATION, () => replacement);
}
