import { Reader, open, Buffer } from 'deno';
import { stringsReader } from 'https://deno.land/x/net/util.ts';
import escape from './escape.ts';

const globalEval = eval;
const window = globalEval('this');

Object.defineProperty(window, '$$ESCAPE', {
  value: escape,
  writable: false,
});

export interface Params {
  [key: string]: any;
}

enum ReadMode {
  Normal,
  Escaped,
  Raw,
  Comment,
  Evaluate,
}

enum Codes {
  Begin = 60, // <
  End = 62, // >
  Percent = 37, // %
  Escaped = 61, // =
  Raw = 45, // -
  Comment = 35, // #
}

interface Template {
  (params: Params): Promise<Reader>;
}

function NewTemplate(script: string): Template {
  return async function(params: Params): Promise<Reader> {
    for (const [k, v] of Object.entries(params)) {
      window[k] = v;
    }
    window.$$OUTPUT = [];

    globalEval(script);

    const reader = stringsReader(String(window.$$OUTPUT.join('')));
    for (const k of Object.keys(params)) {
      delete window[k];
    }
    delete window.$$OUTPUT;
    return reader;
  };
}

export async function compile(body: Reader): Promise<Template> {
  const buf: Array<number> = [];
  const statements: Array<string> = [];
  const statementBuf = new Buffer();
  const readBuf = new Uint8Array(1);
  let readMode: ReadMode = ReadMode.Normal;
  const statementBufWrite = async (byte: number): Promise<number> =>
    await statementBuf.write(new Uint8Array([byte]));

  while (true) {
    const { eof } = await body.read(readBuf);
    if (eof) {
      break;
    }

    buf.push(readBuf[0]);
    if (buf.length < 3) {
      continue;
    }

    if (readMode === ReadMode.Normal) {
      // Detect ReadMode
      if (buf[0] === Codes.Begin && buf[1] === Codes.Percent) {
        switch (buf[2]) {
          case Codes.Escaped:
            readMode = ReadMode.Escaped;
            break;
          case Codes.Raw:
            readMode = ReadMode.Raw;
            break;
          case Codes.Comment:
            readMode = ReadMode.Comment;
            break;
          default:
            readMode = ReadMode.Evaluate;
            break;
        }
        statements.push(`$$OUTPUT.push(\`${statementBuf.toString()}\`);`);
        statementBuf.reset();
        buf.splice(0);
        continue;
      }
      if (buf.length > 2) {
        await statementBufWrite(buf.shift());
      }
      continue;
    }

    // Finish current ReadMode
    if (buf[1] === Codes.Percent && buf[2] === Codes.End) {
      statementBufWrite(buf.shift());
      buf.splice(0);
      // Don't execute if ReadMode is Comment.
      if (readMode !== ReadMode.Comment) {
        switch (readMode) {
          case ReadMode.Raw:
            statements.push(`$$OUTPUT.push(${statementBuf.toString()});`);
            break;
          case ReadMode.Escaped:
            statements.push(
              `$$OUTPUT.push($$ESCAPE(${statementBuf.toString()}));`
            );
            break;
          case ReadMode.Evaluate:
            statements.push(statementBuf.toString());
            break;
        }
      }
      statementBuf.reset();
      readMode = ReadMode.Normal;
      continue;
    }
    await statementBufWrite(buf.shift());
  }

  // Flush buffer
  while (buf.length > 0) {
    await statementBufWrite(buf.shift());
  }
  statements.push(`$$OUTPUT.push(\`${statementBuf.toString()}\`);`);
  statementBuf.reset();

  return NewTemplate(statements.join(''));
}

export async function render(str: string, params: Params): Promise<Reader> {
  const body = stringsReader(str);
  const template = await compile(body);
  return template(params);
}

export async function renderFile(
  path: string,
  params: Params
): Promise<Reader> {
  const file = await open(path);
  const template = await compile(file);
  file.close();
  return template(params);
}