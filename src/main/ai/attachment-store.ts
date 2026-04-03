/**
 * Typed module-level store for pending attachments and generated content.
 * Replaces unsafe (global as any) usage for cross-function state in AI tools.
 */

export interface PendingAttachment {
  type: 'image' | 'video';
  name: string;
  path: string;
}

let _pendingAttachments: PendingAttachment[] | undefined;
let _generatedPostContent: string | undefined;

export function getPendingAttachments(): PendingAttachment[] | undefined {
  return _pendingAttachments;
}

export function setPendingAttachments(attachments: PendingAttachment[]): void {
  _pendingAttachments = attachments;
}

export function clearPendingAttachments(): void {
  _pendingAttachments = undefined;
}

export function getGeneratedPostContent(): string | undefined {
  return _generatedPostContent;
}

export function setGeneratedPostContent(content: string): void {
  _generatedPostContent = content;
}
