export interface PreviewResult {
  templateName: string;
  blob: Blob;
}

export function currentPreviewBlob(result: PreviewResult | null, selectedTemplate: string | null): Blob | null {
  return result && result.templateName === selectedTemplate ? result.blob : null;
}
