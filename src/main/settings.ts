// Tiny JSON settings store (per-device quality for now).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Quality } from '../shared/types';

interface SettingsData {
  quality: Record<string, Quality>;
}

export class Settings {
  private data: SettingsData = { quality: {} };

  constructor(private file: string | undefined) {
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SettingsData>;
      this.data.quality = parsed.quality ?? {};
    } catch {
      // first run or unreadable file: start with defaults
    }
  }

  quality(deviceId: string): Quality {
    return this.data.quality[deviceId] ?? 'medium';
  }

  setQuality(deviceId: string, q: Quality) {
    this.data.quality[deviceId] = q;
    this.save();
  }

  private save() {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
