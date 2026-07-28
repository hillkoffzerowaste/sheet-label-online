export type FileLike = {
  name: string;
  type: string;
};

export function getInputDriveUrl(value: string | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
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
