// All user-facing renderer text lives here (English only for now).

import type { DeviceState, Quality } from '../shared/types';

export const strings = {
  mirror: 'Mirror',
  qualityLabel: 'Quality',
  quality: { low: 'Low', medium: 'Medium', high: 'High' } satisfies Record<Quality, string>,
  state: {
    ready: 'Connected',
    connecting: 'Connecting…',
    unauthorized: 'Allow USB debugging on the device',
    offline: 'Offline — reconnect the cable',
    notTrusted: 'Unlock and tap "Trust This Computer"',
  } satisfies Record<DeviceState, string>,
  platform: { android: 'Android', ios: 'iOS' },
  screenOff: 'Screen off',
  serviceOk: 'Ready',
  serviceDown: 'Unavailable',
};
