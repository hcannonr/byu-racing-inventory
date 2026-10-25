import type { BinStatus } from './types';
export interface PublicScanLabel { binId: string; key: string }
export interface PublicBinView {
  binId: string; name: string; specification: string; location: string; letter: 'A' | 'B';
  status: BinStatus; cycle: number; otherEmpty: boolean; practice: boolean;
}
export interface PublicScanResult { bin: PublicBinView; changed: boolean }
