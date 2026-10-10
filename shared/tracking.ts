import type { PackageTracking } from './types';

// Carrier pages only. Opening one never updates receipt counts or bin state.
export function trackingLink(tracking: PackageTracking): string {
  if (tracking.url) return /^https?:\/\//i.test(tracking.url) ? tracking.url : '';
  const number = encodeURIComponent(tracking.number.replace(/\s/g, ''));
  switch (tracking.carrier) {
    case 'UPS': return `https://www.ups.com/track?loc=en_US&tracknum=${number}`;
    case 'FedEx': return `https://www.fedex.com/fedextrack/?trknbr=${number}`;
    case 'USPS': return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${number}`;
    case 'DHL': return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${number}`;
    default: return '';
  }
}
