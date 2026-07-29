export const DEFAULT_INPUT_DRIVE_URL =
  "https://drive.google.com/drive/u/0/folders/1w_qEAjYeZFTmENeoFyjGVRX3syTNB2v5";

export type FileLike = {
  name: string;
  type: string;
};

export function getInputDriveUrl(value: string | undefined): string | null {
  const candidate = value || DEFAULT_INPUT_DRIVE_URL;

  try {
    const url = new URL(candidate);
    const isDriveFolder = /\/folders\/[^/]+/.test(url.pathname);

    if (url.protocol !== "https:" || url.hostname !== "drive.google.com" || !isDriveFolder) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

export function isPdfFile(file: FileLike): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;

  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}
