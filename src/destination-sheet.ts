export function getDestinationSheetUrl(value: string | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    const hasDocumentId = /^\/spreadsheets\/d\/[^/]+/.test(url.pathname);

    if (
      url.protocol !== "https:" ||
      url.hostname !== "docs.google.com" ||
      !hasDocumentId
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}
