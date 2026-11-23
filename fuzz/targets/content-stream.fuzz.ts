import {
  parseContentStreams,
  spliceOperatorBytes,
  spliceRun,
  type ResolvedForm,
} from '../../src/features/textedit/contentStream';

// Content streams come straight out of the PDF. The first byte splits the rest
// into one to four streams; a Do operator resolves to one of them as a Form
// XObject (chosen from the name), so the form descent and its caps are reached.
// Total by design: any throw is a finding.
export function fuzz(data: Buffer): void {
  if (data.length < 1) return;
  const count = (data[0] & 3) + 1;
  const body = new Uint8Array(data.subarray(1));
  const size = Math.ceil(body.length / count);
  const streams: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) streams.push(body.subarray(i * size, (i + 1) * size));

  const resolveForm = (name: string, fromStreamId: number): ResolvedForm | undefined => {
    const pick = (name.length + fromStreamId) % (count + 1);
    if (pick === count) return undefined;
    return { streamId: count + pick, bytes: streams[pick] };
  };

  const runs = parseContentStreams(streams, resolveForm, () => {});
  for (const run of runs.slice(0, 20)) {
    // Only runs from the page's own streams: a form's offsets index its bytes.
    const stream =
      run.streamIndex < count ? streams[run.streamIndex] : streams[run.streamIndex - count];
    if (!stream) continue;
    spliceRun(stream, run);
    spliceOperatorBytes(stream, run.start, run.end, new Uint8Array([0x20]));
  }
}
