/** Report success only after the browser has written to the system clipboard. */
export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this window.');
  await navigator.clipboard.writeText(text);
}
