import { completeFlow, type PartialFlow } from './flowFields';
import { formatAddress, readUint } from './reader';
import {
  parseFieldSpecs,
  TemplateStore,
  templateFromFields,
  type TemplateField,
} from './templates';
import type { DecodedFlow } from './types';
import { NetFlowDecodeError } from './types';

const V9_HEADER_LENGTH = 24;
export const V9_TEMPLATE_SET = 0;
export const V9_OPTIONS_SET = 1;
const V9_MIN_DATA_SET = 256;

// NetFlow v9 standard information elements this collector maps.
const FIELD = {
  IN_BYTES: 1,
  IN_PKTS: 2,
  PROTOCOL: 4,
  SRC_TOS: 5,
  TCP_FLAGS: 6,
  L4_SRC_PORT: 7,
  IPV4_SRC_ADDR: 8,
  L4_DST_PORT: 11,
  IPV4_DST_ADDR: 12,
  IPV6_SRC_ADDR: 27,
  IPV6_DST_ADDR: 28,
  LAST_SWITCHED: 21,
  FIRST_SWITCHED: 22,
} as const;

interface TemplateSetSpec {
  templateId: number;
  fields: TemplateField[];
  isOptions: boolean;
}

export class NetFlowV9Decoder {
  private readonly templates = new TemplateStore();

  /**
   * Decodes one v9 packet into flows. Templates are cached per exporter
   * (`address#sourceId`), so data packets decode against templates announced
   * by earlier datagrams — pass the same address for the same exporter.
   */
  decode(packet: Buffer, exporterAddress: string): DecodedFlow[] {
    if (packet.length < V9_HEADER_LENGTH)
      throw new NetFlowDecodeError(`v9 header truncated (${packet.length} bytes)`);
    if (packet.readUInt16BE(0) !== 9)
      throw new NetFlowDecodeError(`not a v9 packet (version ${packet.readUInt16BE(0)})`);
    const sysUptimeMs = readUint(packet, 4, 4);
    const exportTimeMs =
      readUint(packet, 8, 4) * 1000 + Math.floor(readUint(packet, 12, 4) / 1_000_000);
    const sourceId = readUint(packet, 20, 4);
    const exporterKey = `${exporterAddress}#${sourceId}`;
    const bootMs = exportTimeMs - sysUptimeMs;

    const flows: DecodedFlow[] = [];
    let offset = V9_HEADER_LENGTH;
    while (offset + 4 <= packet.length) {
      const setId = packet.readUInt16BE(offset);
      const setLength = packet.readUInt16BE(offset + 2);
      if (setLength < 4)
        throw new NetFlowDecodeError(`v9 set ${setId}: invalid set length ${setLength}`);
      if (offset + setLength > packet.length)
        throw new NetFlowDecodeError(`v9 set ${setId} overruns packet`);
      const bodyStart = offset + 4;
      const bodyEnd = offset + setLength;
      if (setId === V9_TEMPLATE_SET || setId === V9_OPTIONS_SET) {
        for (const spec of this.readTemplateSet(
          packet,
          bodyStart,
          bodyEnd,
          setId === V9_OPTIONS_SET,
        )) {
          this.templates.set(
            exporterKey,
            templateFromFields(spec.templateId, spec.fields, spec.isOptions),
          );
        }
      } else if (setId >= V9_MIN_DATA_SET) {
        flows.push(
          ...this.readDataRecords(
            packet,
            bodyStart,
            bodyEnd,
            exporterKey,
            setId,
            bootMs,
            exportTimeMs,
          ),
        );
      } else {
        throw new NetFlowDecodeError(`v9 reserved set id ${setId}`);
      }
      offset = bodyEnd;
    }
    return flows;
  }

