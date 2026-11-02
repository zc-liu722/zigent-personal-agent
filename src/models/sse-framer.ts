/** Incremental SSE framing. Only newly arrived text is scanned; an unfinished
 * line is joined once, rather than copied and rescanned on every network read.
 * Keep the existing data-field contract (trimStart, multiline join, EOF flush).
 */
export class SseDataFramer {
  private readonly lineFragments: string[] = [];
  private data: string[] = [];
  private afterCr = false;
  completed = false;

  constructor(private readonly onData: (data: string) => boolean) {}

  push(chunk: string): void {
    let start = 0;
    if (!chunk || this.completed) return;
    // A CR already ended its line. Empty decoded chunks must not lose this flag.
    if (this.afterCr && chunk.startsWith("\n")) start = 1;
    this.afterCr = false;
    const endings = /[\r\n]/g;
    endings.lastIndex = start;
    let match: RegExpExecArray | null;
    while ((match = endings.exec(chunk))) {
      this.line(chunk.slice(start, match.index));
      if (this.completed) return;
      start = match.index + 1;
      if (match[0] === "\r") {
        if (chunk[start] === "\n") start++;
        else if (start === chunk.length) this.afterCr = true;
      }
      endings.lastIndex = start;
    }
    if (start < chunk.length) this.lineFragments.push(chunk.slice(start));
  }

  finish(): void {
    if (this.completed) return;
    if (this.lineFragments.length) this.line("");
    this.event();
  }

  private line(tail: string): void {
    let line = tail;
    if (this.lineFragments.length) {
      this.lineFragments.push(tail);
      line = this.lineFragments.join("");
      this.lineFragments.length = 0;
    }
    if (!line) this.event();
    else if (line.startsWith("data:")) this.data.push(line.slice(5).trimStart());
  }

  private event(): void {
    const data = this.data.join("\n");
    this.data = [];
    if (data) this.completed = this.onData(data);
  }
}
