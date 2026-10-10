import { useState } from 'react';
import type { PurchasePack } from '../../shared/types';

export function PurchasePackFields({ value, onChange }: { value?: PurchasePack; onChange: (pack?: PurchasePack) => void }) {
  const [size, setSize] = useState(value ? String(value.size) : '');
  const [price, setPrice] = useState(value?.priceCents !== undefined ? (value.priceCents / 100).toFixed(2) : '');
  function change(nextSize: string, nextPrice: string) {
    setSize(nextSize); setPrice(nextPrice);
    const [whole, fractional = ''] = nextPrice.split('.');
    const cents = nextPrice ? Number(whole || '0') * 100 + Number(fractional.padEnd(2, '0')) : undefined;
    onChange(nextSize ? { size: Number(nextSize), ...(cents !== undefined && { priceCents: cents }) } : undefined);
  }
  return <fieldset className="pack-fields"><legend>Buying packs <span className="optional">Optional</span></legend>
    <div className="form-grid"><label>Units per pack<input type="number" min="1" max="1000000" step="1" value={size} onChange={event => change(event.target.value, price)} placeholder="Unknown" /></label>
    <label>Estimated price per pack (USD)<input type="text" inputMode="decimal" disabled={!size} pattern="[0-9]+([.][0-9]{1,2})?" value={price} onChange={event => change(size, event.target.value)} placeholder="Unknown" /></label></div>
    <p className="muted small">Use the supplier's pack size. Leave unknown values blank. Excludes shipping and tax.</p>
  </fieldset>;
}
