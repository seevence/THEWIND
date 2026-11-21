// The policy identity is the last URL pathname segment without its .html suffix. The collector
// already stores rows under this id, so the draft import path imports this module instead of
// defining its own rule; two rules would let one policy in under two ids.

export function policyItemPathSegment(url: string): string | null {
  return new URL(url).pathname.split("/").filter((part) => part.length > 0).at(-1) ?? null;
}

export function policyItemIdFromUrl(url: string): string {
  const last = policyItemPathSegment(url);
  return (last ?? url).replace(/\.html?$/i, "");
}