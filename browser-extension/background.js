const observationKey = (tabId) => `observation:${tabId}`;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url?.startsWith("http")) {
    return;
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?tabId=${tab.id}`) });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["collector.js"] });
  } catch (error) {
    await chrome.storage.session.set({
      [observationKey(tab.id)]: {
        error: `Dublo could not inspect this page: ${error instanceof Error ? error.message : String(error)}`
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "dublo-observation" || !sender.tab?.id) {
    return;
  }

  void chrome.storage.session.set({ [observationKey(sender.tab.id)]: message.payload });
});