  private readTemplateSet(
    packet: Buffer,
    bodyStart: number,
    bodyEnd: number,
    isOptions: boolean,
  ): TemplateSetSpec[] {
    const specs: TemplateSetSpec[] = [];
    let pos = bodyStart;
    while (pos + 4 <= bodyEnd) {
      const templateId = packet.readUInt16BE(pos);
      if (templateId < V9_MIN_DATA_SET)
        throw new NetFlowDecodeError(`v9 template id ${templateId} out of range`);
      if (isOptions) {
        // v9 options template header: id, scope length (bytes), option length (bytes).
        const scopeLength = packet.readUInt16BE(pos + 2);
        const optionLength = packet.readUInt16BE(pos + 4);
        if (pos + 6 > bodyEnd) throw new NetFlowDecodeError('v9 options template header truncated');
        const specStart = pos + 6;
        const specEnd = specStart + scopeLength + optionLength;
        if (specEnd > bodyEnd) throw new NetFlowDecodeError('v9 options template overruns set');
        const { fields, consumed } = parseFieldSpecs(
          packet,
          specStart,
          specEnd,
          Math.floor((scopeLength + optionLength) / 4),
        );
        specs.push({ templateId, fields, isOptions: true });
        pos = specStart + consumed;
      } else {
        const fieldCount = packet.readUInt16BE(pos + 2);
        const { fields, consumed } = parseFieldSpecs(packet, pos + 4, bodyEnd, fieldCount);
        specs.push({ templateId, fields, isOptions: false });
        pos = pos + 4 + consumed;
      }
    }
    return specs;
  }

  private readDataRecords(
    packet: Buffer,
    bodyStart: number,
    bodyEnd: number,
    exporterKey: string,
    templateId: number,
    bootMs: number,
    exportTimeMs: number,
  ): DecodedFlow[] {
    const template = this.templates.get(exporterKey, templateId);
    if (!template)
      throw new NetFlowDecodeError(`v9 data set references unknown template ${templateId}`);
    // Options data sets carry exporter statistics, not flows — skip them.
    if (template.isOptions) return [];
    const flows: DecodedFlow[] = [];
    const recordCount = Math.floor((bodyEnd - bodyStart) / template.recordLength);
    for (let i = 0; i < recordCount; i++) {
      const base = bodyStart + i * template.recordLength;
      const partial = this.readRecord(packet, base, template.fields, bootMs);
      flows.push(completeFlow(partial, 9, exporterKey.split('#')[1] ?? null, exportTimeMs));
    }
    // Trailing bytes below one record length are end-of-set padding — ignored.
    return flows;
  }

  private readRecord(
    packet: Buffer,
    base: number,
    fields: TemplateField[],
    bootMs: number,
  ): PartialFlow {
    const partial: PartialFlow = {};
    let offset = base;
    for (const { type, length } of fields) {
      switch (type) {
        case FIELD.IN_BYTES:
          partial.bytes = readUint(packet, offset, length);
          break;
        case FIELD.IN_PKTS:
          partial.packets = readUint(packet, offset, length);
          break;
        case FIELD.PROTOCOL:
          partial.protocol = readUint(packet, offset, length);
          break;
        case FIELD.SRC_TOS:
          partial.tos = readUint(packet, offset, length);
          break;
        case FIELD.TCP_FLAGS:
          partial.tcpFlags = readUint(packet, offset, length);
          break;
        case FIELD.L4_SRC_PORT:
          partial.srcPort = readUint(packet, offset, length);
          break;
        case FIELD.L4_DST_PORT:
          partial.dstPort = readUint(packet, offset, length);
          break;
        case FIELD.IPV4_SRC_ADDR:
        case FIELD.IPV6_SRC_ADDR:
          partial.srcAddress = formatAddress(packet, offset, length);
          break;
        case FIELD.IPV4_DST_ADDR:
        case FIELD.IPV6_DST_ADDR:
          partial.dstAddress = formatAddress(packet, offset, length);
          break;
        case FIELD.FIRST_SWITCHED:
          partial.firstSwitchedMs = bootMs + readUint(packet, offset, length);
          break;
        case FIELD.LAST_SWITCHED:
          partial.lastSwitchedMs = bootMs + readUint(packet, offset, length);
          break;
        default:
          break; // unmapped information element — skipped, it is just bytes
      }
      offset += length;
    }
    return partial;
  }
}
