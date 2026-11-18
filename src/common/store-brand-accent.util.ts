const HEX = /^#?([0-9a-f]{6})$/i;
const norm = (v: unknown): string | null => {
  const m = typeof v === 'string' ? HEX.exec(v.trim()) : null;
  return m ? `#${m[1].toLowerCase()}` : null;
};

/** The store's brand colour for things customers see (emails, invoice PDF, pay page):
 *  the colour the seller picked for customer notifications, else the main colour of the store's live theme, else null
 *  (callers then use their own default). A failed lookup never blocks anything: it just means "no colour". */
export async function resolveStoreAccent(repos: { storeThemeModel?: any }, storeId: string, picked?: string | null): Promise<string | null> {
  const own = norm(picked);
  if (own) return own;
  try {
    const row: any = await repos.storeThemeModel?.findOne({ storeId, status: 'active' }).select('theme.primaryColor').lean();
    return norm(row?.theme?.primaryColor);
  } catch {
    return null;
  }
}
