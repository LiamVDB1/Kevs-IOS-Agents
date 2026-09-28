import type { DeviceIdentity } from '@git-agni/phone-farm-core';

export interface PostManifest {
    device: DeviceIdentity;
    files: Array<{ path: string; name: string; mimeType: string }>;
    musicUrl?: string;
    caption?: string;
    /** Photo posts only: TikTok's separate title field above the description. */
    title?: string;
    account?: string;
    destination: 'draft' | 'publish';
    mode?: 'auto' | 'photo';
}
