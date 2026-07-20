export interface BrowserLaunchOptions {
  headed: boolean;
  viewport: {
    height: number;
    width: number;
  };
}

export interface BrowserSession<Page> {
  close(): Promise<void>;
  page: Page;
}

export interface BrowserFactory<Page> {
  launch(options: BrowserLaunchOptions): Promise<BrowserSession<Page>>;
}
