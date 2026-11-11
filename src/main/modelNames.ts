// Marketing names for device model codes (iPhone14,5 → iPhone 13,
// SM-G990E → Samsung Galaxy S21 FE 5G). Unknown models fall back to the code.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

// ---- Android -------------------------------------------------------------

/** System properties some vendors use for the retail name. */
export const ANDROID_MARKET_NAME_PROPS = [
  'ro.product.marketname',
  'ro.product.vendor.marketname',
  'ro.product.odm.marketname',
  'ro.vendor.oplus.market.name',
  'ro.config.marketing_name',
  'ro.vendor.product.display',
];

let androidTable: Map<string, string> | undefined;

/**
 * Loads resources/android-models.tsv.gz (built from Google Play's public list
 * of certified devices by scripts/build-model-names.mjs). Lazy: ~200 KB on disk.
 */
export function loadAndroidModels(file: string) {
  try {
    const tsv = gunzipSync(readFileSync(file)).toString('utf8');
    androidTable = new Map(tsv.split('\n').map((l) => l.split('\t') as [string, string]));
  } catch {
    androidTable = new Map();
  }
}

/** Device's own property first, then the table, else undefined. */
export function androidMarketingName(model: string, propName?: string): string | undefined {
  if (propName && propName.trim() && propName.trim().toUpperCase() !== model.toUpperCase()) return propName.trim();
  return androidTable?.get(model.toUpperCase());
}

// ---- iOS -----------------------------------------------------------------
// Apple does not expose marketing names over USB, so this table maps product
// types. New models show their code until the table is updated.

