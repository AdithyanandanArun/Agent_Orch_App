import { BrowserError, withTimeout } from './errors.ts';
import type { Locator, Page } from './playwright.ts';

export interface TargetSpec { selector?: string | undefined; ref?: string | undefined; role?: string | undefined; name?: string | undefined }

const REF = /^[A-Za-z0-9_-]{1,100}$/u;
const ROLE = /^[a-z]{2,40}$/u;

export function hasTarget(spec: TargetSpec): boolean {
  return spec.selector !== undefined || spec.ref !== undefined || spec.role !== undefined || spec.name !== undefined;
}

const staleRef = (ref: string) => new BrowserError(409, `Ref "${ref}" is stale or unknown. Take a fresh snapshot and use a ref from it.`);

/**
 * Resolves exactly one way of addressing an element: a snapshot ref, a selector, or a role with an optional name.
 * Playwright locators are strict, so an ambiguous match fails with guidance instead of acting on the first hit.
 */
export async function resolveLocator(page: Page, spec: TargetSpec): Promise<Locator> {
  const kinds = [spec.ref !== undefined, spec.selector !== undefined, spec.role !== undefined || spec.name !== undefined].filter(Boolean).length;
  if (kinds === 0) throw new BrowserError(400, 'This action needs a target: a ref from a snapshot, a selector, or a role with a name.');
  if (kinds > 1) throw new BrowserError(400, 'Use only one of ref, selector, or role and name to address the element.');
  if (spec.ref !== undefined) {
    if (!REF.test(spec.ref)) throw new BrowserError(400, 'That ref is not valid. Use a ref exactly as shown in the latest snapshot, for example e12.');
    const locator = page.getByRef(spec.ref);
    const count = await withTimeout(locator.count(), 3000, 'Looking up the ref timed out.').catch((error: unknown) => {
      if (error instanceof BrowserError && error.status !== 422) throw error;
      throw staleRef(spec.ref!);
    });
    if (count === 0) throw staleRef(spec.ref);
    return locator;
  }
  if (spec.selector !== undefined) return page.locator(spec.selector);
  if (spec.role === undefined) throw new BrowserError(400, 'A name needs a role, for example role "button" and name "Save".');
  if (!ROLE.test(spec.role)) throw new BrowserError(400, 'That role is not valid. Use an ARIA role such as button, link or textbox.');
  return page.getByRole(spec.role as Parameters<Page['getByRole']>[0], spec.name !== undefined ? { name: spec.name } : undefined);
}
