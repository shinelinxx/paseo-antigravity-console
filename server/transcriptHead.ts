import { promises as fs } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const CHUNK_BYTES = 64 * 1024;
const CONTENT_PREFIX_LIMIT = 4096;
const TYPE_PREFIX_LIMIT = 128;
const MAX_BOOKKEEPING_LINES = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM_HEADER_RE =
  /^\s*(?:The following is a <SYSTEM_MESSAGE> not actually sent by the user\. It is provided by the system as important information to pay attention to\.\s*)?(?:<SYSTEM_MESSAGE>\s*)?\[Message\]\s+([^\r\n]*)/;
const SENDER_RE = /(?:^|\s)sender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i;

export interface TranscriptHeadInfo {
  /** True when the decisive first USER_INPUT or SYSTEM_MESSAGE record was completely read. */
  complete: boolean;
  /** Decisive record type (`SYSTEM_MESSAGE` or `USER_INPUT`), or null if undetermined. */
  type: string | null;
  /** Delegating parent conversation UUID when the first message is a valid SYSTEM_MESSAGE delegation. */
  sender: string | null;
  /** True iff the decisive record is a SYSTEM_MESSAGE with a structured `[Message] ... sender=<uuid>` header. */
  isSubagent: boolean;
}

/**
 * Extracts the delegation sender UUID from a SYSTEM_MESSAGE's decoded content prefix.
 * Only inspects the `[Message]` header attributes before `content=` so message body text
 * mentioning `sender=<uuid>` can never spoof delegation ownership.
 */
export function extractDelegationSender(type: string | null, contentPrefix: string | null): string | null {
  if (type !== "SYSTEM_MESSAGE" || !contentPrefix) return null;
  const headerLine = SYSTEM_HEADER_RE.exec(contentPrefix)?.[1];
  if (!headerLine) return null;
  const meta = headerLine.split(/(?:^|\s)content=/, 1)[0] ?? "";
  const sender = SENDER_RE.exec(meta)?.[1]?.toLowerCase() ?? null;
  return sender && UUID_RE.test(sender) ? sender : null;
}

interface LineParser {
  feed(chunk: string, startIndex: number): number;
  finishEof(): void;
  readonly complete: boolean;
  readonly invalid: boolean;
  readonly sawNonWs: boolean;
  readonly type: string | null;
  readonly content: string | null;
}

