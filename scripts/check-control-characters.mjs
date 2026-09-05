#!/usr/bin/env node
/**
 * Fails if any tracked text file contains a raw control or invisible character.
 *
 * WHY THIS EXISTS
 *
 * A literal control character reaching a source file where an escape sequence
 * was intended is a bug no test suite catches on its own: the assertion is
 * written against the same literal and stays consistent with it, the
 * typechecker is happy because a NUL in a string literal is valid TypeScript,
 * and git silently reclassifies the file as binary so it produces no reviewable
 * diff. The bug and its assertion agree with each other, so the file has to be
 * inspected as bytes.
 *
 * It earns its place here twice over. This repository carries a fixture of real
 * room messages, and the protocol it audits runs on a server that replaces every
 * invisible character with a space before storage — so a stray one in a test or
 * a fixture would be indistinguishable from the thing being tested.
 *
 * Allowed: tab, newline, and carriage return as the first half of a CRLF pair,
 * so a Windows checkout with core.autocrlf=true passes.
 *
 * Note that the ranges below are written as numbers rather than as a regular
 * expression literal. A character class spelled with the characters themselves
 * would make this file the first thing it has to reject.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TAB = 0x09;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * Built with fromCharCode for the same reason the ranges above are numeric:
 * writing these three separators as literals would put the very characters
 * this script rejects into this script.
 */
const NUL_SEPARATOR = String.fromCharCode(0x00);
const LINE_FEED = String.fromCharCode(0x0a);
const CARRIAGE_RETURN_CHAR = String.fromCharCode(0x0d);

/**
 * Inclusive code point ranges that must appear as escapes rather than as
 * themselves: the C0 controls, DEL and the C1 controls, plus the invisible
 * characters this protocol's sweep is about - zero-width marks, bidi controls,
 * the line and paragraph separators, the byte order mark, the Mongolian vowel
 * separator, the private use areas, and the Unicode tag block.
 */
const FORBIDDEN_RANGES = [
  [0x0000, 0x001f, 'C0 control'],
  [0x007f, 0x009f, 'DEL or C1 control'],
  [0x061c, 0x061c, 'Arabic letter mark'],
  [0x180e, 0x180e, 'Mongolian vowel separator'],
  [0x200b, 0x200f, 'zero-width or bidi mark'],
  [0x202a, 0x202e, 'bidi embedding or override'],
  [0x2028, 0x2029, 'line or paragraph separator'],
  [0x2060, 0x2064, 'word joiner or invisible operator'],
  [0x2066, 0x2069, 'bidi isolate'],
  [0xd800, 0xdfff, 'lone surrogate'],
  [0xe000, 0xf8ff, 'private use'],
  [0xfeff, 0xfeff, 'byte order mark'],
  [0xfff9, 0xfffb, 'interlinear annotation'],
  [0xe0000, 0xe007f, 'Unicode tag block'],
  [0xf0000, 0xffffd, 'supplementary private use A'],
  [0x100000, 0x10fffd, 'supplementary private use B'],
];

/** Files whose bytes are not meant to be read as text. */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'zip', 'gz', 'tar', 'bz2', 'xz', '7z',
  'mp3', 'mp4', 'mov', 'wav', 'webm',
  'wasm', 'so', 'dll', 'dylib', 'exe', 'node',
]);

function forbiddenReason(codePoint) {
  if (codePoint === TAB || codePoint === NEWLINE) return null;
  for (const [start, end, reason] of FORBIDDEN_RANGES) {
    if (codePoint >= start && codePoint <= end) return reason;
  }
  return null;
}

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return output.split(NUL_SEPARATOR).filter((path) => path.length > 0);
}

function isTextPath(path) {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return true;
  return !BINARY_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

function label(codePoint) {
  return 'U+' + codePoint.toString(16).toUpperCase().padStart(4, '0');
}

const findings = [];

for (const path of trackedFiles()) {
  if (!isTextPath(path)) continue;

  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // A tracked file missing from the working tree is not this check's problem.
    continue;
  }

  text.split(LINE_FEED).forEach((rawLine, index) => {
    // A trailing CR is the first half of a CRLF pair, which is a line ending
    // rather than a stray control character.
    const line = rawLine.endsWith(CARRIAGE_RETURN_CHAR) ? rawLine.slice(0, -1) : rawLine;
    let column = 0;
    for (const character of line) {
      column += 1;
      const codePoint = character.codePointAt(0);
      const reason =
        codePoint === CARRIAGE_RETURN ? 'carriage return not part of CRLF' : forbiddenReason(codePoint);
      if (reason !== null) {
        findings.push({ path, line: index + 1, column, codePoint: label(codePoint), reason });
      }
    }
  });
}

if (findings.length > 0) {
  console.error('Raw control or invisible characters found in tracked text files.\n');
  for (const finding of findings) {
    console.error(
      `  ${finding.path}:${finding.line}:${finding.column}  ${finding.codePoint}  ${finding.reason}`,
    );
  }
  console.error(
    '\nWrite these as escape sequences instead, so they survive review and git does\n' +
      'not treat the file as binary. See the comment at the top of\n' +
      'scripts/check-control-characters.mjs for why this check exists.',
  );
  process.exit(1);
}

console.log('No raw control or invisible characters in tracked text files.');
