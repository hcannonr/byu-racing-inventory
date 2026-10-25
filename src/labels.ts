import { qrcode, code128, drawingSVG } from '@bwip-js/generic';
import type { Bin, Part } from '../shared/types';

export type LabelFormat = 'qr' | 'code128';
export type PaperSize = 'letter' | 'a4';
export interface BinLabel { part: Part; bin: Bin; letter: 'A' | 'B'; number: 1 | 2 }
export const paperSizes = { letter: { width: 215.9, height: 279.4, title: 'Letter' }, a4: { width: 210, height: 297, title: 'A4' } };
export const mmToPx = (mm: number) => mm * 96 / 25.4;

/** QR opens the automatic phone scan; Code 128 retains the raw hardware ID. Neither encodes a refill cycle. */
export function makeLabelCode(id: string, format: LabelFormat, origin = window.location.origin, scanLink?: string) {
  const qr = format === 'qr';
  const url = new URL('/', origin); url.searchParams.set('scan', id);
  const raw = qr
    ? qrcode({ bcid: 'qrcode', text: scanLink ?? url.href, scale: 4, padding: 8, backgroundcolor: 'FFFFFF' }, drawingSVG())
    : code128({ bcid: 'code128', text: id, scale: 3, height: 12, paddingwidth: 12, paddingheight: 4, backgroundcolor: 'FFFFFF' }, drawingSVG());
  const widthMm = qr ? 26 : 176, heightMm = qr ? 26 : 24;
  // Vector geometry remains crisp on print; quiet zones are inside the SVG viewBox.
  const svg = raw.replace('<svg ', `<svg width="${widthMm}mm" height="${heightMm}mm" preserveAspectRatio="${qr ? 'xMidYMid meet' : 'none'}" `);
  return { svg, widthMm, heightMm, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
}

export function labelsForParts(parts: Part[], selected: ReadonlySet<string>): BinLabel[] {
  return parts.flatMap(part => part.bins.flatMap((bin, index) => selected.has(bin.id)
    ? [{ part, bin, letter: index === 0 ? 'A' as const : 'B' as const, number: index === 0 ? 1 as const : 2 as const }] : []));
}

export function labelRows(labels: BinLabel[], format: LabelFormat): BinLabel[][] {
  const count = format === 'qr' ? 2 : 1;
  return Array.from({ length: Math.ceil(labels.length / count) }, (_, i) => labels.slice(i * count, (i + 1) * count));
}

/** Pack measured rows, preserving all text and never splitting a physical label. */
export function paginateLabelRows(heightsMm: number[], availableMm: number, gapMm: number): number[][] {
  const pages: number[][] = []; let used = 0;
  for (const [index, height] of heightsMm.entries()) {
    if (!Number.isFinite(height) || height <= 0 || height > availableMm) throw new Error('A label is larger than a page. Choose Code 128 for the wider layout or a taller paper size.');
    if (!pages.length || used + gapMm + height > availableMm) { pages.push([]); used = 0; }
    const page = pages.at(-1)!; used += (page.length ? gapMm : 0) + height; page.push(index);
  }
  return pages;
}
