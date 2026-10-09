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

const IPFIX_HEADER_LENGTH = 16;
export const IPFIX_TEMPLATE_SET = 2;
export const IPFIX_OPTIONS_SET = 3;
const IPFIX_MIN_DATA_SET = 256;

// RFC 7011 information elements this collector maps. Legacy NetFlow v9
// element numbers (1, 2, 4, ...) are still emitted by many IPFIX exporters.
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
  FLOW_START_SECONDS: 150,
  FLOW_END_SECONDS: 151,
  FLOW_START_MS: 152,
  FLOW_END_MS: 153,
  OCTET_DELTA: 85,
  PACKET_DELTA: 86,
  OCTET_TOTAL: 231,
  PACKET_TOTAL: 232,
} as const;

interface WithdrawnTemplate {
  templateId: number;
  withdrawn: true;
}

interface TemplateSet {
  templateId: number;
  fields: TemplateField[];
  isOptions: boolean;
  withdrawn: false;
}

export class IpfixDecoder {
  private readonly templates = new TemplateStore();

  /**
   * Decodes one RFC 7011 IPFIX message into flows. Templates are cached per
   * exporter (`address#domainId`) and withdrawn by zero-field-count template
   * sets; data records may land in any order relative to their templates.
   */
  decode(packet: Buffer, exporterAddress: string): DecodedFlow[] {
    if (packet.length < IPFIX_HEADER_LENGTH) {
      throw new NetFlowDecodeError(`ipfix header truncated (${packet.length} bytes)`);
    }
    if (packet.readUInt16BE(0) !== 10) {
      throw new NetFlowDecodeError(`not an IPFIX packet (version ${packet.readUInt16BE(0)})`);
    }
    const messageLength = packet.readUInt16BE(2);
    if (messageLength < IPFIX_HEADER_LENGTH) {
      throw new NetFlowDecodeError(`ipfix message length ${messageLength} is impossible`);
    }
    if (messageLength > packet.length) {
      throw new NetFlowDecodeError(
        `ipfix message length ${messageLength} exceeds datagram (${packet.length})`,
      );
    }
    const exportTimeSec = readUint(packet, 4, 4);
    const domainId = readUint(packet, 12, 4);
    const exporterKey = `${exporterAddress}#${domainId}`;
    const exportTimeMs = exportTimeSec * 1000;

    const flows: DecodedFlow[] = [];
    let offset = IPFIX_HEADER_LENGTH;
    while (offset + 4 <= messageLength) {
      const setId = packet.readUInt16BE(offset);
      const setLength = packet.readUInt16BE(offset + 2);
      if (setLength < 4)
        throw new NetFlowDecodeError(`ipfix set ${setId}: invalid set length ${setLength}`);
      if (offset + setLength > messageLength)
        throw new NetFlowDecodeError(`ipfix set ${setId} overruns message`);
      const bodyStart = offset + 4;
      const bodyEnd = offset + setLength;
      if (setId === IPFIX_TEMPLATE_SET || setId === IPFIX_OPTIONS_SET) {
        for (const spec of this.readTemplateSet(
          packet,
          bodyStart,
          bodyEnd,
          setId === IPFIX_OPTIONS_SET,
        )) {
          if (spec.withdrawn) this.templates.remove(exporterKey, spec.templateId);
          else
            this.templates.set(
              exporterKey,
              templateFromFields(spec.templateId, spec.fields, spec.isOptions),
            );
        }
      } else if (setId >= IPFIX_MIN_DATA_SET) {
        flows.push(
          ...this.readDataRecords(packet, bodyStart, bodyEnd, exporterKey, setId, exportTimeMs),
        );
      } else {
        throw new NetFlowDecodeError(`ipfix reserved set id ${setId}`);
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
  ): Array<TemplateSet | WithdrawnTemplate> {
    const specs: Array<TemplateSet | WithdrawnTemplate> = [];
    let pos = bodyStart;
    while (pos + 4 <= bodyEnd) {
      const templateId = packet.readUInt16BE(pos);
      const fieldCount = packet.readUInt16BE(pos + 2);
      if (templateId < IPFIX_MIN_DATA_SET)
        throw new NetFlowDecodeError(`ipfix template id ${templateId} out of range`);
      if (fieldCount === 0) {
        // RFC 7011 template withdrawal: set body is just the 4-byte header.
        specs.push({ templateId, withdrawn: true });
        pos += 4;
        continue;
      }
      if (isOptions) {
        const scopeFieldCount = packet.readUInt16BE(pos + 4);
        if (pos + 6 > bodyEnd)
          throw new NetFlowDecodeError('ipfix options template header truncated');
        if (scopeFieldCount > fieldCount)
          throw new NetFlowDecodeError('ipfix options template scope exceeds fields');
        const specStart = pos + 6;
        const { fields, consumed } = parseFieldSpecs(packet, specStart, bodyEnd, fieldCount);
        specs.push({ templateId, fields, isOptions: true, withdrawn: false });
        pos = specStart + consumed;
      } else {
        const specStart = pos + 4;
        const { fields, consumed } = parseFieldSpecs(packet, specStart, bodyEnd, fieldCount);
        specs.push({ templateId, fields, isOptions: false, withdrawn: false });
        pos = specStart + consumed;
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
    exportTimeMs: number,
  ): DecodedFlow[] {
    const template = this.templates.get(exporterKey, templateId);
    if (!template)
      throw new NetFlowDecodeError(`ipfix data set references unknown template ${templateId}`);
    // Options data sets carry exporter statistics, not flows — skip them.
    if (template.isOptions) return [];
    const flows: DecodedFlow[] = [];
    const recordCount = Math.floor((bodyEnd - bodyStart) / template.recordLength);
    for (let i = 0; i < recordCount; i++) {
      const base = bodyStart + i * template.recordLength;
      const partial = this.readRecord(packet, base, template.fields);
      flows.push(completeFlow(partial, 10, exporterKey.split('#')[1] ?? null, exportTimeMs));
    }
    // Records are 4-byte aligned; trailing padding below one record length
    // (RFC 7011 section 3.4.3) is ignored.
    return flows;
  }

  private readRecord(packet: Buffer, base: number, fields: TemplateField[]): PartialFlow {
    const partial: PartialFlow = {};
    let offset = base;
    for (const { type, length } of fields) {
      const value = length > 0 ? readUint(packet, offset, length) : 0;
      switch (type) {
        case FIELD.IN_BYTES:
        case FIELD.OCTET_DELTA:
        case FIELD.OCTET_TOTAL:
          partial.bytes = value;
          break;
        case FIELD.IN_PKTS:
        case FIELD.PACKET_DELTA:
        case FIELD.PACKET_TOTAL:
          partial.packets = value;
          break;
        case FIELD.PROTOCOL:
          partial.protocol = value;
          break;
        case FIELD.SRC_TOS:
          partial.tos = value;
          break;
        case FIELD.TCP_FLAGS:
          partial.tcpFlags = value;
          break;
        case FIELD.L4_SRC_PORT:
          partial.srcPort = value;
          break;
        case FIELD.L4_DST_PORT:
          partial.dstPort = value;
          break;
        case FIELD.IPV4_SRC_ADDR:
        case FIELD.IPV6_SRC_ADDR:
          partial.srcAddress = formatAddress(packet, offset, length);
          break;
        case FIELD.IPV4_DST_ADDR:
        case FIELD.IPV6_DST_ADDR:
          partial.dstAddress = formatAddress(packet, offset, length);
          break;
        case FIELD.FLOW_START_SECONDS:
          partial.firstSwitchedMs = value * 1000;
          break;
        case FIELD.FLOW_END_SECONDS:
          partial.lastSwitchedMs = value * 1000;
          break;
        case FIELD.FLOW_START_MS:
          partial.firstSwitchedMs = value;
          break;
        case FIELD.FLOW_END_MS:
          partial.lastSwitchedMs = value;
          break;
        default:
          break; // unmapped information element — skipped, it is just bytes
      }
      offset += length;
    }
    return partial;
  }
}
