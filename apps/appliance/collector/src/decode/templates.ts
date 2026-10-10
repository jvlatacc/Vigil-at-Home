import { NetFlowDecodeError } from './types';

export interface TemplateField {
  type: number;
  length: number;
}

/** A flow or options template as announced in-band by the exporter. */
export interface TemplateDef {
  id: number;
  fields: TemplateField[];
  /** Sum of field lengths — the byte size of one data record. */
  recordLength: number;
  /** Options templates describe options data sets, not flow data sets. */
  isOptions: boolean;
}

const MAX_TEMPLATES_PER_EXPORTER = 4096;

/**
 * In-band template cache, keyed per exporter (`address#engineId`): v9 and
 * IPFIX exporters announce field layouts in template sets, then reference
 * them from later packets. Bounded per exporter so garbage cannot balloon it.
 */
export class TemplateStore {
  private readonly byExporter = new Map<string, Map<number, TemplateDef>>();

  get(exporterKey: string, templateId: number): TemplateDef | undefined {
    return this.byExporter.get(exporterKey)?.get(templateId);
  }

  set(exporterKey: string, def: TemplateDef): void {
    let templates = this.byExporter.get(exporterKey);
    if (!templates) {
      templates = new Map();
      this.byExporter.set(exporterKey, templates);
    }
    if (!templates.has(def.id) && templates.size >= MAX_TEMPLATES_PER_EXPORTER) {
      // Evict the first-inserted template — closest thing to least-recently
      // announced without tracking access.
      const oldest = templates.keys().next();
      if (!oldest.done) templates.delete(oldest.value);
    }
    templates.set(def.id, def);
  }

  remove(exporterKey: string, templateId: number): void {
    this.byExporter.get(exporterKey)?.delete(templateId);
  }
}

export interface ParsedFieldSpecs {
  fields: TemplateField[];
  /** Bytes consumed from the offset — PEN specs count 8, plain specs 4. */
  consumed: number;
}

/**
 * Parses `count` (type, length) pairs — shared by v9 and IPFIX template sets.
 * Enterprise information elements (type high-bit set) carry a 4-byte PEN
 * after the type; it is skipped so the field list stays aligned, and the
 * low 15 bits keep the element number.
 */
export function parseFieldSpecs(
  buf: Buffer,
  offset: number,
  end: number,
  count: number,
): ParsedFieldSpecs {
  const fields: TemplateField[] = [];
  let pos = offset;
  for (let i = 0; i < count; i++) {
    if (pos + 4 > end) throw new NetFlowDecodeError('template field list truncated');
    const type = buf.readUInt16BE(pos);
    const length = buf.readUInt16BE(pos + 2);
    const specSize = (type & 0x8000) !== 0 ? 8 : 4;
    if (pos + specSize > end) throw new NetFlowDecodeError('template field list truncated');
    fields.push({ type: type & 0x7fff, length });
    pos += specSize;
  }
  return { fields, consumed: pos - offset };
}

export function templateFromFields(
  id: number,
  fields: TemplateField[],
  isOptions: boolean,
): TemplateDef {
  let recordLength = 0;
  for (const field of fields) recordLength += field.length;
  return { id, fields, recordLength, isOptions };
}
