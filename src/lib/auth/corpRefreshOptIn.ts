/** Returns whether explicit Director consent is required for non-Director corporation refreshes. */
export function isCorpRefreshOptInEnabled(): boolean {
  return process.env.CORP_REFRESH_OPT_IN === "true";
}