function createTopLevelLineParser(): LineParser {
  let started = false;
  let objDepth = 0;
  let arrDepth = 0;
  let inString = false;
  let escape = false;
  let unicodeRemaining = 0;
  let unicodeHex = "";

  let expectingKey = false;
  let expectingColon = false;
  let expectingValue = false;
  let readingKey = false;
  let keyBuf = "";
  let currentKey: string | null = null;

  let captureField: "type" | "content" | "text" | null = null;
  let captureLimit = 0;
  let captureBuf = "";
  let captureDone = false;

  let typeVal: string | null = null;
  let contentVal: string | null = null;
  let textVal: string | null = null;

  let rootClosed = false;
  let sawAnyNonWs = false;
  let invalidJson = false;

  const appendChar = (ch: string) => {
    if (!captureField || captureDone) return;
    if (captureBuf.length < captureLimit) {
      captureBuf += ch;
      if (captureBuf.length >= captureLimit) captureDone = true;
    }
  };

  const finishCapture = () => {
    if (captureField === "type" && typeVal === null) typeVal = captureBuf;
    else if (captureField === "content" && contentVal === null) contentVal = captureBuf;
    else if (captureField === "text" && textVal === null) textVal = captureBuf;
    captureField = null;
    captureBuf = "";
    captureDone = false;
  };

  return {
    get complete() {
      return rootClosed && !invalidJson && sawAnyNonWs;
    },
    get invalid() {
      return invalidJson;
    },
    get sawNonWs() {
      return sawAnyNonWs;
    },
    get type() {
      return typeVal;
    },
    get content() {
      return contentVal ?? textVal;
    },
    finishEof() {
      if (captureField) finishCapture();
    },
    /** Consumes characters up to and including `\n` (returns index after `\n`, or -1 if line did not end). */
    feed(chunk: string, startIndex: number): number {
      for (let i = startIndex; i < chunk.length; i += 1) {
        const ch = chunk[i]!;
        if (ch === "\n") {
          return i + 1;
        }
        if (invalidJson || rootClosed) continue;

        if (!started) {
          if (ch === " " || ch === "\t" || ch === "\r" || ch === "\ufeff") continue;
          sawAnyNonWs = true;
          if (ch !== "{") {
            invalidJson = true;
            continue;
          }
          started = true;
          objDepth = 1;
          expectingKey = true;
          continue;
        }

        if (inString) {
          if (unicodeRemaining > 0) {
            unicodeHex += ch;
            unicodeRemaining -= 1;
            if (unicodeRemaining === 0) {
              const code = Number.parseInt(unicodeHex, 16);
              const decoded = Number.isFinite(code) ? String.fromCharCode(code) : "";
              if (readingKey) {
                if (keyBuf.length < 64) keyBuf += decoded;
              } else {
                appendChar(decoded);
              }
              unicodeHex = "";
            }
            continue;
          }
          if (escape) {
            escape = false;
            let decoded = ch;
            if (ch === "n") decoded = "\n";
            else if (ch === "r") decoded = "\r";
            else if (ch === "t") decoded = "\t";
            else if (ch === "b") decoded = "\b";
            else if (ch === "f") decoded = "\f";
            else if (ch === "u") {
              unicodeRemaining = 4;
              unicodeHex = "";
              continue;
            }
            if (readingKey) {
              if (keyBuf.length < 64) keyBuf += decoded;
            } else {
              appendChar(decoded);
            }
            continue;
          }
          if (ch === "\\") {
            escape = true;
            continue;
          }
          if (ch === '"') {
            inString = false;
            if (readingKey) {
              readingKey = false;
              currentKey = keyBuf;
              keyBuf = "";
              expectingKey = false;
              expectingColon = true;
            } else if (captureField) {
              finishCapture();
              currentKey = null;
              expectingValue = false;
            } else if (objDepth === 1 && arrDepth === 0 && expectingValue) {
              currentKey = null;
              expectingValue = false;
            }
            continue;
          }
          if (readingKey) {
            if (keyBuf.length < 64) keyBuf += ch;
          } else {
            appendChar(ch);
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          if (objDepth === 1 && arrDepth === 0) {
            if (expectingKey) {
              readingKey = true;
              keyBuf = "";
            } else if (expectingValue) {
              if (currentKey === "type" && typeVal === null) {
                captureField = "type";
                captureLimit = TYPE_PREFIX_LIMIT;
                captureBuf = "";
                captureDone = false;
              } else if (currentKey === "content" && contentVal === null) {
                captureField = "content";
                captureLimit = CONTENT_PREFIX_LIMIT;
                captureBuf = "";
                captureDone = false;
              } else if (currentKey === "text" && textVal === null) {
                captureField = "text";
                captureLimit = CONTENT_PREFIX_LIMIT;
                captureBuf = "";
                captureDone = false;
              }
            }
          }
          continue;
        }

        if (ch === "{") {
          objDepth += 1;
          if (objDepth === 2 && arrDepth === 0) {
            expectingValue = false;
            currentKey = null;
          }
          continue;
        }
        if (ch === "}") {
          objDepth -= 1;
          if (objDepth <= 0) {
            rootClosed = true;
            expectingKey = false;
            expectingColon = false;
            expectingValue = false;
          }
          continue;
        }
        if (ch === "[") {
          arrDepth += 1;
          if (objDepth === 1 && arrDepth === 1) {
            expectingValue = false;
            currentKey = null;
          }
          continue;
        }
        if (ch === "]") {
          arrDepth = Math.max(0, arrDepth - 1);
          continue;
        }
        if (objDepth === 1 && arrDepth === 0) {
          if (ch === ":" && expectingColon) {
            expectingColon = false;
            expectingValue = true;
          } else if (ch === ",") {
            expectingKey = true;
            expectingColon = false;
            expectingValue = false;
            currentKey = null;
          }
        }
      }
      return -1;
    },
  };
}

/**
 * Streams a transcript file from byte 0 using a single reused 64 KiB buffer until it reaches
 * the first `USER_INPUT` or `SYSTEM_MESSAGE` row (skipping any leading bookkeeping rows).
 * Handles arbitrarily large rows (90 KiB, 300 KiB+) regardless of JSON field order without
 * allocating the full row in memory.
 */
export async function readTranscriptHead(filePath: string): Promise<TranscriptHeadInfo> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(filePath, "r");
  } catch {
    return { complete: false, type: null, sender: null, isSubagent: false };
  }

  try {
    return await readTranscriptHeadFromHandle(fh);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

export async function readTranscriptHeadFromHandle(fh: fs.FileHandle): Promise<TranscriptHeadInfo> {
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  let linesScanned = 0;
  let parser = createTopLevelLineParser();

  const evaluateCompletedLine = (): TranscriptHeadInfo | null => {
    if (!parser.sawNonWs) return null;
    if (!parser.complete) {
      return { complete: false, type: null, sender: null, isSubagent: false };
    }
    const type = parser.type;
    if (type === "USER_INPUT") {
      return { complete: true, type: "USER_INPUT", sender: null, isSubagent: false };
    }
    if (type === "SYSTEM_MESSAGE") {
      const sender = extractDelegationSender(type, parser.content);
      return { complete: true, type: "SYSTEM_MESSAGE", sender, isSubagent: sender !== null };
    }
    return null;
  };

  try {
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const chunk = decoder.write(buf.subarray(0, bytesRead));
      let pos = 0;
      while (pos < chunk.length) {
        const nextPos = parser.feed(chunk, pos);
        if (nextPos === -1) break;
        const verdict = evaluateCompletedLine();
        if (verdict) return verdict;
        if (parser.sawNonWs) {
          linesScanned += 1;
          if (linesScanned >= MAX_BOOKKEEPING_LINES) {
            return { complete: true, type: null, sender: null, isSubagent: false };
          }
        }
        parser = createTopLevelLineParser();
        pos = nextPos;
      }
    }
    const tail = decoder.end();
    if (tail) {
      let pos = 0;
      while (pos < tail.length) {
        const nextPos = parser.feed(tail, pos);
        if (nextPos === -1) break;
        const verdict = evaluateCompletedLine();
        if (verdict) return verdict;
        if (parser.sawNonWs) {
          linesScanned += 1;
          if (linesScanned >= MAX_BOOKKEEPING_LINES) {
            return { complete: true, type: null, sender: null, isSubagent: false };
          }
        }
        parser = createTopLevelLineParser();
        pos = nextPos;
      }
    }
    parser.finishEof();
    if (parser.sawNonWs) {
      const verdict = evaluateCompletedLine();
      if (verdict) return verdict;
    }
    return { complete: false, type: null, sender: null, isSubagent: false };
  } catch {
    return { complete: false, type: null, sender: null, isSubagent: false };
  }
}
