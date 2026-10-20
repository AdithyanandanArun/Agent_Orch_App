import { RASTER_IMAGE_TYPES, type RasterImageType } from '@relay/contracts';

/** Identifies a raster image from its leading bytes only. Declared types and extensions are never trusted for previews. */
export function sniffRaster(head: Buffer): RasterImageType | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export const isRasterType = (type: string): type is RasterImageType => (RASTER_IMAGE_TYPES as readonly string[]).includes(type);

const EXTENSION_TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json', csv: 'text/csv', tsv: 'text/tab-separated-values',
  log: 'text/plain', yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml', xml: 'application/xml', html: 'text/html', htm: 'text/html',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript', jsx: 'text/javascript',
  py: 'text/x-python', rs: 'text/x-rust', go: 'text/x-go', java: 'text/x-java', c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++', sh: 'text/x-shellscript',
  sql: 'application/sql', pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', avif: 'image/avif',
};

/** Display and provider hint for a non-raster file. It never changes how the server serves the bytes. */
export function fileMimeType(name: string, declared: string | undefined): string {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase();
  const byExtension = ext ? EXTENSION_TYPES[ext] : undefined;
  if (byExtension) return byExtension;
  const claimed = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/.test(claimed) && !isRasterType(claimed) ? claimed : 'application/octet-stream';
}

/** A display name only: never a path. Strips directories, control and bidi characters and bounds the length. */
export function sanitizeName(raw: string | undefined, max: number): string {
  let name = (raw ?? '').normalize('NFC');
  name = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/g, '').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '');
  if (!name) return 'attachment';
  if (name.length > max) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = `${name.slice(0, max - ext.length)}${ext}`;
  }
  return name;
}

/** Conservative ASCII file name for a run's private staging directory. */
export function stagedName(index: number, name: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'file';
  return `${String(index + 1).padStart(2, '0')}-${base}`;
}

const TEXT_EXTENSIONS = /\.(txt|md|markdown|json|csv|tsv|log|ya?ml|toml|xml|html?|css|m?[jt]sx?|py|rs|go|java|c|h|cpp|sh|sql)$/i;
export const looksTextual = (name: string, mimeType: string): boolean => mimeType.startsWith('text/') || /(json|xml|yaml|toml|sql|javascript|typescript)$/.test(mimeType) || TEXT_EXTENSIONS.test(name);
