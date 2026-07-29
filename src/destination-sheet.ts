export const DEFAULT_DESTINATION_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1iXza5MJJIo1JaMIPNH8o-ReJU4nEoHHNn5JfT6fv2TU/edit?usp=sharing";

export function getDestinationSheetUrl(value: string | undefined): string | null {
  const candidate = value || DEFAULT_DESTINATION_SHEET_URL;

  try {
    const url = new URL(candidate);
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
