import { chromium } from "playwright";
import type { Page } from "playwright";
import type { BrowserFactory, BrowserLaunchOptions, BrowserSession } from "../ports/browser.js";

export interface PlaywrightContext<Page> {
  close(): Promise<void>;
  newPage(): Promise<Page>;
}

export interface PlaywrightBrowser<Page> {
  close(): Promise<void>;
  newContext(options: {
    viewport: BrowserLaunchOptions["viewport"];
  }): Promise<PlaywrightContext<Page>>;
}

export interface PlaywrightBrowserLauncher<Page> {
  launch(options: { headless: boolean }): Promise<PlaywrightBrowser<Page>>;
}

export function createPlaywrightBrowserFactory(): BrowserFactory<Page>;
export function createPlaywrightBrowserFactory<Page>(
  launcher: PlaywrightBrowserLauncher<Page>
): BrowserFactory<Page>;
export function createPlaywrightBrowserFactory<Page>(
  launcher?: PlaywrightBrowserLauncher<Page>
): BrowserFactory<Page> {
  const resolvedLauncher = launcher ?? chromium;
  return {
    async launch(options): Promise<BrowserSession<Page>> {
      const browser = await resolvedLauncher.launch({ headless: !options.headed });
      const context = await browser.newContext({ viewport: options.viewport });
      const page = (await context.newPage()) as Page;
      return {
        page,
        async close(): Promise<void> {
          await context.close();
          await browser.close();
        }
      };
    }
  };
}