const IOS: Record<string, string> = {
  // iPhone
  'iPhone7,2': 'iPhone 6', 'iPhone7,1': 'iPhone 6 Plus',
  'iPhone8,1': 'iPhone 6s', 'iPhone8,2': 'iPhone 6s Plus', 'iPhone8,4': 'iPhone SE (1st generation)',
  'iPhone9,1': 'iPhone 7', 'iPhone9,3': 'iPhone 7', 'iPhone9,2': 'iPhone 7 Plus', 'iPhone9,4': 'iPhone 7 Plus',
  'iPhone10,1': 'iPhone 8', 'iPhone10,4': 'iPhone 8', 'iPhone10,2': 'iPhone 8 Plus', 'iPhone10,5': 'iPhone 8 Plus',
  'iPhone10,3': 'iPhone X', 'iPhone10,6': 'iPhone X',
  'iPhone11,2': 'iPhone XS', 'iPhone11,4': 'iPhone XS Max', 'iPhone11,6': 'iPhone XS Max', 'iPhone11,8': 'iPhone XR',
  'iPhone12,1': 'iPhone 11', 'iPhone12,3': 'iPhone 11 Pro', 'iPhone12,5': 'iPhone 11 Pro Max', 'iPhone12,8': 'iPhone SE (2nd generation)',
  'iPhone13,1': 'iPhone 12 mini', 'iPhone13,2': 'iPhone 12', 'iPhone13,3': 'iPhone 12 Pro', 'iPhone13,4': 'iPhone 12 Pro Max',
  'iPhone14,4': 'iPhone 13 mini', 'iPhone14,5': 'iPhone 13', 'iPhone14,2': 'iPhone 13 Pro', 'iPhone14,3': 'iPhone 13 Pro Max',
  'iPhone14,6': 'iPhone SE (3rd generation)',
  'iPhone14,7': 'iPhone 14', 'iPhone14,8': 'iPhone 14 Plus', 'iPhone15,2': 'iPhone 14 Pro', 'iPhone15,3': 'iPhone 14 Pro Max',
  'iPhone15,4': 'iPhone 15', 'iPhone15,5': 'iPhone 15 Plus', 'iPhone16,1': 'iPhone 15 Pro', 'iPhone16,2': 'iPhone 15 Pro Max',
  'iPhone17,3': 'iPhone 16', 'iPhone17,4': 'iPhone 16 Plus', 'iPhone17,1': 'iPhone 16 Pro', 'iPhone17,2': 'iPhone 16 Pro Max',
  'iPhone17,5': 'iPhone 16e',
  'iPhone18,3': 'iPhone 17', 'iPhone18,4': 'iPhone Air', 'iPhone18,1': 'iPhone 17 Pro', 'iPhone18,2': 'iPhone 17 Pro Max',
  // iPad
  'iPad7,5': 'iPad (6th generation)', 'iPad7,6': 'iPad (6th generation)',
  'iPad7,11': 'iPad (7th generation)', 'iPad7,12': 'iPad (7th generation)',
  'iPad11,6': 'iPad (8th generation)', 'iPad11,7': 'iPad (8th generation)',
  'iPad12,1': 'iPad (9th generation)', 'iPad12,2': 'iPad (9th generation)',
  'iPad13,18': 'iPad (10th generation)', 'iPad13,19': 'iPad (10th generation)',
  'iPad15,7': 'iPad (A16)', 'iPad15,8': 'iPad (A16)',
  'iPad11,3': 'iPad Air (3rd generation)', 'iPad11,4': 'iPad Air (3rd generation)',
  'iPad13,1': 'iPad Air (4th generation)', 'iPad13,2': 'iPad Air (4th generation)',
  'iPad13,16': 'iPad Air (5th generation)', 'iPad13,17': 'iPad Air (5th generation)',
  'iPad14,8': 'iPad Air 11-inch (M2)', 'iPad14,9': 'iPad Air 11-inch (M2)',
  'iPad14,10': 'iPad Air 13-inch (M2)', 'iPad14,11': 'iPad Air 13-inch (M2)',
  'iPad15,3': 'iPad Air 11-inch (M3)', 'iPad15,4': 'iPad Air 11-inch (M3)',
  'iPad15,5': 'iPad Air 13-inch (M3)', 'iPad15,6': 'iPad Air 13-inch (M3)',
  'iPad11,1': 'iPad mini (5th generation)', 'iPad11,2': 'iPad mini (5th generation)',
  'iPad14,1': 'iPad mini (6th generation)', 'iPad14,2': 'iPad mini (6th generation)',
  'iPad16,1': 'iPad mini (A17 Pro)', 'iPad16,2': 'iPad mini (A17 Pro)',
  'iPad8,1': 'iPad Pro 11-inch', 'iPad8,2': 'iPad Pro 11-inch', 'iPad8,3': 'iPad Pro 11-inch', 'iPad8,4': 'iPad Pro 11-inch',
  'iPad8,5': 'iPad Pro 12.9-inch (3rd generation)', 'iPad8,6': 'iPad Pro 12.9-inch (3rd generation)',
  'iPad8,7': 'iPad Pro 12.9-inch (3rd generation)', 'iPad8,8': 'iPad Pro 12.9-inch (3rd generation)',
  'iPad8,9': 'iPad Pro 11-inch (2nd generation)', 'iPad8,10': 'iPad Pro 11-inch (2nd generation)',
  'iPad8,11': 'iPad Pro 12.9-inch (4th generation)', 'iPad8,12': 'iPad Pro 12.9-inch (4th generation)',
  'iPad13,4': 'iPad Pro 11-inch (3rd generation)', 'iPad13,5': 'iPad Pro 11-inch (3rd generation)',
  'iPad13,6': 'iPad Pro 11-inch (3rd generation)', 'iPad13,7': 'iPad Pro 11-inch (3rd generation)',
  'iPad13,8': 'iPad Pro 12.9-inch (5th generation)', 'iPad13,9': 'iPad Pro 12.9-inch (5th generation)',
  'iPad13,10': 'iPad Pro 12.9-inch (5th generation)', 'iPad13,11': 'iPad Pro 12.9-inch (5th generation)',
  'iPad14,3': 'iPad Pro 11-inch (4th generation)', 'iPad14,4': 'iPad Pro 11-inch (4th generation)',
  'iPad14,5': 'iPad Pro 12.9-inch (6th generation)', 'iPad14,6': 'iPad Pro 12.9-inch (6th generation)',
  'iPad16,3': 'iPad Pro 11-inch (M4)', 'iPad16,4': 'iPad Pro 11-inch (M4)',
  'iPad16,5': 'iPad Pro 13-inch (M4)', 'iPad16,6': 'iPad Pro 13-inch (M4)',
  // iPod
  'iPod9,1': 'iPod touch (7th generation)',
};

export function iosMarketingName(productType: string): string | undefined {
  return IOS[productType];
}
